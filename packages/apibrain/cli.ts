#!/usr/bin/env bun
/**
 * API-brain checks for the owner, run on the machine hosting Choomfie.
 *
 *   bun run apibrain doctor <plugin> [provider]
 *
 * For each provider the plugin exports (or just the one named): which keys
 * are set, which models its `/models` lists today, and a real
 * "Reply with exactly: pong" through each key and the first models — so a
 * bad key, a retired model or a spent quota shows up here, not in Discord.
 * Then whatever extra checks the plugin exports as `doctorExtras` (the free
 * plugin classifies a few sample messages). Uses the data dir's `.env` and
 * config.json, like the worker. Sends real requests (a few tokens each).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir } from "@choomfie/shared";
import { ProviderError } from "./errors.ts";
import { Health } from "./health.ts";
import { discoverKeys } from "./keys.ts";
import { ApiMember } from "./member.ts";
import type { ApiProviderSpec } from "./provider.ts";
import { Quota } from "./quota.ts";

const USAGE = "usage: bun run apibrain doctor <plugin> [provider]   (e.g. `doctor free groq`)";
const PONG = "Reply with exactly: pong";
/** Models tried per key. */
const MODELS_PER_KEY = 3;

type Env = Record<string, string | undefined>;
type DoctorModule = {
  providers?: ApiProviderSpec[];
  doctorExtras?(env: Env, rawConfig: Record<string, unknown>): Promise<string[]>;
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

async function checkProvider(spec: ApiProviderSpec, env: Env, settings: Record<string, unknown> | undefined): Promise<boolean> {
  const overrides = (settings ?? {}) as ConstructorParameters<typeof ApiMember>[1]["overrides"];
  const probe = new ApiMember(spec, { env, health: new Health(), quota: new Quota(), overrides });
  if (!probe.configured) {
    console.error(`${spec.label}: ${spec.noKey ? "unreachable URL" : `no key — set ${spec.keyEnv} in .env${spec.signup ? ` (${spec.signup})` : ""}`}`);
    return true; // not a failure: just not set up
  }
  await probe.refreshCatalog(true);
  const models = probe.models();
  console.error(
    `${spec.label}: ${spec.noKey ? "no key needed" : `${probe.keys.size} key${probe.keys.size === 1 ? "" : "s"}`} · ${probe.catalog.known ? `${probe.catalog.size} models listed` : "no model list"} · using ${models.slice(0, MODELS_PER_KEY).join(", ") || "nothing"}`
  );
  const keys = spec.noKey ? [{ n: 1, value: "" }] : discoverKeys(spec.id, spec.keyEnv!, env);
  let ok = true;
  for (const key of keys) {
    const member = spec.noKey ? probe : new ApiMember(spec, { env: onlyKey(env, spec.keyEnv!, key.value), health: new Health(), quota: new Quota(), overrides });
    if (member !== probe) member.catalog.set([...(probe.catalog.known ? models.map((id) => probe.catalog.info(id) ?? { id }) : [])]);
    for (const model of models.slice(0, MODELS_PER_KEY)) {
      const started = Date.now();
      try {
        const r = await member.complete([{ role: "user", content: PONG }], { model, maxTokens: 400, temperature: 0, timeoutMs: 60_000 });
        const pong = /\bpong\b/i.test(r.text);
        ok &&= pong;
        console.error(`  ${pong ? "✅" : "❌"} key ${key.n} · ${model} · ${((Date.now() - started) / 1000).toFixed(1)}s${pong ? "" : ` · said ${JSON.stringify(r.text.slice(0, 80))}`}`);
      } catch (e) {
        ok = false;
        const kind = e instanceof ProviderError ? `${e.kind}: ` : "";
        console.error(`  ❌ key ${key.n} · ${model} · ${kind}${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
      }
    }
  }
  return ok;
}

if (import.meta.main) {
  const [command, plugin, only] = process.argv.slice(2);
  try {
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
    let ok = true;
    for (const spec of specs) {
      const settings = section.providers?.[spec.id];
      if (settings?.enabled === false || (spec.noKey && settings?.enabled !== true && !only)) {
        console.error(`${spec.label}: disabled in config`);
        continue;
      }
      ok = (await checkProvider(spec, env, settings)) && ok;
    }
    if (!only && mod.doctorExtras) for (const line of await mod.doctorExtras(env, section)) console.error(line);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
