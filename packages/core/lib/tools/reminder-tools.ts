/**
 * Reminder tools — set, list, cancel, snooze, acknowledge reminders.
 */

import { isAskChatId } from "../ask-relay.ts";
import type { ToolDef } from "../types.ts";
import { text, err } from "../types.ts";
import type { Reminder } from "../memory.ts";
import {
  dateToSQLite,
  fromSQLiteDatetime,
  isValidCron,
  normalizeTimeZone,
  parseNaturalTime,
  relativeTime,
} from "../time.ts";

function invalidTimeZoneMessage(timeZone: string): string {
  return `Invalid timezone "${timeZone}". Use a valid IANA timezone such as America/New_York or Europe/London.`;
}

function normalizeTimeZoneArg(value: unknown): string | null | undefined {
  if (value == null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return normalizeTimeZone(trimmed) ?? undefined;
}

function parseDueAt(input: unknown, timeZone: string | null): Date | null {
  if (typeof input !== "string") return null;
  return parseNaturalTime(input, { timeZone });
}

function parseCronArg(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** Format a single reminder for display */
function formatReminder(r: Reminder): string {
  const time = relativeTime(r.dueAt);
  const category = r.category ? ` [${r.category}]` : "";
  const cron = r.cron ? ` (recurring: ${r.cron})` : "";
  const nag = r.nagInterval ? ` (nag every ${r.nagInterval}m)` : "";
  const timezone = r.timezone ? ` (${r.timezone})` : "";
  return `[#${r.id}]${category} ${r.message} — ${time}${timezone}${cron}${nag}`;
}

export const reminderTools: ToolDef[] = [
  {
    definition: {
      name: "set_reminder",
      description:
        "Set a reminder. due_at can be an exact ISO 8601 UTC/offset instant or a natural/local expression ('in 30 min', 'tomorrow at 9am', '2026-04-25 09:00'). Pass timezone for local wall-clock expressions. Use cron for recurring, nag_interval to re-ping until ack'd. When a nag fires, tell the user to say 'done' or 'ack' to stop it.",
      inputSchema: {
        type: "object" as const,
        properties: {
          user_id: {
            type: "string",
            description: "Discord user ID to remind",
          },
          chat_id: {
            type: "string",
            description: "Channel ID to post reminder in",
          },
          message: { type: "string", description: "Reminder message" },
          due_at: {
            type: "string",
            description:
              "When to fire the reminder. Accepts ISO 8601 UTC/offset instants, relative times, or local wall-clock expressions. Local expressions use timezone when provided, otherwise UTC.",
          },
          timezone: {
            type: "string",
            description:
              "Optional IANA timezone for local wall-clock due_at values, e.g. America/New_York. Omit for exact ISO UTC/offset instants or relative durations.",
          },
          cron: {
            type: "string",
            description:
              'Recurring schedule: "hourly", "daily", "weekly", "monthly", or "every Xm/h/d" (e.g. "every 2h"). Omit for one-off reminders.',
          },
          nag_interval: {
            type: "number",
            description:
              "Nag mode: re-ping every X minutes until acknowledged. Omit to disable nagging.",
          },
          category: {
            type: "string",
            description:
              'Optional category label (e.g. "work", "personal", "health")',
          },
        },
        required: ["user_id", "chat_id", "message", "due_at"],
      },
    },
    handler: async (args, ctx) => {
      const timezone = normalizeTimeZoneArg(args.timezone);
      if (timezone === undefined) {
        return err(invalidTimeZoneMessage(String(args.timezone)));
      }

      const dueAt = parseDueAt(args.due_at, timezone);
      if (!dueAt) {
        return err(
          `Couldn't parse due_at "${String(args.due_at)}". Use a relative time, an ISO UTC/offset instant, or a local wall-clock time with a valid timezone.`
        );
      }
      const cron = parseCronArg(args.cron);
      if (cron && !isValidCron(cron)) {
        return err(
          `Invalid recurring pattern "${cron}". Use hourly, daily, weekly, monthly, or "every Xh".`
        );
      }

      // A chat from /choomfie (ask:…) is gone in 15 minutes and the bot can't
      // post into it, so the reminder goes to the user's DM instead.
      let chatId = args.chat_id as string;
      let viaDm = false;
      if (isAskChatId(chatId)) {
        try {
          const dm = await (await ctx.discord.users.fetch(args.user_id as string)).createDM();
          chatId = dm.id;
          viaDm = true;
        } catch {
          return err("This chat came from /choomfie and the reminder can't be delivered here, and I couldn't open a DM with that user.");
        }
      }

      const newId = ctx.memory.addReminder(
        args.user_id as string,
        chatId,
        args.message as string,
        dateToSQLite(dueAt),
        {
          cron,
          timezone,
          nagInterval: args.nag_interval as number | undefined,
          category: args.category as string | undefined,
        }
      );
      // Schedule a precise timer for this reminder
      const reminder = ctx.memory.getReminder(newId);
      if (reminder) ctx.reminderScheduler.scheduleReminder(reminder);

      const ts = Math.floor(dueAt.getTime() / 1000);
      const parts = [
        `Reminder set for <t:${ts}:R> (${dateToSQLite(dueAt)} UTC): ${args.message}`,
      ];
      if (timezone) parts.push(`Timezone: ${timezone}`);
      if (cron) parts.push(`Recurring: ${cron}`);
      if (args.nag_interval) parts.push(`Nag: every ${args.nag_interval}m until acknowledged`);
      if (args.category) parts.push(`Category: ${args.category}`);
      if (viaDm) parts.push("Delivered by DM — this chat can't receive it. Tell the user so.");
      return text(parts.join("\n"));
    },
  },
  {
    definition: {
      name: "list_reminders",
      description: "List active (pending) reminders with relative times. Optionally filter by user.",
      inputSchema: {
        type: "object" as const,
        properties: {
          user_id: {
            type: "string",
            description: "Filter by user (optional)",
          },
          include_history: {
            type: "boolean",
            description: "Include recently fired reminders (default false)",
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const active = ctx.memory.getActiveReminders(
        args.user_id as string | undefined
      );
      const unacked = ctx.memory.getUnackedReminders(
        args.user_id as string | undefined
      );

      const sections: string[] = [];

      if (unacked.length > 0) {
        sections.push(
          "**Nagging (unacknowledged):**\n" +
            unacked.map((r) => `⚠️ ${formatReminder(r)}`).join("\n")
        );
      }

      if (active.length > 0) {
        sections.push(
          "**Pending:**\n" +
            active.map((r) => `⏰ ${formatReminder(r)}`).join("\n")
        );
      }

      if (args.include_history) {
        const history = ctx.memory.getReminderHistory(10);
        if (history.length > 0) {
          sections.push(
            "**Recently fired:**\n" +
              history.map((r) => `✅ ${formatReminder(r)}`).join("\n")
          );
        }
      }

      if (sections.length === 0) return text("No active reminders.");
      return text(sections.join("\n\n"));
    },
  },
  {
    definition: {
      name: "cancel_reminder",
      description: "Cancel a reminder by ID. Works on pending or nagging reminders.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "number", description: "Reminder ID" },
        },
        required: ["id"],
      },
    },
    handler: async (args, ctx) => {
      const id = args.id as number;
      const success = ctx.memory.cancelReminder(id);
      if (success) ctx.reminderScheduler.clearTimer(id);
      return success
        ? text(`Reminder #${id} cancelled.`)
        : err(`Reminder #${id} not found or already completed.`);
    },
  },
  {
    definition: {
      name: "snooze_reminder",
      description:
        "Snooze a fired reminder — reschedules it for a new time. Use when the user says 'snooze', 'remind me later', 'not now', etc.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "number", description: "Reminder ID to snooze" },
          due_at: {
            type: "string",
            description:
              "New due time. Accepts ISO 8601 UTC/offset instants, relative times, or local wall-clock expressions.",
          },
          timezone: {
            type: "string",
            description:
              "Optional IANA timezone for local wall-clock due_at values. Defaults to the reminder's stored timezone, then UTC.",
          },
        },
        required: ["id", "due_at"],
      },
    },
    handler: async (args, ctx) => {
      const id = args.id as number;
      const reminder = ctx.memory.getReminder(id);
      if (!reminder) return err(`Reminder #${id} not found.`);

      // For recurring reminders, snoozing doesn't make sense — next occurrence is already scheduled.
      // Just ack it to stop nagging.
      if (reminder.cron) {
        ctx.memory.ackReminder(id);
        return text(`Reminder #${id} acknowledged (recurring — next occurrence already scheduled).`);
      }

      const timezoneArg = normalizeTimeZoneArg(args.timezone);
      if (timezoneArg === undefined) return err(invalidTimeZoneMessage(String(args.timezone)));
      const timezone = timezoneArg ?? reminder.timezone;
      const dueAt = parseDueAt(args.due_at, timezone);
      if (!dueAt) {
        return err(
          `Couldn't parse due_at "${String(args.due_at)}". Use a relative time, an ISO UTC/offset instant, or a local wall-clock time with a valid timezone.`
        );
      }

      const success = ctx.memory.snoozeReminder(id, dateToSQLite(dueAt), { timezone });
      if (!success) return err(`Reminder #${id} could not be snoozed.`);
      // Reschedule with new time
      const updated = ctx.memory.getReminder(id);
      if (updated) ctx.reminderScheduler.scheduleReminder(updated);
      const ts = Math.floor(fromSQLiteDatetime(dateToSQLite(dueAt)).getTime() / 1000);
      return text(
        `Reminder #${id} snoozed until <t:${ts}:R> (${dateToSQLite(dueAt)} UTC)` +
          (timezone ? `\nTimezone: ${timezone}` : "")
      );
    },
  },
  {
    definition: {
      name: "ack_reminder",
      description:
        "Acknowledge a nagging reminder to stop it from re-pinging. Use when the user confirms they've seen/done the thing.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "number", description: "Reminder ID to acknowledge" },
        },
        required: ["id"],
      },
    },
    handler: async (args, ctx) => {
      const id = args.id as number;
      const success = ctx.memory.ackReminder(id);
      if (!success)
        return err(`Reminder #${id} not found or hasn't fired yet.`);
      ctx.reminderScheduler.clearNagTimer(id);
      return text(`Reminder #${id} acknowledged — nagging stopped.`);
    },
  },
];
