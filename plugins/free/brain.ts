/**
 * The `free` brain: one `/brain free` that answers each message with
 * whichever free model or web brain suits it.
 *
 * Routing policy ("API models float, stateful members lock"):
 *
 *   - API members share this chat's transcript, so moving between them loses
 *     nothing: every message is classified (hard rules → zero-shot →
 *     keywords) and the bucket's best healthy API model answers it.
 *   - A web brain (Waymond) holds work in its own conversation, so a chat
 *     only goes there on its first message, through a member mode
 *     (`/mode cad`), or when you accept "Hand this to Waymond". Once it has
 *     answered, the chat is on it (`chat.model`, shown by `/model`) until
 *     `/model auto`. If it fails, nothing moves silently: the reply offers
 *     Retry and "Answer with free models".
 *
 * `/model` pins a member or `member:model`; a pinned API model that can't
 * answer falls back to the other API models, and the reply says so.
 *
 * Modes are the web members' own work modes (`/mode cad` → Waymond in cad
 * mode), so plan boards work through free too. Buckets are internal.
 */

import {
  AllUnavailableError,
  apiTurn,
  maybeCompact,
  parseTarget,
  personaOf,
  recap,
  route,
  shortDuration,
  summarizer,
  systemPrompt,
  targetKey,
  userContent,
  isImage,
  estimateTokens,
  type ApiMember,
  type Classification,
  type Classifier,
  type Health,
  type Target,
  type Transcript,
} from "@choomfie/apibrain";
import {
  framePrompt,
  getBrain,
  type Brain,
  type BrainMessage,
  type BrainMode,
  type BrainModel,
  type BrainReply,
  type ChatRecord,
  type PluginContext,
} from "@choomfie/shared";
import type { FreeConfig } from "./config.ts";
import { PROVIDERS } from "./providers/index.ts";

export const FREE_BRAIN = "free";
/** Known API providers: one with no key is unavailable, not a brain to look for. */
const PROVIDER_IDS = new Set(PROVIDERS.map((p) => p.id));
/** `/model` value for "let the router choose" (stored as null). */
export const AUTO_MODEL = "auto";

/** Health unit for a brain member. */
const brainUnit = (id: string) => `brain:${id}`;
/** A web brain that wants a login sits out this long. */
const LOGIN_COOLDOWN_MS = 3_600_000;

export const RETRY_CHOICE = "Retry";
export const RELEASE_CHOICE = "Answer with free models";
export const handChoice = (label: string) => `Hand this to ${label}`;

export interface FreeBrainDeps {
  config: FreeConfig;
  members: Map<string, ApiMember>;
  /** Providers known but not usable (no key), for `/brain`. */
  unconfigured: { id: string; label: string; signup?: string }[];
  classifier: Classifier;
  transcript: Transcript;
  health: Health;
  /** Defaults to the shared brain registry. */
  lookupBrain?: (id: string) => Brain | undefined;
}

interface Route {
  member: string;
  model?: string;
  bucket: string;
  by: Classification["by"] | "mode" | "pin" | "you";
  latencyMs: number;
  at: number;
}

interface Answer {
  reply: BrainReply;
  record: string;
  model?: string;
}

/** What a quick-reply button this brain offered does when clicked. */
type OfferKind = { kind: "retry" } | { kind: "release" } | { kind: "hand"; to: string };

/** Buttons under the last reply, and the message they act on. */
interface Offer {
  message: BrainMessage;
  choices: Map<string, OfferKind>;
}

interface Decision {
  bucket: string;
  by: Route["by"];
  targets: Target[];
  /** A web member holds this chat: if it fails, say so instead of moving on. */
  locked: boolean;
  pinnedMode?: string;
  /** A pinned API target, to say when someone else answered. */
  pin?: Target;
  /** A web member this message looks like a job for (offered, not taken). */
  suggest?: string;
}

