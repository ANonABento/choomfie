#!/usr/bin/env bun
/**
 * Web-brain tools for the owner, run on the machine hosting Choomfie.
 *
 *   bun run webbrain login <id>    open the site in a visible browser on its own
 *                                  profile; sign in, then close the window
 *
 * <id> is a plugin that exports `adapter` (e.g. `waymond` → @choomfie/waymond).
 */

import { resolveDataDir } from "@choomfie/shared";
import type { SiteAdapter } from "./adapter.ts";
import { launchContext } from "./engine/launch.ts";
import { adoptLegacyDir, profileDir, profileInUse } from "./paths.ts";

const USAGE = "usage: bun run webbrain login <id>";

async function loadAdapter(id: string): Promise<SiteAdapter> {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`not a plugin id: ${id}`);
  let mod: { adapter?: SiteAdapter };
  try {
    mod = await import(`@choomfie/${id}`);
  } catch (e) {
    throw new Error(`no plugin @choomfie/${id} (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!mod.adapter?.turn) throw new Error(`@choomfie/${id} doesn't export a web-brain \`adapter\``);
  return mod.adapter;
}

async function login(adapter: SiteAdapter) {
  const dataDir = resolveDataDir();
  adoptLegacyDir(dataDir, adapter.id);
  const dir = profileDir(dataDir, adapter.id);
  if (profileInUse(dir)) {
    console.error(
      `${adapter.label}'s browser profile is open in another process (Choomfie's worker, mid-conversation?).\n` +
        "Wait for it to go idle (it closes after ~10 min), or stop Choomfie, then try again."
    );
    process.exit(1);
  }
  console.error(`Opening ${adapter.label} with profile ${dir}`);
  console.error(`Sign in, check that the chat loads, then close the window.`);
  const context = await launchContext(dir, { headless: false });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(adapter.loginUrl);
  await new Promise<void>((resolve) => context.on("close", () => resolve()));
  console.error(`Saved. Choomfie's ${adapter.label} brain will use this session.`);
}

const [command, id] = process.argv.slice(2);
if (!command || !id) {
  console.error(USAGE);
  process.exit(2);
}
try {
  const adapter = await loadAdapter(id);
  if (command === "login") await login(adapter);
  else {
    console.error(`unknown command: ${command}\n${USAGE}`);
    process.exit(2);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
