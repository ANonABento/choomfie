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
  type ChatInputCommandInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import type { AppContext } from "./types.ts";

/** Command handler signature */
type CommandHandler = (
  interaction: ChatInputCommandInteraction,
  ctx: AppContext
) => Promise<void>;

/** Command definition + handler pair */
interface CommandDef {
  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  handler: CommandHandler;
}

const commands = new Map<string, CommandDef>();

/** Get all command definitions for registration */
export function getCommandDefs(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return [...commands.values()].map((c) => c.data);
}

/** Get a command handler by name */
export function getCommandHandler(name: string): CommandHandler | undefined {
  return commands.get(name)?.handler;
}

// --- Command definitions ---

// /remind <message> <time>
commands.set(
  "remind",
  {
    data: new SlashCommandBuilder()
      .setName("remind")
      .setDescription("Set a reminder")
      .addStringOption((o) =>
        o
          .setName("message")
          .setDescription("What to remind you about")
          .setRequired(true)
      )
      .addStringOption((o) =>
        o
          .setName("time")
          .setDescription('When (e.g. "in 30 min", "in 2 hours", "tomorrow 9am")')
          .setRequired(true)
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

      const newId = ctx.memory.addReminder(
        interaction.user.id,
        interaction.channelId,
        message,
        dueAt.toISOString(),
        {
          cron: recurring ?? undefined,
          nagInterval: nag ? 15 : undefined,
        }
      );

      const reminder = ctx.memory.getReminder(newId);
      if (reminder) ctx.reminderScheduler.scheduleReminder(reminder);

      const parts = [`**Reminder set** for <t:${Math.floor(dueAt.getTime() / 1000)}:R>: ${message}`];
      if (recurring) parts.push(`Recurring: ${recurring}`);
      if (nag) parts.push("Nag mode: on (every 15min until done)");

      await interaction.reply({ content: parts.join("\n") });
    },
  }
);

// /reminders — list active reminders
commands.set(
  "reminders",
  {
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
  }
);

// /github <subcommand>
commands.set(
  "github",
  {
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
        o
          .setName("repo")
          .setDescription("Repository (owner/repo format, optional)")
      )
      .toJSON(),
    handler: async (interaction, ctx) => {
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
  }
);

// /status
commands.set(
  "status",
  {
    data: new SlashCommandBuilder()
      .setName("status")
      .setDescription("Show bot status and stats")
      .toJSON(),
    handler: async (interaction, ctx) => {
      const stats = ctx.memory.getStats();
      const uptime = ctx.startedAt
        ? formatDuration(Date.now() - ctx.startedAt)
        : "unknown";
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
  }
);

// /persona [switch]
commands.set(
  "persona",
  {
    data: new SlashCommandBuilder()
      .setName("persona")
      .setDescription("View or switch personas")
      .addStringOption((o) =>
        o
          .setName("switch")
          .setDescription("Persona key to switch to (omit to list all)")
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
          (p) =>
            `${p.active ? "→ " : "  "}\`${p.key}\` — **${p.persona.name}**`
        );
        await interaction.reply({
          content: `**Personas:**\n${lines.join("\n")}`,
          flags: MessageFlags.Ephemeral,
        });
      }
    },
  }
);

// --- Helpers ---

/** Parse natural time expressions into a Date */
function parseNaturalTime(input: string): Date | null {
  const now = new Date();
  const lower = input.toLowerCase().trim();

  // "in X min/minutes/m"
  let match = lower.match(/^in\s+(\d+)\s*(m|min|mins|minutes?)$/);
  if (match) {
    return new Date(now.getTime() + parseInt(match[1]) * 60_000);
  }

  // "in X hours/h/hr"
  match = lower.match(/^in\s+(\d+)\s*(h|hr|hrs|hours?)$/);
  if (match) {
    return new Date(now.getTime() + parseInt(match[1]) * 3_600_000);
  }

  // "in X days/d"
  match = lower.match(/^in\s+(\d+)\s*(d|days?)$/);
  if (match) {
    return new Date(now.getTime() + parseInt(match[1]) * 86_400_000);
  }

  // "in Xh Ym" or "in X hours Y minutes"
  match = lower.match(/^in\s+(\d+)\s*h(?:ours?)?\s+(\d+)\s*m(?:in(?:ute)?s?)?$/);
  if (match) {
    return new Date(
      now.getTime() +
        parseInt(match[1]) * 3_600_000 +
        parseInt(match[2]) * 60_000
    );
  }

  // "tomorrow" or "tomorrow at Xam/pm"
  match = lower.match(/^tomorrow(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/);
  if (match) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (match[1]) {
      let hours = parseInt(match[1]);
      const mins = match[2] ? parseInt(match[2]) : 0;
      if (match[3] === "pm" && hours < 12) hours += 12;
      if (match[3] === "am" && hours === 12) hours = 0;
      tomorrow.setHours(hours, mins, 0, 0);
    } else {
      tomorrow.setHours(9, 0, 0, 0); // Default to 9am
    }
    return tomorrow;
  }

  // "Xam/pm" or "X:YY am/pm" (today or tomorrow if past)
  match = lower.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (match) {
    let hours = parseInt(match[1]);
    const mins = match[2] ? parseInt(match[2]) : 0;
    if (match[3] === "pm" && hours < 12) hours += 12;
    if (match[3] === "am" && hours === 12) hours = 0;
    const target = new Date(now);
    target.setHours(hours, mins, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    return target;
  }

  return null;
}

/** Format ms duration as human-readable */
function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);

  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
