#!/usr/bin/env bun
/**
 * Choomfie — Claude Code plugin for Discord.
 *
 * MCP channel server that bridges Discord to Claude Code
 * with persistent memory, reminders, threads, and extensible tools.
 *
 * This is the entry point — all logic lives in lib/.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createContext } from "./lib/context.ts";
import { loadPlugins } from "./lib/plugins.ts";
import { createMcpServer } from "./lib/mcp-server.ts";
import { createDiscordClient } from "./lib/discord.ts";
import { readFile, writeFile, unlink } from "node:fs/promises";

// Initialize context (loads env, config, memory, access list)
const { ctx, discordToken } = await createContext();

// Single-instance guard — kill stale processes before starting
const pidPath = `${ctx.DATA_DIR}/choomfie.pid`;
try {
  const oldPid = parseInt(await readFile(pidPath, "utf-8"), 10);
  if (oldPid && oldPid !== process.pid) {
    try {
      process.kill(oldPid, "SIGTERM");
      // Give it a moment to clean up
      await new Promise((r) => setTimeout(r, 500));
    } catch {
      // Process already dead, that's fine
    }
  }
} catch {
  // No PID file yet
}
await writeFile(pidPath, String(process.pid));

// Load plugins (before MCP server so tools + instructions are available)
ctx.plugins = await loadPlugins(ctx.config, import.meta.dir);

// Create MCP server (registers core + plugin tools, permission relay)
ctx.mcp = createMcpServer(ctx);

// Create Discord client (merges plugin intents, registers handlers)
ctx.discord = createDiscordClient(ctx);

// Exported for skills to use
export const pendingPairings = ctx.pendingPairings;
export const allowedUsers = ctx.allowedUsers;
export const ownerUserId = ctx.ownerUserId;
export const accessPath = ctx.accessPath;
export const DATA_DIR = ctx.DATA_DIR;

// Start
await ctx.mcp.connect(new StdioServerTransport());

if (discordToken) {
  await ctx.discord.login(discordToken);
} else {
  console.error(
    "Choomfie: No DISCORD_TOKEN configured. Run /choomfie:configure <token> to set it up."
  );
}

// Graceful shutdown
let shutdownCalled = false;
const shutdown = async () => {
  if (shutdownCalled) return;
  shutdownCalled = true;
  ctx.reminderScheduler.destroy();
  for (const plugin of ctx.plugins) {
    if (plugin.destroy) {
      try {
        await plugin.destroy();
      } catch {}
    }
  }
  // Destroy Discord client so the bot goes offline
  try {
    ctx.discord.destroy();
  } catch {}
  ctx.memory.close();
  // Remove PID file
  try {
    await unlink(`${ctx.DATA_DIR}/choomfie.pid`);
  } catch {}
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);

// Detect when stdin closes (MCP transport disconnected) — parent Claude session ended
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
