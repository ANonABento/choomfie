/**
 * Shared handler utilities — DRY helpers used by both slash commands and modals.
 */

import type { AppContext } from "../types.ts";

interface ReminderOpts {
  userId: string;
  channelId: string;
  message: string;
  dueAt: Date;
  cron?: string;
  nagInterval?: number;
}

/**
 * Create a reminder, schedule its timer, and return a formatted response string.
 * Used by both /remind command and the reminder modal submit handler.
 */
export function createAndScheduleReminder(
  ctx: AppContext,
  opts: ReminderOpts
): string {
  const newId = ctx.memory.addReminder(
    opts.userId,
    opts.channelId,
    opts.message,
    opts.dueAt.toISOString(),
    {
      cron: opts.cron,
      nagInterval: opts.nagInterval,
    }
  );

  const reminder = ctx.memory.getReminder(newId);
  if (reminder) ctx.reminderScheduler.scheduleReminder(reminder);

  const ts = Math.floor(opts.dueAt.getTime() / 1000);
  const parts = [`**Reminder set** for <t:${ts}:R>: ${opts.message}`];
  if (opts.cron) parts.push(`Recurring: ${opts.cron}`);
  if (opts.nagInterval) parts.push(`Nag mode: on (every ${opts.nagInterval}min until done)`);

  return parts.join("\n");
}
