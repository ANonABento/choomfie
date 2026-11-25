/**
 * Free plugin — the `free` brain plus one brain per API provider that has a
 * key (`/brain groq`, `/brain gemini`, …), built on @choomfie/apibrain.
 *
 * Enable with `/plugins`, put keys in the data dir's `.env`
 * (`GROQ_API_KEY=…`, `GROQ_API_KEY_2=…` to pool a second), then `/brain free`
 * in a channel. No tools and no instructions: it costs the Claude session
 * nothing. Routing is config.json `free` (plugins/free/config.ts);
 * docs/free-brain.md has the whole picture.
 */

import { join } from "node:path";
import {
  ApiMember,
  Availability,
  CallLog,
  classifierPipeline,
  hardRules,
  Health,
  keywordClassifier,
  parseTarget,
  Quota,
  rankAcross,
  route,
  Transcript,
  zeroShotClassifier,
  defineApiBrain,
  type Classifier,
  type Target,
} from "@choomfie/apibrain";
import { getBrain, registerBrain, unregisterBrain, type Plugin, type PluginContext } from "@choomfie/shared";
import { createFreeBrain, FREE_BRAIN } from "./brain.ts";
import { parseFreeConfig, type FreeConfig } from "./config.ts";
import { PROVIDERS } from "./providers/index.ts";

export { PROVIDERS as providers } from "./providers/index.ts";
export { BUCKETS } from "./buckets.ts";
export { parseFreeConfig, type FreeConfig } from "./config.ts";
export { createFreeBrain, FREE_BRAIN } from "./brain.ts";

/** Model lists are refreshed this often (each member skips it if fresh). */
const CATALOG_REFRESH_MS = 6 * 3_600_000;

export interface FreeSetup {
  config: FreeConfig;
  members: Map<string, ApiMember>;
  unconfigured: { id: string; label: string; signup?: string }[];
  classifier: Classifier;
  /** What the zero-shot classifier would ask now: config's pins, else the smallest quick models listed. */
  classifierTargets(): Target[];
}

/** Members and classifier from config + env. Shared by the plugin and the doctor. */
export function setupFree(
  rawConfig: unknown,
  env: Record<string, string | undefined>,
  health: Health,
  quota: Quota,
  log?: CallLog,
  availability?: Availability
): FreeSetup {
  const config = parseFreeConfig(rawConfig);
  const members = new Map<string, ApiMember>();
  const unconfigured: FreeSetup["unconfigured"] = [];
  for (const spec of PROVIDERS) {
    const settings = config.providers[spec.id] ?? {};
    if (settings.enabled === false) continue;
    if (spec.optIn && settings.enabled !== true) continue; // a local server is opt-in
    const member = new ApiMember(spec, { env, health, quota, overrides: settings, log, availability });
    if (member.configured) members.set(spec.id, member);
    else unconfigured.push({ id: spec.id, label: spec.label, signup: spec.signup });
  }

  const ids = new Set(config.buckets.map((b) => b.id));
  const fallback = keywordClassifier(ids);
  const classifierTargets = (): Target[] =>
    config.classifier.targets
      ? config.classifier.targets.map(parseTarget).filter((t) => members.has(t.member))
      : rankAcross(members.values(), "tiny", 4);
  const primary =
    config.classifier.type === "zero-shot" && members.size
      ? zeroShotClassifier({
          buckets: config.buckets,
          ask: async (messages, signal) =>
            (
              await route(classifierTargets(), {
                signal,
                waitMs: (t) => members.get(t.member)!.waitMs(t.model),
                attempt: async (t) =>
                  (await members.get(t.member)!.complete(messages, { model: t.model, maxTokens: 300, temperature: 0, signal, timeoutMs: 2_500, briefThinking: true, purpose: "classify" })).text,
              })
            ).value,
        })
      : undefined;
  const classifier = classifierPipeline({ hard: hardRules(ids, { longTokens: config.classifier.longTokens }), primary, fallback });
  return { config, members, unconfigured, classifier, classifierTargets };
}

let registered: string[] = [];
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let quota: Quota | null = null;
let transcript: Transcript | null = null;
let availability: Availability | null = null;
let probing: AbortController | null = null;

