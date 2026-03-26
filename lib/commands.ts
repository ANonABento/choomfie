/**
 * Slash commands — definition + handlers.
 *
 * Commands are registered once via `deployCommands()` (run separately or on startup).
 * Handlers are called from interactions.ts when a ChatInputCommand interaction arrives.
 *
 * All commands respond directly (no Claude roundtrip) for instant response.
 */

import {
  SlashCommandBuilder,
  MessageFlags,
} from "discord.js";
import { registerCommand } from "./interactions.ts";
import { parseNaturalTime, formatDuration } from "./time.ts";
import { createAndScheduleReminder } from "./handlers/shared.ts";
import {
  buildReminderModal,
  buildPersonaModal,
  buildMemoryModal,
} from "./handlers/modals.ts";

// --- Command definitions ---

// /remind <message> <time>
registerCommand("remind", {
  data: new SlashCommandBuilder()
    .setName("remind")
    .setDescription("Set a reminder")
    .addStringOption((o) =>
      o.setName("message").setDescription("What to remind you about").setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("time").setDescription('When (e.g. "in 30 min", "tomorrow 9am")').setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("recurring")
        .setDescription("Repeat schedule")
        .addChoices(
          { name: "Hourly", value: "hourly" },
          { name: "Daily", value: "daily" },
          { name: "Weekly", value: "weekly" },
          { name: "Monthly", value: "monthly" }
        )
    )
    .addBooleanOption((o) =>
      o.setName("nag").setDescription("Nag until acknowledged? (default: no)")
    )
    .toJSON(),
  handler: async (interaction, ctx) => {
    const message = interaction.options.getString("message", true);
    const timeStr = interaction.options.getString("time", true);
    const recurring = interaction.options.getString("recurring");
    const nag = interaction.options.getBoolean("nag");

    const dueAt = parseNaturalTime(timeStr);
    if (!dueAt) {
      await interaction.reply({
        content: `Couldn't parse time: "${timeStr}". Try "in 30 min", "in 2 hours", or "tomorrow 9am".`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const response = createAndScheduleReminder(ctx, {
      userId: interaction.user.id,
      channelId: interaction.channelId,
      message,
      dueAt,
      cron: recurring ?? undefined,
      nagInterval: nag ? 15 : undefined,
    });

    await interaction.reply({ content: response });
  },
});

// /reminders — list active reminders
registerCommand("reminders", {
  data: new SlashCommandBuilder()
    .setName("reminders")
    .setDescription("List your active reminders")
    .toJSON(),
  handler: async (interaction, ctx) => {
    const active = ctx.memory.getActiveReminders(interaction.user.id);
    const unacked = ctx.memory.getUnackedReminders(interaction.user.id);

    if (active.length === 0 && unacked.length === 0) {
      await interaction.reply({
        content: "No active reminders.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const lines: string[] = [];
    if (unacked.length > 0) {
      lines.push("**Nagging:**");
      for (const r of unacked) {
        lines.push(`  ⚠️ #${r.id}: ${r.message}`);
      }
    }
    if (active.length > 0) {
      lines.push("**Pending:**");
      for (const r of active) {
        const ts = Math.floor(new Date(r.dueAt).getTime() / 1000);
        const cron = r.cron ? ` (${r.cron})` : "";
        lines.push(`  ⏰ #${r.id}: ${r.message} — <t:${ts}:R>${cron}`);
      }
    }

    await interaction.reply({
      content: lines.join("\n"),
      flags: MessageFlags.Ephemeral,
    });
  },
});

// /github <subcommand>
registerCommand("github", {
  data: new SlashCommandBuilder()
    .setName("github")
    .setDescription("Check GitHub status")
    .addStringOption((o) =>
      o
        .setName("check")
        .setDescription("What to check")
        .setRequired(true)
        .addChoices(
          { name: "Open PRs", value: "prs" },
          { name: "Open Issues", value: "issues" },
          { name: "Notifications", value: "notifications" },
          { name: "Current PR Status", value: "pr_status" }
        )
    )
    .addStringOption((o) =>
      o.setName("repo").setDescription("Repository (owner/repo format, optional)")
    )
    .toJSON(),
  handler: async (interaction) => {
    await interaction.deferReply();

    const command = interaction.options.getString("check", true);
    const repo = interaction.options.getString("repo");
    const repoArgs = repo ? ["-R", repo] : [];
    let ghArgs: string[] = [];

    switch (command) {
      case "prs":
        ghArgs = ["pr", "list", "--state=open", "--limit=10", ...repoArgs];
        break;
      case "issues":
        ghArgs = ["issue", "list", "--state=open", "--limit=10", ...repoArgs];
        break;
      case "notifications":
        ghArgs = ["api", "/notifications", "--jq", ".[].subject.title"];
        break;
      case "pr_status":
        ghArgs = ["pr", "status", ...repoArgs];
        break;
    }

    try {
      const proc = Bun.spawn(["gh", ...ghArgs], {
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      const output = stdout.trim() || stderr.trim() || "(no results)";
      await interaction.editReply({ content: `\`\`\`\n${output.slice(0, 1900)}\n\`\`\`` });
    } catch (e: any) {
      await interaction.editReply({ content: `GitHub CLI error: ${e.message}` });
    }
  },
});

// /status
registerCommand("status", {
  data: new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show bot status and stats")
    .toJSON(),
  handler: async (interaction, ctx) => {
    const stats = ctx.memory.getStats();
    const uptime = ctx.startedAt ? formatDuration(Date.now() - ctx.startedAt) : "unknown";
    const persona = ctx.config.getActivePersona();

    const lines = [
      `**Choomfie** v0.4.0 | Uptime: ${uptime}`,
      `Persona: ${persona.name} | Messages: ${ctx.messageStats.received} in, ${ctx.messageStats.sent} out`,
      `Memory: ${stats.coreCount} core, ${stats.archivalCount} archival | Reminders: ${stats.reminderCount} active`,
    ];

    await interaction.reply({
      content: lines.join("\n"),
      flags: MessageFlags.Ephemeral,
    });
  },
});

// /persona [switch]
registerCommand("persona", {
  data: new SlashCommandBuilder()
    .setName("persona")
    .setDescription("View or switch personas")
    .addStringOption((o) =>
      o.setName("switch").setDescription("Persona key to switch to (omit to list all)")
    )
    .toJSON(),
  handler: async (interaction, ctx) => {
    const switchTo = interaction.options.getString("switch");

    if (switchTo) {
      const persona = ctx.config.switchPersona(switchTo);
      if (!persona) {
        const available = ctx.config
          .listPersonas()
          .map((p) => `\`${p.key}\``)
          .join(", ");
        await interaction.reply({
          content: `Persona "${switchTo}" not found. Available: ${available}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.reply({
        content: `Switched to **${persona.name}**. Restart session for full effect.`,
      });
    } else {
      const personas = ctx.config.listPersonas();
      const lines = personas.map(
        (p) => `${p.active ? "→ " : "  "}\`${p.key}\` — **${p.persona.name}**`
      );
      await interaction.reply({
        content: `**Personas:**\n${lines.join("\n")}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  },
});

// /quickremind — opens a modal form
registerCommand("quickremind", {
  data: new SlashCommandBuilder()
    .setName("quickremind")
    .setDescription("Set a reminder via form (with optional recurring)")
    .toJSON(),
  handler: async (interaction) => {
    await interaction.showModal(buildReminderModal());
  },
});

// /newpersona — opens a modal form
registerCommand("newpersona", {
  data: new SlashCommandBuilder()
    .setName("newpersona")
    .setDescription("Create a new persona via form")
    .toJSON(),
  handler: async (interaction) => {
    await interaction.showModal(buildPersonaModal());
  },
});

// /savememory — opens a modal form
registerCommand("savememory", {
  data: new SlashCommandBuilder()
    .setName("savememory")
    .setDescription("Save something to memory via form")
    .toJSON(),
  handler: async (interaction) => {
    await interaction.showModal(buildMemoryModal());
  },
});
