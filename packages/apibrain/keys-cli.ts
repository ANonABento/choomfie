/**
 * `bun run apibrain keys` — the owner's setup for API keys, run on the
 * machine hosting Choomfie. Keys go to the data dir's `.env` (0600), never
 * config.json, and are never printed.
 *
 *   keys                 every provider: key set or not, what its free tier gives, where to get a key
 *   keys add <provider>  open its key page, paste the key (hidden), check it, save it
 *                        (a second `add` saves `<KEY>_2`: pooled, each its own quota)
 *   keys setup           walk through every provider that has no key yet
 *
 * A key is checked before it's saved (its model list, or a one-word reply).
 * The bot reads `.env` at startup: `/restart` after adding keys.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeSecretFileSync } from "@choomfie/shared";
import { chatCompletion, listModels } from "./client.ts";
import { ProviderError } from "./errors.ts";
import { discoverKeys } from "./keys.ts";
import { resolveBaseURL, type ApiProviderSpec } from "./provider.ts";

type Env = Record<string, string | undefined>;

/** One line per provider for the overview. */
export function keyStatus(spec: ApiProviderSpec, env: Env, disabled: boolean): string {
  const n = spec.noKey ? 0 : discoverKeys(spec.id, spec.keyEnv!, env).length;
  const mark = disabled ? "⏸️ " : spec.optIn ? "💤" : spec.noKey ? "🔓" : n ? "✅" : "⬜";
  const state = disabled
    ? "off in config"
    : spec.optIn
      ? "opt-in (config)"
      : spec.noKey
        ? "no key needed"
        : n
          ? `${n} key${n === 1 ? "" : "s"}`
          : `no key · ${spec.signup ?? spec.keyEnv}`;
  return `${mark} ${spec.id.padEnd(11)} ${state}${spec.note ? `\n      ${spec.note}` : ""}`;
}

/** Read a line without echoing it (a pasted key stays off the screen and out of scrollback). */
export function readHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    if (!stdin.isTTY) {
      // Piped: read one line as is.
      let buf = "";
      const onData = (d: Buffer) => {
        buf += d.toString();
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          stdin.off("data", onData);
          stdin.pause();
          resolve(buf.slice(0, nl).trim());
        }
      };
      stdin.on("data", onData);
      stdin.resume();
      return;
    }
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(value.trim());
    };
    const onData = (d: Buffer) => {
      for (const ch of d.toString()) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
      process.stderr.write(`\r${question}${"•".repeat(Math.min(value.length, 40))} `);
    };
    stdin.on("data", onData);
  });
}

/** A visible one-line answer. */
function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(question);
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        process.stdin.off("data", onData);
        process.stdin.pause();
        resolve(buf.slice(0, nl).trim());
      }
    };
    process.stdin.on("data", onData);
    process.stdin.resume();
  });
}

/** Does this key work? Lists models (cheap, no tokens); a provider that can't list gets a one-word reply. */
export async function checkKey(spec: ApiProviderSpec, env: Env, key: string): Promise<{ ok: boolean; detail: string }> {
  const baseURL = resolveBaseURL(spec, env);
  if (!baseURL) return { ok: false, detail: `missing ${Object.values(spec.vars ?? {}).join(", ")}` };
  try {
    if (spec.listsModels !== false) {
      const models = await listModels(baseURL, key, spec.headers, fetch, 20_000, spec.modelsURL);
      return { ok: true, detail: `${models.length} models listed` };
    }
    const model = spec.fallbackModels?.[0];
    if (!model) return { ok: true, detail: "not checked (no model to try)" };
    await chatCompletion({ baseURL, apiKey: key, headers: spec.headers, model, messages: [{ role: "user", content: "Reply with the word: ok" }], maxTokens: 20, timeoutMs: 30_000 });
    return { ok: true, detail: `${model} answered` };
  } catch (e) {
    const kind = e instanceof ProviderError ? e.kind : "error";
    // A busy provider says nothing about the key.
    if (kind === "server" || kind === "timeout" || kind === "rate_limit" || kind === "network") return { ok: true, detail: `couldn't check right now (${kind}) — saved anyway` };
    return { ok: false, detail: `${kind}: ${(e instanceof Error ? e.message : String(e)).slice(0, 140)}` };
  }
}

