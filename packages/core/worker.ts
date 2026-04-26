#!/usr/bin/env bun
/**
 * Choomfie Worker — disposable child process.
 *
 * Owns: Discord client, plugins, reminders, config, access control, all tool handlers.
 * Spawned by supervisor.ts via Bun.spawn({ ipc }).
 * Communicates with supervisor via IPC messages (see lib/ipc-types.ts).
 */

import { createContext } from "./lib/context.ts";
import { loadPlugins } from "./lib/plugins.ts";
import { createDiscordClient } from "./lib/discord.ts";
import { getAllTools } from "./lib/tools/index.ts";
import { buildInstructions } from "./lib/mcp-server.ts";
import { registerPermissionRelay } from "./lib/permissions.ts";
import { destroyAll as destroyTyping } from "./lib/typing.ts";
import { McpProxy } from "./lib/mcp-proxy.ts";
import type { SupervisorMessage, IpcToolDef } from "./lib/ipc-types.ts";
import type { ToolResult } from "./lib/types.ts";

// Initialize context (loads env, config, memory, access list)
const { ctx, discordToken } = await createContext();

// Load plugins
ctx.plugins = await loadPlugins(ctx.config);

// Create MCP proxy (forwards notifications to supervisor via IPC)
const mcpProxy = new McpProxy();
ctx.mcp = mcpProxy;

// Register permission relay (uses mcpProxy.setNotificationHandler)
registerPermissionRelay(ctx);

// Create Discord client
ctx.discord = createDiscordClient(ctx);

// Build tool list + instructions for supervisor
const allTools = getAllTools(ctx);
const toolMap = new Map(
  allTools.map((t) => [t.definition.name, t.handler])
);

const instructions = buildInstructions(ctx);

const toolDefs: IpcToolDef[] = allTools.map((t) => t.definition);

// Handle IPC messages from supervisor
process.on("message", async (msg: SupervisorMessage) => {
  if (msg.type === "tool_call") {
    // Start typing when Claude is about to respond to a channel
    if (msg.args?.chat_id && typeof msg.args.chat_id === "string") {
      try {
        const ch = await ctx.discord.channels.fetch(msg.args.chat_id);
        if (ch?.isTextBased() && "sendTyping" in ch) {
          ch.sendTyping().catch(() => {});
        }
      } catch { /* channel fetch failed, ignore */ }
    }

    const handler = toolMap.get(msg.name);
    let result: ToolResult;
    if (!handler) {
      result = {
        content: [{ type: "text", text: `Unknown tool: ${msg.name}` }],
        isError: true,
      };
    } else {
      try {
        result = await handler(msg.args, ctx);
      } catch (e: any) {
        result = {
          content: [{ type: "text", text: `Tool error: ${e.message}` }],
          isError: true,
        };
      }
    }
    try { process.send?.({ type: "tool_result", id: msg.id, result }); } catch {}
  } else if (msg.type === "restart_confirmation") {
    // Send confirmation to Discord after a worker-requested restart completed
    try {
      const ch = await ctx.discord.channels.fetch(msg.chat_id);
      if (ch?.isTextBased() && "send" in ch) {
        await (ch as any).send(`✓ Restarted (${msg.reason})`);
      }
    } catch {}
  } else if (msg.type === "permission_request") {
    await mcpProxy.handlePermissionRequest(msg);
  } else if (msg.type === "shutdown") {
    await shutdown();
  }
});

// Login to Discord and wait for full initialization (plugins, reminders, slash commands)
if (discordToken) {
  // Set up a promise that resolves when the ClientReady handler finishes all async init
  // (owner detection, plugin init, reminder scheduling, slash command deploy)
  const discordReady = Promise.race([
    new Promise<void>((resolve) => {
      (ctx as any)._discordReadyResolve = resolve;
    }),
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("Discord ready timeout (15s)")), 15_000)
    ),
  ]);
  try {
    await ctx.discord.login(discordToken);
    await discordReady;
  } catch (e) {
    // Don't crash — send ready anyway so non-Discord tools (memory, status) still work.
    // Discord tools will error individually when called.
    console.error(`Choomfie Worker: Discord init failed: ${e}`);
  }
} else {
  console.error(
    "Choomfie Worker: No DISCORD_TOKEN configured. Run /choomfie:configure <token> to set it up."
  );
}

// Signal ready to supervisor (after Discord + plugins are fully initialized)
process.send?.({
  type: "ready",
  tools: toolDefs,
  instructions,
});
console.error("Choomfie Worker: ready");

// Graceful shutdown
let shutdownCalled = false;
async function shutdown() {
  if (shutdownCalled) return;
  shutdownCalled = true;
  console.error("Choomfie Worker: shutting down");
  ctx.reminderScheduler.destroy();
  ctx.birthdayScheduler.destroy();
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
  ctx.memory.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGHUP", shutdown);
