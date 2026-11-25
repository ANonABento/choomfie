#!/usr/bin/env bun
/**
 * Web-brain tools for the owner, run on the machine hosting Choomfie.
 *
 *   bun run webbrain sites               every web brain, logged in or not
 *   bun run webbrain setup               open the login window for each one that isn't
 *   bun run webbrain login <id>          open the site headed on its own profile;
 *                                        sign in, then close the window
 *   bun run webbrain record <id> <url>   capture one hand-sent message, for
 *                                        writing an adapter (docs/webbrain.md)
 *   bun run webbrain doctor <id>         send "pong" through the adapter and
 *                                        check the answer (sends a real message)
 *   bun run webbrain doctor <id> --detect [--engine patchright|cloak|all]
 *                                        how botty the engine looks (throwaway
 *                                        profile, bot.sannysoft.com + own probes)
 *
 * <id> is a plugin that exports `adapter` (e.g. `waymond` → @choomfie/waymond).
 * `record` needs no adapter yet — it's how you write one.
 */

import { join } from "node:path";
import { resolveDataDir } from "@choomfie/shared";
import type { SiteAdapter } from "./adapter.ts";
import { doctor, PONG_PROMPT, TOOLS_PROMPT } from "./doctor.ts";
import { ENGINES, engineFor, isEngine, launchContext, type EngineName } from "./engine/launch.ts";
import { detect, formatReport } from "./detect.ts";
import { profileDir, profileInUse } from "./paths.ts";
import { record } from "./record.ts";
import { discoverAdapters, formatStatus, needsLogin, siteStatus } from "./sites.ts";

const USAGE = [
  "usage:",
  "  bun run webbrain sites",
  "  bun run webbrain setup",
  "  bun run webbrain login <id>",
  "  bun run webbrain record <id> <url>",
  "  bun run webbrain doctor <id> [--headed]",
  "  bun run webbrain doctor <id> --tools [--headed]   (does it ask for ```run commands? nothing is run)",
  "  bun run webbrain doctor <id> --detect [--engine patchright|cloak|all] [--headed]",
].join("\n");

const ID_RE = /^[a-z0-9-]+$/;

/** The site with this id: a plugin of its own (`@choomfie/<id>`), or one of the `webbrains` plugin's sites. */
async function loadAdapter(id: string): Promise<SiteAdapter> {
  const found = (await discoverAdapters(PLUGINS_DIR)).find((a) => a.id === id);
  if (!found) throw new Error(`no web brain called ${id} (\`bun run webbrain sites\` lists them)`);
  return found;
}

async function login(dataDir: string, adapter: SiteAdapter) {
  const engine = engineFor(dataDir, adapter);
  const dir = profileDir(dataDir, adapter.id, engine);
  if (profileInUse(dir)) {
    throw new Error(
      `${adapter.label}'s browser profile is open in another process (Choomfie's worker, mid-conversation?).\n` +
        "Wait for it to go idle (it closes after ~10 min), or stop Choomfie, then try again."
    );
  }
  console.error(`Opening ${adapter.label} (${engine}) with profile ${dir}`);
  console.error("Sign in, check that the chat loads, then close the window.");
  const context = await launchContext(dir, { headless: false, engine });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(adapter.loginUrl);
  await new Promise<void>((resolve) => context.on("close", () => resolve()));
  console.error(`Saved. Choomfie's ${adapter.label} brain will use this session.`);
}

/** One visible line from the terminal (enter alone = empty). */
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

const PLUGINS_DIR = join(import.meta.dir, "..", "..", "plugins");

/** `sites`: each web brain's login state. `setup`: then log in to each one that needs it. */
async function sites(dataDir: string, setup: boolean): Promise<number> {
  const adapters = await discoverAdapters(PLUGINS_DIR);
  if (!adapters.length) {
    console.error("No web brains: no plugin exports an `adapter`. Add one with the new-web-brain skill (docs/webbrain.md).");
    return 0;
  }
  console.error("Checking each site's profile (opens it headless, sends nothing)…");
  const statuses = [];
  for (const adapter of adapters) {
    const s = await siteStatus(dataDir, adapter);
    statuses.push(s);
    console.error(formatStatus(s));
  }
  const todo = adapters.filter((a, i) => needsLogin(statuses[i]));
  if (!setup) {
    console.error(
      todo.length
        ? "\nLog in: bun run webbrain setup (all of them) or bun run webbrain login <id>."
        : "\nEvery site is logged in (or in use). Check one end to end: bun run webbrain doctor <id>."
    );
    return 0;
  }
  if (!todo.length) {
    console.error("\nNothing to log in to.");
    return 0;
  }
  for (const adapter of todo) {
    const answer = await promptLine(`\n${adapter.label}: open its login window? [Y/n] `);
    if (/^n/i.test(answer)) continue;
    await login(dataDir, adapter);
    console.error(formatStatus(await siteStatus(dataDir, adapter)));
  }
  console.error("\nThe bot picks up a new login on its next message to that site. Check one end to end: bun run webbrain doctor <id>.");
  return 0;
}

const [command, id, ...rest] = process.argv.slice(2);
try {
  if (command === "sites" || command === "setup") process.exit(await sites(resolveDataDir(), command === "setup"));
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
  } else if (command === "doctor" && rest.includes("--detect")) {
    const wanted = rest[rest.indexOf("--engine") + 1];
    const adapter = await loadAdapter(id).catch(() => ({ id }));
    const engines: EngineName[] =
      rest.includes("--engine") ? (wanted === "all" ? [...ENGINES] : isEngine(wanted) ? [wanted] : []) : [engineFor(dataDir, adapter)];
    if (!engines.length) throw new Error(`--engine must be one of ${ENGINES.join(", ")}, all`);
    let bad = 0;
    for (const engine of engines) {
      try {
        const report = await detect(engine, { headless: !rest.includes("--headed") });
        console.error(formatReport(report));
        bad += report.rows.filter((r) => !r.ok).length + (report.sannysoftFailed?.length ?? 0);
      } catch (e) {
        console.error(`${engine}: couldn't launch — ${e instanceof Error ? e.message : String(e)}`);
        bad++;
      }
    }
    process.exit(bad ? 1 : 0);
  } else if (command === "doctor" && rest.includes("--tools")) {
    const adapter = await loadAdapter(id);
    if (!adapter.localTools) throw new Error(`${adapter.label} doesn't have local tools on (adapter \`localTools\`).`);
    console.error(`${adapter.label}: asking "${TOOLS_PROMPT}" with the local-tools guide, in a new chat (nothing is run)…`);
    const report = await doctor(dataDir, adapter, { headless: !rest.includes("--headed"), tools: true });
    if (report.ok) console.error(`✅ asked to run: ${report.calls!.map((c) => JSON.stringify(c)).join(", ")} (${(report.ms / 1000).toFixed(1)}s, conversation ${report.ref})`);
    else console.error(`❌ ${report.error ?? `no \`\`\`run block found in: ${JSON.stringify(report.text?.slice(0, 400))}`}`);
    process.exit(report.ok ? 0 : 1);
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
