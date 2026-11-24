#!/usr/bin/env bun
/**
 * API-brain checks for the owner, run on the machine hosting Choomfie.
 *
 *   bun run apibrain doctor <plugin> [provider]   check keys and models
 *   bun run apibrain log [count] [--full] [--chat <id>]   what was sent, and why
 *
 * doctor: for each provider the plugin exports (or just the one named):
 * which keys are set, how many chat models its `/models` lists today, a real
 * "pong" through each key on its best model, then one tiny request to each
 * listed model nobody has tried yet — so a model that's listed but not on
 * the free plan is found here, and remembered (`meta/apibrain-models.json`,
 * shared with the bot). Then the plugin's `doctorExtras` (the free plugin
 * shows its routing and classifies a few samples). Uses the data dir's `.env`
 * and config.json, like the worker. Sends real requests (a few tokens each).
 *
 * log: the last routing decisions and API calls from
 * `apibrain/calls.jsonl` — every message sent, model by model.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir } from "@choomfie/shared";
import { Availability } from "./availability.ts";
import type { LogEntry } from "./calllog.ts";
import { ProviderError } from "./errors.ts";
import { Health } from "./health.ts";
import { discoverKeys } from "./keys.ts";
import { ApiMember } from "./member.ts";
import type { ApiProviderSpec } from "./provider.ts";
import { Quota } from "./quota.ts";

const USAGE = "usage: bun run apibrain doctor <plugin> [provider]   (e.g. `doctor free groq`)\n       bun run apibrain log [count] [--full] [--chat <id>]";
const PONG = "Reply with exactly: pong";

type Env = Record<string, string | undefined>;
type DoctorModule = {
  providers?: ApiProviderSpec[];
  doctorExtras?(env: Env, rawConfig: Record<string, unknown>, dataDir: string): Promise<string[]>;
};

/** process.env plus the data dir's .env (the worker loads the same file). */
export function loadEnv(dataDir: string): Env {
  const env: Env = { ...process.env };
  const file = join(dataDir, ".env");
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.+)$/.exec(line);
    if (m && !env[m[1]]) env[m[1]] = m[2].trim();
  }
  return env;
}

function readConfig(dataDir: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
  } catch {
    return {};
  }
}

/** The env with only key `n` set for this provider, so each key is checked on its own. */
function onlyKey(env: Env, keyEnv: string, value: string): Env {
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => !new RegExp(`^${keyEnv}(_\\d+)?$`).test(k)));
  return { ...out, [keyEnv]: value };
}

/** Failures that say nothing about the key or model: the router just tries the next target. */
const TRANSIENT = new Set(["server", "timeout", "rate_limit", "network"]);