const plugin: Plugin = {
  name: "free",

  async init(ctx: PluginContext) {
    const health = new Health();
    quota = new Quota(join(ctx.DATA_DIR, "meta", "apibrain-usage.json"));
    transcript = new Transcript(join(ctx.DATA_DIR, "apibrain", "transcripts.db"));
    const log = new CallLog(join(ctx.DATA_DIR, "apibrain", "calls.jsonl"));
    availability = new Availability(join(ctx.DATA_DIR, "meta", "apibrain-models.json"));
    const setup = setupFree(ctx.config.getConfig().free, process.env, health, quota, log, availability);
    // Keys benched before a restart (wants a card, rejected) stay out. The doctor doesn't do this: it re-checks them.
    for (const m of setup.members.values()) m.restoreBenches();

    for (const member of setup.members.values()) {
      // A web brain may already own the id (a future "gemini" site adapter): it keeps it.
      if (getBrain(member.id)) {
        console.error(`[free] a brain called "${member.id}" is already loaded — ${member.label} is still in the free router, but not its own /brain`);
        continue;
      }
      registerBrain(defineApiBrain(member, { transcript })(ctx));
      registered.push(member.id);
    }
    registerBrain(createFreeBrain({ ...setup, transcript, health, log }, ctx));
    registered.push(FREE_BRAIN);

    // Fresh model lists, then one tiny call to each new model, in the background, to learn which really answer.
    probing = new AbortController();
    const signal = probing.signal;
    const refresh = () =>
      Promise.all([...setup.members.values()].map((m) => m.refreshCatalog().then(() => m.probe({ signal })))).catch((e) =>
        console.error(`[free] model check: ${e instanceof Error ? e.message : e}`)
      );
    void refresh();
    refreshTimer = setInterval(() => void refresh(), CATALOG_REFRESH_MS);
    refreshTimer.unref?.();

    const names = [...setup.members.values()].map((m) => m.label).join(", ") || "none — add keys to .env";
    console.error(`Free brain initialized — providers: ${names}`);
  },

  async destroy() {
    for (const id of registered) unregisterBrain(id);
    registered = [];
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
    probing?.abort();
    probing = null;
    quota?.flush();
    quota = null;
    availability?.flush();
    availability = null;
    transcript?.close();
    transcript = null;
  },
};

export default plugin;

/** For `bun run apibrain doctor free`: how the classifier sorts a few sample messages. */
export async function doctorExtras(env: Record<string, string | undefined>, rawConfig: unknown, dataDir?: string): Promise<string[]> {
  const av = dataDir ? new Availability(join(dataDir, "meta", "apibrain-models.json")) : undefined;
  const { config, members, classifier, classifierTargets } = setupFree(rawConfig, env, new Health(), new Quota(), undefined, av);
  await Promise.all([...members.values()].map((m) => m.refreshCatalog()));
  const show = (ts: Target[]) => ts.map((t) => (t.model ? `${t.member}:${t.model}` : t.member)).join(", ") || "none";
  const lines = ["Routing (from the live model lists):"];
  for (const b of config.buckets) {
    const plan = b.targets ? b.targets.join(", ") : [...b.brains, show(rankAcross(members.values(), b.need, 4))].join(", ");
    lines.push(`  ${b.id.padEnd(9)} ${b.targets ? "pinned" : b.need.padEnd(6)}  ${plan}`);
  }
  const samples = [
    "hey, how's it going?",
    "why does my python script throw KeyError on line 12?",
    "add a dark mode toggle to the settings page in my repo and open a PR",
    "what were the biggest tech headlines today?",
    "compare event sourcing and CRUD for a small team, with trade-offs",
  ];
  lines.push(`Classifier (${config.classifier.type}, asks ${show(classifierTargets())}):`);
  for (const text of samples) {
    const started = Date.now();
    const c = await classifier.classify({ text, hasImages: false, tokens: text.length / 4, recent: [] });
    lines.push(`  ${c.bucket.padEnd(9)} ${c.by.padEnd(9)} ${c.confidence.toFixed(2)} ${((Date.now() - started) / 1000).toFixed(1)}s  “${text}”`);
  }
  return lines;
}
