/**
 * Reminder tools — set, list, cancel, snooze, acknowledge reminders.
 */

import type { ToolDef } from "../types.ts";
import { text, err } from "../types.ts";
import type { Reminder } from "../memory.ts";
import { relativeTime } from "../time.ts";

/** Format a single reminder for display */
function formatReminder(r: Reminder): string {
  const time = relativeTime(r.dueAt);
  const category = r.category ? ` [${r.category}]` : "";
  const cron = r.cron ? ` (recurring: ${r.cron})` : "";
  const nag = r.nagInterval ? ` (nag every ${r.nagInterval}m)` : "";
  return `[#${r.id}]${category} ${r.message} — ${time}${cron}${nag}`;
}

export const reminderTools: ToolDef[] = [
  {
    definition: {
      name: "set_reminder",
      description:
        "Set a reminder. Parse natural time expressions ('in 30 min', 'tomorrow at 9am') into ISO 8601 UTC for due_at. Use cron for recurring, nag_interval to re-ping until ack'd. When a nag fires, tell the user to say 'done' or 'ack' to stop it.",
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
              "When to fire the reminder (ISO 8601 UTC, e.g. 2026-03-25T14:30:00Z)",
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
      const newId = ctx.memory.addReminder(
        args.user_id as string,
        args.chat_id as string,
        args.message as string,
        args.due_at as string,
        {
          cron: args.cron as string | undefined,
          nagInterval: args.nag_interval as number | undefined,
          category: args.category as string | undefined,
        }
      );
      // Schedule a precise timer for this reminder
      const reminder = ctx.memory.getReminder(newId);
      if (reminder) ctx.reminderScheduler.scheduleReminder(reminder);

      const parts = [`Reminder set for ${args.due_at}: ${args.message}`];
      if (args.cron) parts.push(`Recurring: ${args.cron}`);
      if (args.nag_interval) parts.push(`Nag: every ${args.nag_interval}m until acknowledged`);
      if (args.category) parts.push(`Category: ${args.category}`);
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
              "New due time (ISO 8601 UTC). Parse natural language like 'in 1 hour' into absolute time.",
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

      const success = ctx.memory.snoozeReminder(id, args.due_at as string);
      if (!success) return err(`Reminder #${id} could not be snoozed.`);
      // Reschedule with new time
      const updated = ctx.memory.getReminder(id);
      if (updated) ctx.reminderScheduler.scheduleReminder(updated);
      return text(`Reminder #${id} snoozed until ${args.due_at}`);
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