async function checkProvider(spec: ApiProviderSpec, env: Env, settings: Record<string, unknown> | undefined, availability: Availability): Promise<boolean> {
  const overrides = (settings ?? {}) as ConstructorParameters<typeof ApiMember>[1]["overrides"];
  const deps = { health: new Health(), quota: new Quota(), overrides, availability };
  const probe = new ApiMember(spec, { env, ...deps });
  if (!probe.configured) {
    console.error(`${spec.label}: ${spec.noKey ? "unreachable URL" : `no key — set ${spec.keyEnv} in .env${spec.signup ? ` (${spec.signup})` : ""}`}`);
    return true; // not a failure: just not set up
  }
  await probe.refreshCatalog(true);
  const keys = spec.noKey ? [{ n: 1, value: "" }] : discoverKeys(spec.id, spec.keyEnv!, env);
  console.error(
    `${spec.label}: ${spec.noKey ? "no key needed" : `${keys.length} key${keys.length === 1 ? "" : "s"}`} · ${probe.catalog.known ? `${probe.catalog.size} models listed, ${probe.catalog.candidates(spec).length} free chat models` : "no model list"}`
  );

  // Each key, on the provider's best model: is the key good?
  let ok = true;
  for (const key of keys) {
    const member = spec.noKey ? probe : new ApiMember(spec, { env: onlyKey(env, spec.keyEnv!, key.value), ...deps });
    if (member !== probe) member.catalog.set(probe.catalog.ids().map((id) => probe.catalog.info(id) ?? { id }));
    const model = member.models()[0];
    if (!model) {
      console.error(`  ❌ key ${key.n} · no usable models`);
      ok = false;
      continue;
    }
    const started = Date.now();
    try {
      const r = await member.complete([{ role: "user", content: PONG }], { model, maxTokens: 400, temperature: 0, timeoutMs: 60_000 });
      const pong = /\bpong\b/i.test(r.text);
      ok &&= pong;
      console.error(`  ${pong ? "✅" : "❌"} key ${key.n} · ${model} · ${((Date.now() - started) / 1000).toFixed(1)}s${pong ? "" : ` · said ${JSON.stringify(r.text.slice(0, 80))}`}`);
    } catch (e) {
      // Busy or rate-limited is the provider's moment, not your setup: warn, don't fail.
      const passing = e instanceof ProviderError && (TRANSIENT.has(e.kind) || e.kind === "not_free");
      ok &&= passing;
      const kind = e instanceof ProviderError ? `${e.kind}: ` : "";
      console.error(`  ${passing ? "⚠️" : "❌"} key ${key.n} · ${model} · ${kind}${(e instanceof Error ? e.message : String(e)).slice(0, 160)}${passing ? (e instanceof ProviderError && e.kind === "not_free" ? " (not on the free plan — skipped from now on)" : " (temporary — try again later)") : ""}`);
    }
  }

  // Every listed model nobody has tried: does it answer on this plan?
  let tried = 0;
  await probe.probe({
    onResult: (model, good, why) => {
      if (!tried++) console.error("  Trying models not seen before (once each, remembered):");
      console.error(`    ${good ? "✅" : TRANSIENT.has(why) ? "⚠️" : "🚫"} ${model}${good ? "" : ` — ${why === "not_free" ? "not on the free plan" : why}`}`);
    },
  });
  const best = (need: Parameters<ApiMember["ranked"]>[0]) => probe.ranked(need).slice(0, 2).map((m) => m.id).join(", ") || "—";
  console.error(`  Best now: strong ${best("strong")} · fast ${best("fast")} · tiny ${best("tiny")}${probe.ranked("vision").length ? ` · images ${best("vision")}` : ""}`);
  return ok;
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function contentText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (p?.type === "text" ? p.text : `[${p?.image_url?.url ?? "part"}]`)).join(" ");
  return String(c);
}

