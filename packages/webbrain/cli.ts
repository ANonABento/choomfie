#!/usr/bin/env bun
/**
 * Web-brain tools for the owner, run on the machine hosting Choomfie.
 *
 *   bun run webbrain login <id>          open the site headed on its own profile;
 *                                        sign in, then close the window
 *   bun run webbrain record <id> <url>   capture one hand-sent message, for
 *                                        writing an adapter (docs/webbrain.md)
 *   bun run webbrain doctor <id>         send "pong" through the adapter and
 *                                        check the answer (sends a real message)
 *
 * <id> is a plugin that exports `adapter` (e.g. `waymond` → @choomfie/waymond).
 * `record` needs no adapter yet — it's how you write one.
 */

import { resolveDataDir } from "@choomfie/shared";
import type { SiteAdapter } from "./adapter.ts";
import { doctor, PONG_PROMPT } from "./doctor.ts";
import { launchContext } from "./engine/launch.ts";
import { profileDir, profileInUse } from "./paths.ts";
import { record } from "./record.ts";

const USAGE = [
  "usage:",
  "  bun run webbrain login <id>",
  "  bun run webbrain record <id> <url>",
  "  bun run webbrain doctor <id> [--headed]",
].join("\n");

const ID_RE = /^[a-z0-9-]+$/;

async function loadAdapter(id: string): Promise<SiteAdapter> {
  let mod: { adapter?: SiteAdapter };
  try {
    mod = await import(`@choomfie/${id}`);
  } catch (e) {
    throw new Error(`no plugin @choomfie/${id} (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!mod.adapter?.turn) throw new Error(`@choomfie/${id} doesn't export a web-brain \`adapter\``);
  return mod.adapter;
}

async function login(dataDir: string, adapter: SiteAdapter) {
  const dir = profileDir(dataDir, adapter.id);
  if (profileInUse(dir)) {
    throw new Error(
      `${adapter.label}'s browser profile is open in another process (Choomfie's worker, mid-conversation?).\n` +
        "Wait for it to go idle (it closes after ~10 min), or stop Choomfie, then try again."
    );
  }
  console.error(`Opening ${adapter.label} with profile ${dir}`);
  console.error("Sign in, check that the chat loads, then close the window.");
  const context = await launchContext(dir, { headless: false });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(adapter.loginUrl);
  await new Promise<void>((resolve) => context.on("close", () => resolve()));
  console.error(`Saved. Choomfie's ${adapter.label} brain will use this session.`);
}

const [command, id, ...rest] = process.argv.slice(2);
try {
  if (!command || !id) throw new Error(USAGE);
  if (!ID_RE.test(id)) throw new Error(`not a plugin id: ${id} (lowercase letters, digits, dashes)`);
  const dataDir = resolveDataDir();

  if (command === "login") {
    await login(dataDir, await loadAdapter(id));
  } else if (command === "record") {
    const url = rest[0];
    if (!url || !/^https:\/\//.test(url)) throw new Error(`record needs the site's https URL\n${USAGE}`);
    const dir = await record(dataDir, id, url);
    console.error(`Recorded to ${dir}`);
  } else if (command === "doctor") {
    const adapter = await loadAdapter(id);
    console.error(`${adapter.label}: sending "${PONG_PROMPT}" in a new chat…`);
    const report = await doctor(dataDir, adapter, { headless: !rest.includes("--headed") });
    if (report.ok) console.error(`✅ pong in ${(report.ms / 1000).toFixed(1)}s (conversation ${report.ref})`);
    else console.error(`❌ ${report.error ?? `answer didn't contain pong: ${JSON.stringify(report.text?.slice(0, 200))}`}`);
    process.exit(report.ok ? 0 : 1);
  } else {
    throw new Error(`unknown command: ${command}\n${USAGE}`);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
