/**
 * Status tool — full Choomfie config/status overview.
 */

import type { ToolDef } from "../types.ts";
import { text } from "../types.ts";
import { formatUptime } from "../conversation.ts";

export const statusTools: ToolDef[] = [
  {
    definition: {
      name: "choomfie_status",
      description:
        "Show Choomfie's current config: personality, memory stats, active reminders, features, and what can be changed. Use when the user asks about settings, config, or status.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    handler: async (_args, ctx) => {
      const stats = ctx.memory.getStats();
      const core = ctx.memory.getCoreMemory();
      const reminders = ctx.memory.getActiveReminders();
      const persona = ctx.config.getActivePersona();
      const personaKey = ctx.config.getActivePersonaKey();
      const allPersonas = ctx.config.listPersonas();
      const botUser = ctx.discord.user;
      const convoTimeout = ctx.config.getConvoTimeoutMs();

      // Uptime
      const uptimeStr = ctx.startedAt
        ? formatUptime(Date.now() - ctx.startedAt)
        : "not started";
      const startedAtStr = ctx.startedAt
        ? new Date(ctx.startedAt).toISOString()
        : "n/a";

      // Active channels
      const now = Date.now();
      const activeChans: string[] = [];
      for (const [id, ts] of ctx.activeChannels) {
        if (now - ts <= convoTimeout) {
          activeChans.push(
            `<#${id}> (active ${formatUptime(now - ts)} ago)`
          );
        }
      }

      // Top users by message count
      const topUsers = [...ctx.messageStats.byUser.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([uid, count]) => `<@${uid}>: ${count}`)
        .join(", ");

      const lines = [
        "# Choomfie Status",
        "",
        "## Bot",
        `  Name: ${botUser?.username || "unknown"}#${botUser?.discriminator || "0"}`,
        `  Version: 0.4.0`,
        `  Runtime: Bun ${Bun.version}`,
        `  Uptime: ${uptimeStr} (since ${startedAtStr})`,
        `  Server: Claude Code Plugin (MCP)`,
        `  Data dir: ${ctx.DATA_DIR}`,
        "",
        "## Message Stats",
        `  Received: ${ctx.messageStats.received}`,
        `  Sent: ${ctx.messageStats.sent}`,
        topUsers ? `  Top users: ${topUsers}` : null,
        "",
        "## Active Channels",
        activeChans.length > 0
          ? activeChans.map((c) => `  ${c}`).join("\n")
          : "  None (no active conversations)",
        "",
        "## Conversation Mode",
        `  Trigger: @mention or reply to bot activates channel`,
        `  Idle timeout: ${convoTimeout / 1000}s (${convoTimeout / 60000} min)`,
        `  Behavior: responds to all users in channel while active`,
        `  DMs: always active (no timeout)`,
        "",
        "## Model & Engine",
        `  Model: Claude (inherited from Claude Code session)`,
        `  Engine: Claude Code CLI via plugin system`,
        `  Auth: Max plan (no API key)`,
        `  Change model: set model in Claude Code (/model command)`,
        "",
        "## Persona",
        `  Active: ${persona.name} (\`${personaKey}\`)`,
        `  Personality: ${persona.personality}`,
        `  Available: ${allPersonas.map((p) => `${p.key}${p.active ? " (active)" : ""}`).join(", ")}`,
        `  How to change: "switch to choomfie" or "switch to takagi"`,
        `  Create new: "create a pirate persona" or "save persona called yoda"`,
        `  Takes effect: next session restart`,
        "",
        "## System Prompt",
        `  Location: ~/choomfie/lib/mcp-server.ts (instructions array)`,
        `  How to change: ask Claude Code to edit it, or edit manually`,
        "",
        "## Access & Security",
        `  Policy: ${ctx.allowedUsers.size > 0 ? "allowlist" : "open (bootstrap mode — accepting all users)"}`,
        `  Owner: ${ctx.ownerUserId || "not set (auto-detects from Discord app on restart)"}`,
        `  Allowed users: ${ctx.allowedUsers.size > 0 ? [...ctx.allowedUsers].map((id) => `${id}${id === ctx.ownerUserId ? " (owner)" : ""}`).join(", ") : "none (accepting all)"}`,
        `  Trigger (DMs): always respond`,
        `  Trigger (servers): @mention or reply to bot only`,
        `  Rate limit: ${ctx.config.getRateLimitMs() / 1000}s cooldown per user`,
        `  Permission relay: owner-only (only owner can approve/deny)`,
        "",
        "## Security Roles",
        "  **Owner** — full access to all tools and system capabilities",
        "  **User** — chat, memory, reminders, reactions only (no file/bash/system access)",
        "  Enforcement: deterministic role tagging at server level + prompt instructions + permission gate",
        `  How to change: /choomfie:access owner <USER_ID> in Claude Code terminal`,
        "",
        "## Memory",
        `  Core memories: ${stats.coreCount} (always in context)`,
        `  Archival memories: ${stats.archivalCount} (searchable)`,
        `  Active reminders: ${stats.reminderCount}`,
        `  Database: ${ctx.DATA_DIR}/choomfie.db`,
        stats.oldestMemory
          ? `  Oldest entry: ${stats.oldestMemory}`
          : null,
        stats.newestMemory
          ? `  Newest entry: ${stats.newestMemory}`
          : null,
        "",
        core.length > 0 ? "## Core Memories" : null,
        ...core.map((m) => `  ${m.key}: ${m.value}`),
        "",
        reminders.length > 0 ? "## Active Reminders" : null,
        ...reminders.map(
          (r) => {
            const cron = r.cron ? ` (recurring: ${r.cron})` : "";
            const nag = r.nagInterval ? ` (nag every ${r.nagInterval}m)` : "";
            const cat = r.category ? ` [${r.category}]` : "";
            return `  [#${r.id}]${cat} ${r.message} (due: ${r.dueAt})${cron}${nag}`;
          }
        ),
        "",
        "## Skills (Claude Code terminal only)",
        "  /choomfie:configure <token> — set Discord bot token",
        "  /choomfie:access — manage allowlist & pairing",
        "  /choomfie:memory — view/manage memories via CLI",
        "  /choomfie:status — this overview (detailed file-level version)",
        "",
        "## Tools (available in Discord & terminal)",
        "  **Discord:** reply (with embeds), react, edit_message, fetch_messages, create_thread, create_poll, pin_message, unpin_message",
        "  **Memory:** save_memory, search_memory, list_memories, delete_memory, save_conversation_summary, memory_stats",
        "  **Reminders:** set_reminder, list_reminders, cancel_reminder, snooze_reminder, ack_reminder",
        "  **GitHub:** check_github (prs, issues, notifications, pr_status)",
        "  **Access:** allow_user, remove_user, list_allowed_users (owner only)",
        "  **Status:** choomfie_status",
        "",
        "## What You Can Change (just ask me!)",
        '  **Personality** — "be more sarcastic" / "talk like a pirate"',
        '  **Memories** — "remember my name is X" / "forget my timezone"',
        '  **Reminders** — "remind me in 30min to X" / "cancel reminder #3" / "snooze #1 for 1hr" / "done with #1"',
        '  **Recurring** — "remind me every day at 9am to check PRs"',
        '  **Nag mode** — "remind me to deploy and nag me until I do it"',
        '  **Pin/unpin** — "pin that" / "unpin that"',
        '  **Threads** — "start a thread about this"',
        '  **GitHub** — "what PRs need review?" / "any open issues?"',
        "",
        "## What Needs Claude Code Terminal",
        "  Discord token — /choomfie:configure",
        "  Access/allowlist/ownership — /choomfie:access",
        "  System prompt edits — edit ~/choomfie/lib/mcp-server.ts",
        "  Model selection — /model in Claude Code",
        "  Adding new tools — add a file in ~/choomfie/lib/tools/ and register in index.ts",
        "  Plugin restart — restart Claude Code (or run `choomfie`)",
      ];

      return text(lines.filter(Boolean).join("\n"));
    },
  },
];
