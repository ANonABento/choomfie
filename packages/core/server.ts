#!/usr/bin/env bun
/**
 * Choomfie — Claude Code plugin for Discord.
 *
 * Two run modes:
 *   default      → supervisor.ts (MCP stdio server, supervised worker)
 *   --local      → local-server.ts (standalone Discord bot powered by Ollama)
 *
 * The --local flag is also implied by config.local.enabled=true and the
 * CHOOMFIE_LOCAL=1 env var, so launchd plists / wrapper scripts can opt in
 * without changing argv.
 */

const argv = process.argv.slice(2);
const wantsLocal =
  argv.includes("--local") ||
  argv.includes("-l") ||
  process.env.CHOOMFIE_LOCAL === "1";

if (wantsLocal) {
  await import("./local-server.ts");
} else {
  await import("./supervisor.ts");
}

export {};