/** `apibrain log`: the latest routing decisions and calls, oldest first. */
export function showLog(dataDir: string, args: string[]): void {
  const full = args.includes("--full");
  const chatAt = args.indexOf("--chat");
  const chat = chatAt >= 0 ? args[chatAt + 1] : undefined;
  const count = Number(args.find((a) => /^\d+$/.test(a) && args[args.indexOf(a) - 1] !== "--chat")) || 10;
  const file = join(dataDir, "apibrain", "calls.jsonl");
  if (!existsSync(file)) return void console.error(`Nothing logged yet (${file}). The free plugin writes it once it answers a message.`);
  const entries = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as LogEntry];
      } catch {
        return [];
      }
    })
    .filter((e) => !chat || (e.type === "route" ? e.chat : e.chat)?.startsWith(chat));
  // The last `count` messages, with the calls that belong to them.
  const routes = entries.flatMap((e, i) => (e.type === "route" ? [i] : []));
  const from = routes.length > count ? routes[routes.length - count - 1] + 1 : 0;
  const time = (at: string) => new Date(at).toLocaleTimeString();
  const printCall = (e: Extract<LogEntry, { type: "call" }>) => {
    const mark = e.ok ? "✓" : "✗";
    const tokens = e.usage ? ` · ${e.usage.prompt}+${e.usage.completion} tok` : "";
    console.log(`   ${mark} ${e.purpose.padEnd(8)} ${e.provider}:${e.model} key ${e.key} · ${(e.ms / 1000).toFixed(1)}s${tokens}${e.error ? ` · ${clip(e.error, 120)}` : ""}`);
    if (full) {
      for (const m of e.messages) console.log(`       ${m.role.padEnd(9)} ${contentText(m.content).replace(/\n/g, "\n                 ")}`);
      if (e.reply) console.log(`       ${"→ reply".padEnd(9)} ${e.reply.replace(/\n/g, "\n                 ")}`);
    } else if (e.purpose === "answer") {
      const system = e.messages.filter((m) => m.role === "system").length;
      const last = e.messages[e.messages.length - 1];
      console.log(`       sent ${e.messages.length} messages (system ${system}, history ${e.messages.length - 1 - system}) · last: “${clip(contentText(last?.content), 90)}”`);
      if (e.reply) console.log(`       reply: “${clip(e.reply, 110)}”`);
    }
  };
  // A message's route line is written once it's answered, after its calls: show the message first.
  let pending: Extract<LogEntry, { type: "call" }>[] = [];
  for (const e of entries.slice(from)) {
    if (e.type === "call") {
      pending.push(e);
      continue;
    }
    const mine = pending.filter((c) => (c.chat === e.chat || (!c.chat && c.purpose === "classify")) && c.purpose !== "probe");
    const others = pending.filter((c) => !mine.includes(c));
    pending = [];
    for (const c of others) printCall(c);
    const how = `${e.by}${e.confidence !== undefined ? ` ${e.confidence.toFixed(2)}` : ""}${e.reason && e.reason !== e.by ? `, ${e.reason}` : ""}`;
    console.log(`\n${time(e.at)} [chat ${e.chat.slice(0, 8)}] “${clip(e.text, 80)}”`);
    console.log(`   → ${e.bucket} (${how}) · plan: ${e.plan.slice(0, 5).join(", ")}${e.plan.length > 5 ? ", …" : ""}`);
    for (const c of mine) printCall(c);
    for (const p of e.passed) console.log(`   ⤼ ${clip(p, 140)}`);
    console.log(e.answered ? `   ✓ answered by ${e.answered} in ${((e.ms ?? 0) / 1000).toFixed(1)}s` : `   ✗ ${e.error ?? "no answer"}`);
  }
  if (pending.length) console.log("");
  for (const c of pending) printCall(c);
  console.log(`\n${file}${full ? "" : " — add --full to see every message sent"}`);
}

if (import.meta.main) {
  const [command, plugin, only] = process.argv.slice(2);
  try {
    if (command === "log") {
      showLog(resolveDataDir(), process.argv.slice(3));
      process.exit(0);
    }
    if (command !== "doctor" || !plugin || !/^[a-z0-9-]+$/.test(plugin)) throw new Error(USAGE);
    let mod: DoctorModule;
    try {
      mod = await import(`@choomfie/${plugin}`);
    } catch (e) {
      throw new Error(`no plugin @choomfie/${plugin} (${e instanceof Error ? e.message : String(e)})`);
    }
    if (!mod.providers?.length) throw new Error(`@choomfie/${plugin} doesn't export \`providers\``);
    const dataDir = resolveDataDir();
    const env = loadEnv(dataDir);
    const config = readConfig(dataDir);
    const section = (config[plugin] ?? {}) as { providers?: Record<string, Record<string, unknown>> };
    const specs = only ? mod.providers.filter((p) => p.id === only) : mod.providers;
    if (!specs.length) throw new Error(`no provider "${only}" — have ${mod.providers.map((p) => p.id).join(", ")}`);
    const availability = new Availability(join(dataDir, "meta", "apibrain-models.json"));
    let ok = true;
    for (const spec of specs) {
      const settings = section.providers?.[spec.id];
      if (settings?.enabled === false || (spec.noKey && settings?.enabled !== true && !only)) {
        console.error(`${spec.label}: disabled in config`);
        continue;
      }
      ok = (await checkProvider(spec, env, settings, availability)) && ok;
    }
    availability.flush();
    if (!only && mod.doctorExtras) for (const line of await mod.doctorExtras(env, section, dataDir)) console.error(line);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