export function createFreeBrain(deps: FreeBrainDeps, ctx: PluginContext): Brain {
  const { config, members, transcript, health } = deps;
  const lookup = deps.lookupBrain ?? getBrain;
  const chats = ctx.chats;
  if (!chats) throw new Error("the free brain needs Choomfie's chat store (ctx.chats)");

  const lastRoute = new Map<string, Route>();
  const recent: (Route & { text: string })[] = [];
  const running = new Map<string, { abort: AbortController; member?: string }>();
  const offers = new Map<string, Offer>();
  const bucket = (id: string) => config.buckets.find((b) => b.id === id);
  const isApi = (t: Target) => members.has(t.member);

  /** Every target id that isn't an API provider: brains the router may hand to. */
  const brainMemberIds = (): string[] => {
    const all = [...config.priority, ...config.buckets.flatMap((b) => b.targets)].map((t) => parseTarget(t).member);
    return [...new Set(all)].filter((id) => !members.has(id) && id !== FREE_BRAIN && !config.providers[id] && !PROVIDER_IDS.has(id));
  };
  const isBrainMember = (id: string) => brainMemberIds().includes(id) && !!lookup(id);
  const brainMembers = (): Brain[] => brainMemberIds().flatMap((id) => (lookup(id) ? [lookup(id)!] : []));
  /** The web member this chat is on, if any. */
  const holderOf = (chat: ChatRecord): string | undefined => {
    const m = chat.model ? parseTarget(chat.model).member : undefined;
    return m && isBrainMember(m) ? m : undefined;
  };

  /** The web member that owns a mode. */
  const memberMode = (mode: string): { brain: Brain; mode: BrainMode } | undefined => {
    for (const b of brainMembers()) {
      const m = b.modes?.find((x) => x.id === mode);
      if (m) return { brain: b, mode: m };
    }
    return undefined;
  };

  const waitMs = (t: Target, tokens: number): number => {
    const api = members.get(t.member);
    if (api) return api.waitMs(t.model, tokens);
    if (config.providers[t.member] || PROVIDER_IDS.has(t.member)) return Infinity; // a provider with no key, or disabled
    return lookup(t.member) && t.member !== FREE_BRAIN ? health.waitMs(brainUnit(t.member)) : Infinity;
  };

  function targetsFor(bucketId: string): Target[] {
    if (config.strategy === "priority") return config.priority.map(parseTarget);
    return [...(bucket(bucketId)?.targets ?? []), ...config.priority].map(parseTarget);
  }

  async function decide(
    message: BrainMessage,
    chat: ChatRecord,
    framed: string,
    tokens: number,
    signal: AbortSignal,
    force?: OfferKind
  ): Promise<Decision> {
    if (force?.kind === "hand") return { bucket: "handoff", by: "you", targets: [{ member: force.to }], locked: true };
    const released = force?.kind === "release";
    const hasImages = message.filePaths.some(isImage);

    if (!released && chat.mode) {
      const owned = memberMode(chat.mode);
      if (owned) return { bucket: chat.mode, by: "mode", targets: [{ member: owned.brain.id }], locked: true, pinnedMode: chat.mode };
    }
    const holder = released ? undefined : holderOf(chat);
    if (holder) return { bucket: "pinned", by: "pin", targets: [{ member: holder }], locked: true };
    const pin = !released && chat.model ? parseTarget(chat.model) : undefined;
    if (pin && isApi(pin)) {
      const api = members.get(pin.member)!;
      // An image the pinned model can't see goes to a vision model for this one turn.
      if (!(hasImages && !api.vision(pin.model))) {
        return { bucket: "pinned", by: "pin", targets: [pin, ...config.priority.map(parseTarget).filter(isApi)], locked: false, pin };
      }
    }

    const first = !transcript.live(chat.id).length && !transcript.summary(chat.id);
    let chosen: string;
    let by: Route["by"];
    let confidence = 1;
    if (config.strategy === "priority") {
      chosen = "priority";
      by = "rule";
    } else {
      const decision = await deps.classifier.classify(
        { text: framed, hasImages, tokens, recent: transcript.live(chat.id).slice(-2).map((t) => ({ role: t.role, content: t.content })) },
        signal
      );
      chosen = decision.bucket;
      by = decision.by;
      confidence = decision.confidence;
    }
    const targets = targetsFor(chosen);
    // A first message may go anywhere: nothing is lost if a web brain takes it.
    if (first && !released) return { bucket: chosen, by, targets, locked: false };
    // Mid-chat, only API members answer; a web member the bucket names is offered instead.
    const own = (bucket(chosen)?.targets ?? []).map(parseTarget);
    const offer =
      released || confidence < config.classifier.suggestAt
        ? undefined
        : own.find((t) => !isApi(t) && isBrainMember(t.member) && waitMs(t, 0) === 0);
    return { bucket: chosen, by, targets: targets.filter(isApi), locked: false, ...(offer ? { suggest: offer.member } : {}) };
  }

  async function answerWithApi(member: ApiMember, t: Target, chatId: string, framed: string, filePaths: string[], signal: AbortSignal): Promise<Answer> {
    const current = userContent(framed, filePaths, member.vision(t.model));
    const budget = Math.min(member.contextTokens, config.contextTokens ?? Infinity);
    const r = await apiTurn({ member, model: t.model, transcript, chatId, system: systemPrompt(personaOf(ctx)), current, signal, budget });
    return { reply: { text: r.text || `(${member.label} sent an empty reply)` }, record: current.record, model: r.model };
  }

  async function answerWithBrain(brain: Brain, message: BrainMessage, chatId: string, framed: string, d: Decision): Promise<Answer> {
    // The member's own chat at this location: put it in the mode this message wants.
    const own = chats!.current(message.chatKey, brain.id, message.content);
    const want = d.pinnedMode ?? (brain.modes?.some((m) => m.id === d.bucket) ? d.bucket : own.mode);
    if (chats!.setMode && own.mode !== want) chats!.setMode(own.id, want);

    const since = transcript.lastAnsweredBy(chatId, brain.id);
    const summary = transcript.summary(chatId);
    const missed = transcript.live(chatId).filter((t) => t.id > since);
    const context = recap(summary && since < summary.uptoId ? summary : null, missed);
    try {
      const reply = await brain.send(context ? { ...message, content: `${context}\n\n${message.content}` } : message, ctx);
      health.ok(brainUnit(brain.id));
      return { reply, record: framed };
    } catch (e) {
      if ((e as { name?: string })?.name === "LoginRequiredError") health.cool(brainUnit(brain.id), LOGIN_COOLDOWN_MS, "needs a login");
      else health.fail(brainUnit(brain.id), e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  const summarize = async (text: string) =>
    (
      await route(config.summaryTargets.map(parseTarget), {
        waitMs: (t) => (members.has(t.member) ? members.get(t.member)!.waitMs(t.model) : Infinity),
        attempt: (t) => summarizer(members.get(t.member)!)(text),
      })
    ).value;
  const budget = () => config.contextTokens ?? 8_000;

  const label = (member: string) => members.get(member)?.label ?? lookup(member)?.label ?? member;

  function footer(r: Route): string {
    const model = r.model ? ` · ${r.model.replace(/^[^/]+\//, "")}` : "";
    return `\n-# via ${label(r.member)}${model} · ${r.bucket}`;
  }

  /** Attach this brain's own buttons to a reply, and remember what they do. */
  function withOffer(reply: BrainReply, message: BrainMessage, kinds: [string, OfferKind][]): BrainReply {
    if (!kinds.length) return reply;
    offers.set(message.chatKey, { message, choices: new Map(kinds) });
    return { ...reply, choices: [...(reply.choices ?? []), ...kinds.map(([text]) => text)] };
  }

  const brain: Brain = {
    id: FREE_BRAIN,
    label: "Free",

    // Read by core on each `/mode`: brain members can load after this one.
    get modes(): BrainMode[] {
      return brainMembers().flatMap((b) => (b.modes ?? []).map((m) => ({ ...m, description: `${b.label}: ${m.description}` })));
    },

    models(): BrainModel[] {
      const out: BrainModel[] = [{ id: AUTO_MODEL, description: "the router picks per message (default)" }];
      for (const b of brainMembers()) out.push({ id: b.id, description: `${b.label} — keeps the conversation until /model auto` });
      for (const m of members.values()) {
        out.push({ id: m.id, description: `${m.label}, its best free model` });
        for (const id of m.models()) out.push({ id: `${m.id}:${id}`, description: m.label });
      }
      return out;
    },

    async send(incoming): Promise<BrainReply> {
      const chat = chats.current(incoming.chatKey, FREE_BRAIN, incoming.content);
      // A click on one of our own buttons acts on the message it was offered for.
      const offer = offers.get(incoming.chatKey);
      offers.delete(incoming.chatKey);
      const force = offer && !incoming.filePaths.length ? offer.choices.get(incoming.content.trim()) : undefined;
      const message = force ? { ...offer!.message, meta: incoming.meta } : incoming;
      if (force?.kind === "release" && holderOf(chat)) {
        chats.setModel?.(chat.id, null);
        chat.model = null;
      }

      const framed = framePrompt(message.content, message.meta);
      const abort = new AbortController();
      const run: { abort: AbortController; member?: string } = { abort };
      running.set(message.chatKey, run);
      let d: Decision | undefined;
      try {
        const tokens = estimateTokens(framed);
        const decision = await decide(message, chat, framed, tokens, abort.signal, force);
        d = decision;
        const routed = await route(decision.targets, {
          signal: abort.signal,
          waitMs: (t) => waitMs(t, tokens),
          attempt: (t) => {
            run.member = t.member;
            const api = members.get(t.member);
            if (api) return answerWithApi(api, t, chat.id, framed, message.filePaths, abort.signal);
            return answerWithBrain(lookup(t.member)!, message, chat.id, framed, decision);
          },
        });
        const { reply, record, model } = routed.value;
        const member = routed.target.member;
        const r: Route = { member, model, bucket: decision.bucket, by: decision.by, latencyMs: routed.latencyMs, at: Date.now() };
        transcript.add(chat.id, "user", record);
        if (reply.text) transcript.add(chat.id, "assistant", reply.text, member, model);
        // A web member that answered now holds the chat (until `/model auto`).
        if (!members.has(member) && chat.model !== member) chats.setModel?.(chat.id, member);
        lastRoute.set(message.chatKey, r);
        recent.unshift({ ...r, text: message.content.slice(0, 40) });
        recent.length = Math.min(recent.length, 5);
        if (routed.passed.length) console.error(`[free] ${targetKey(routed.target)} answered after: ${routed.passed.join("; ")}`);
        void maybeCompact({ transcript, chatId: chat.id, budget: budget(), summarize });

        let text = reply.text;
        if (decision.pin && member !== decision.pin.member && !reply.stopped) text += `\n-# ${label(decision.pin.member)} couldn't answer — ${label(member)} did.`;
        else if (config.footer && !reply.stopped) text += footer(r);
        const suggested: [string, OfferKind][] =
          decision.suggest && !reply.stopped ? [[handChoice(label(decision.suggest)), { kind: "hand", to: decision.suggest }]] : [];
        return withOffer({ ...reply, text }, message, suggested);
      } catch (e) {
        if (abort.signal.aborted) return { text: "⏹️ Stopped.", stopped: true };
        if (!(e instanceof AllUnavailableError)) throw e;
        console.error(`[free] nothing answered: ${e.attempts.join("; ")}`);
        if (d?.locked) {
          // A web member holds this chat: don't move it behind your back.
          const who = label(d.targets[0].member);
          const why = e.attempts[0]?.replace(/^[^:]+:\s*/, "") ?? "unavailable";
          return withOffer({ text: `⚠️ ${who} couldn't answer: ${why.slice(0, 200)}` }, message, [
            [RETRY_CHOICE, { kind: "retry" }],
            [RELEASE_CHOICE, { kind: "release" }],
          ]);
        }
        const when = e.retryInMs ? ` Try again in ~${shortDuration(e.retryInMs)},` : " Try again later,";
        return { text: `All free providers are limited or unavailable right now.${when} or switch with \`/brain claude\`.` };
      } finally {
        if (running.get(message.chatKey) === run) running.delete(message.chatKey);
      }
    },

    async stop(chatKey) {
      const run = running.get(chatKey);
      if (!run) return false;
      const member = run.member && !members.has(run.member) ? lookup(run.member) : undefined;
      if (member?.stop) {
        // A web brain stops on its own side and returns what it has.
        return member.stop(chatKey);
      }
      run.abort.abort();
      return true;
    },

    async resolveApproval(chatKey, approvalId, approve) {
      const last = lastRoute.get(chatKey)?.member;
      const candidates = [...(last ? [lookup(last)] : []), ...brainMembers()].filter(
        (b): b is Brain => !!b?.resolveApproval && !!chats.bound(chatKey, b.id)
      );
      if (!candidates.length) throw new Error("no brain here has an approval waiting");
      return candidates[0].resolveApproval!(chatKey, approvalId, approve);
    },

    // Core has already started a fresh free chat here; start fresh member chats too.
    async reset(chatKey) {
      running.get(chatKey)?.abort.abort();
      lastRoute.delete(chatKey);
      offers.delete(chatKey);
      for (const b of brainMembers()) {
        if (!chats.bound(chatKey, b.id)) continue;
        chats.start(chatKey, b.id);
        await b.reset?.(chatKey);
      }
    },

    async compact(chatKey) {
      const chat = chats.bound(chatKey, FREE_BRAIN);
      if (!chat) return "Nothing to compact here yet.";
      const done = await maybeCompact({ transcript, chatId: chat.id, budget: budget(), summarize, force: true });
      const holder = holderOf(chat);
      const note = holder ? ` ${label(holder)} keeps its own context on its side.` : "";
      return (done ? "Summarized the older half of this chat; the rest stays word for word." : "Too short to compact yet.") + note;
    },

    async status() {
      const lines = [
        `**Free brain** — ${config.strategy === "smart" ? `smart routing, ${config.classifier.type} classifier` : "priority order"}${config.footer ? " · route footer on" : ""}`,
        ...[...members.values()].map((m) => m.statusLine()),
        ...brainMemberIds().map((id) => {
          const b = lookup(id);
          if (!b) return `• **${id}** — not loaded (\`/plugins\`)`;
          const wait = health.waitMs(brainUnit(id));
          return `• **${b.label}** — ${wait ? `cooling ${shortDuration(wait)} (${health.get(brainUnit(id)).reason ?? "failing"})` : "ready"}`;
        }),
      ];
      if (deps.unconfigured.length) lines.push(`-# No key: ${deps.unconfigured.map((p) => p.label).join(", ")} — add one to the data dir's \`.env\` (docs/free-brain.md).`);
      if (recent.length) {
        lines.push(`-# Recent: ${recent.slice(0, 3).map((r) => `${r.bucket} → ${label(r.member)} (${(r.latencyMs / 1000).toFixed(1)}s, ${r.by})`).join(" · ")}`);
      }
      return lines;
    },
  };
  return brain;
}
