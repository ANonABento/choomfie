/**
 * System tools — restart, diagnostics, etc. Owner-only.
 */

import type { ToolDef } from "../types.ts";
import { text } from "../types.ts";
import { loadPlugins } from "../plugins.ts";
import { createDiscordClient } from "../discord.ts";
import { ConfigManager } from "../config.ts";
import { ReminderScheduler } from "../reminders.ts";
import { destroyAll as destroyTyping } from "../typing.ts";

export const systemTools: ToolDef[] = [
  {
    definition: {
      name: "restart",
      description:
        "Soft-restart the Choomfie server. Tears down Discord + plugins + reminders, reloads config, and reconnects. MCP stays alive. Owner only.",
      inputSchema: {
        type: "object" as const,
        properties: {
          reason: {
            type: "string",
            description: "Optional reason for restart (logged to stderr)",
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const reason = (args.reason as string) || "manual restart";
      console.error(`Choomfie: soft-restarting — ${reason}`);

      // 1. Tear down plugins
      for (const plugin of ctx.plugins) {
        if (plugin.destroy) {
          try {
            await plugin.destroy();
          } catch {}
        }
      }

      // 2. Tear down reminders + typing
      ctx.reminderScheduler.destroy();
      destroyTyping();

      // 3. Disconnect Discord
      const token = ctx.discord.token;
      try {
        ctx.discord.destroy();
      } catch {}

      // 4. Reset runtime state
      ctx.activeChannels.clear();
      ctx.lastMessageTime.clear();
      ctx.messageStats.received = 0;
      ctx.messageStats.sent = 0;
      ctx.messageStats.byUser.clear();
      ctx.startedAt = null;

      // 5. Reload config
      ctx.config = new ConfigManager(ctx.DATA_DIR);

      // 6. Reload plugins
      const projectRoot = import.meta.dir.replace(/\/lib\/tools$/, "");
      ctx.plugins = await loadPlugins(ctx.config, projectRoot);

      // 7. Create new reminder scheduler
      ctx.reminderScheduler = new ReminderScheduler();

      // 8. Create new Discord client + reconnect
      ctx.discord = createDiscordClient(ctx);
      if (token) {
        await ctx.discord.login(token);
      }

      console.error(`Choomfie: soft-restart complete — ${reason}`);
      return text(`Restarted successfully. (${reason})`);
    },
  },
];
