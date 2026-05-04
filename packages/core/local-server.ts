#!/usr/bin/env bun
/**
 * Choomfie Local — single-process Discord bot powered by Ollama only.
 *
 * Differences from supervisor mode:
 *   - No supervisor/worker split (no MCP, no Claude Code).
 *   - Ollama-only chat + coding models via LocalRuntime.
 *   - Background worker pulls bento-ya tasks while Discord is idle.
 *   - Voice plugin (whisper-cpp + kokoro) and other plugins still load
 *     normally; only the message-handling path is rerouted through Ollama.
 *
 * Entry: `bun packages/core/server.ts --local`
 *        or `bin/choomfie-local`
 *        or set CHOOMFIE_LOCAL=1
 */

import { writeFile, unlink, readFile, mkdir } from "node:fs/promises";
import { createContext } from "./lib/context.ts";
import { loadPlugins } from "./lib/plugins.ts";
import { createDiscordClient } from "./lib/discord.ts";
import { destroyAll as destroyTyping } from "./lib/typing.ts";
import { LocalRuntime } from "./lib/orchestrator/index.ts";
import { LocalMcpStub } from "./lib/orchestrator/mcp-stub.ts";

const DATA_DIR =
  process.env.CLAUDE_PLUGIN_DATA ||
  `${process.env.HOME}/.claude/plugins/data/choomfie-inline`;
const PID_PATH = `${DATA_DIR}/choomfie-local.pid`;

async function acquirePid() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    const old = parseInt((await readFile(PID_PATH, "utf-8")).trim(), 10);
    if (old && old !== process.pid) {
      try {
        process.kill(old, 0);
        // It's alive — refuse to start a second instance.
        console.error(
          `Choomfie Local: another instance is already running (PID ${old}). ` +
            `Stop it first or remove ${PID_PATH}.`,
        );
        process.exit(1);
      } catch {
        // Stale PID file
      }
    }
  } catch {
    // No PID file yet
  }
  await writeFile(PID_PATH, String(process.pid));
}

async function main() {
  await acquirePid();

  const { ctx, discordToken } = await createContext();

  // ConfigManager.getLocalConfig() already merges defaults; LocalConfig is
  // a superset of LocalRuntimeConfig (it adds `enabled`), so it's directly usable.
  const runtime = new LocalRuntime(ctx.config.getLocalConfig());
  try {
    await runtime.start();
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`Choomfie Local: ${reason}`);
    process.exit(1);
  }
  ctx.localRuntime = runtime;

  // Local mode has no MCP server. Provide a stub so existing tools that call
  // ctx.mcp.notification / requestRestart don't crash when invoked locally.
  ctx.mcp = new LocalMcpStub() as unknown as typeof ctx.mcp;

  // Load plugins — voice/browser/tutor/socials all still work.
  ctx.plugins = await loadPlugins(ctx.config);

  // Discord client — same one used by supervisor mode. Message handler in
  // discord.ts checks ctx.localRuntime and routes through Ollama.
  ctx.discord = createDiscordClient(ctx);

  if (!discordToken) {
    console.error(
      "Choomfie Local: DISCORD_TOKEN not set. Run /choomfie:configure or write to ~/.choomfie-data/.env first.",
    );
    process.exit(1);
  }

  await ctx.discord.login(discordToken);
  console.error("Choomfie Local: ready");

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error("Choomfie Local: shutting down");
    try {
      await runtime.stop();
    } catch {}
    try {
      ctx.reminderScheduler.destroy();
    } catch {}
    try {
      ctx.birthdayScheduler.destroy();
    } catch {}
    destroyTyping();
    for (const plugin of ctx.plugins) {
      if (plugin.destroy) {
        try {
          await plugin.destroy();
        } catch {}
      }
    }
    try {
      ctx.discord.destroy();
    } catch {}
    try {
      ctx.memory.close();
    } catch {}
    try {
      await unlink(PID_PATH);
    } catch {}
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);
}

await main();