/** The `.env` with `name=value` set (replacing that line, or appended). */
export function setEnvLine(text: string, name: string, value: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (at >= 0) lines[at] = `${name}=${value}`;
  else {
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push(`${name}=${value}`, "");
  }
  return lines.join("\n");
}

/** The next free slot: `GROQ_API_KEY`, then `GROQ_API_KEY_2`, … */
export function nextKeyName(keyEnv: string, env: Env): string {
  if (!env[keyEnv]?.trim()) return keyEnv;
  for (let i = 2; ; i++) if (!env[`${keyEnv}_${i}`]?.trim()) return `${keyEnv}_${i}`;
}

function openURL(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // No browser here: the URL is printed anyway.
  }
}

/** Add one key: open the page, read it hidden, check it, save it. Returns true when saved. */
export async function addKey(spec: ApiProviderSpec, env: Env, dataDir: string, opts: { open?: boolean } = {}): Promise<boolean> {
  if (spec.noKey) {
    console.error(`${spec.label} needs no key.${spec.optIn ? ` Turn it on with "free": { "providers": { "${spec.id}": { "enabled": true } } } in config.json.` : ""}`);
    return false;
  }
  const file = join(dataDir, ".env");
  let text = existsSync(file) ? readFileSync(file, "utf8") : "";
  console.error(`\n${spec.label}${spec.note ? ` — ${spec.note}` : ""}`);
  if (spec.signup) {
    console.error(`  Get a key: ${spec.signup}`);
    if (opts.open !== false) openURL(spec.signup);
  }
  // Other values the base URL needs (Cloudflare's account id): not secret, asked in the open.
  for (const envVar of Object.values(spec.vars ?? {})) {
    if (env[envVar]) continue;
    const value = await promptLine(`  ${envVar}: `);
    if (!value) return false;
    env[envVar] = value;
    text = setEnvLine(text, envVar, value);
  }
  const key = await readHidden("  Paste the key (hidden, enter to skip): ");
  if (!key) return false;
  if (discoverKeys(spec.id, spec.keyEnv!, env).some((k) => k.value === key)) {
    console.error("  That key is already saved.");
    return false;
  }
  const check = await checkKey(spec, env, key);
  console.error(`  ${check.ok ? "✅" : "❌"} ${check.detail}`);
  if (!check.ok) return false;
  const name = nextKeyName(spec.keyEnv!, env);
  env[name] = key;
  writeSecretFileSync(file, setEnvLine(text, name, key));
  console.error(`  Saved as ${name} in ${file}`);
  return true;
}

export async function keysCommand(args: string[], specs: ApiProviderSpec[], env: Env, dataDir: string, disabled: (spec: ApiProviderSpec) => boolean): Promise<number> {
  const [sub, id] = args;
  const noOpen = args.includes("--no-open");
  if (!sub || sub === "list") {
    for (const spec of specs) console.error(keyStatus(spec, env, disabled(spec)));
    console.error(`\nAdd one: bun run apibrain keys add <provider> · all missing: bun run apibrain keys setup\nKeys live in ${join(dataDir, ".env")}; /restart the bot after adding.`);
    return 0;
  }
  if (sub === "add") {
    const spec = specs.find((s) => s.id === id);
    if (!spec) throw new Error(`no provider "${id ?? ""}" — have ${specs.map((s) => s.id).join(", ")}`);
    const saved = await addKey(spec, env, dataDir, { open: !noOpen });
    if (saved) console.error(`\nNext: bun run apibrain doctor free ${spec.id}, then /restart the bot.`);
    return saved ? 0 : 1;
  }
  if (sub === "setup") {
    const missing = specs.filter((s) => !s.noKey && !disabled(s) && !discoverKeys(s.id, s.keyEnv!, env).length);
    if (!missing.length) {
      console.error("Every provider has a key.");
      return 0;
    }
    console.error(`${missing.length} providers without a key. For each: its key page opens; paste the key, or press enter to skip.`);
    let saved = 0;
    for (const spec of missing) if (await addKey(spec, env, dataDir, { open: !noOpen })) saved++;
    console.error(`\n${saved} key${saved === 1 ? "" : "s"} saved. Next: bun run apibrain doctor free, then /restart the bot.`);
    return 0;
  }
  throw new Error("usage: bun run apibrain keys [list | add <provider> | setup] [--no-open]");
}
