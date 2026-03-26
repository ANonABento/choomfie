/**
 * Reminder scheduler — uses precise setTimeout timers instead of polling.
 * Zero compute between reminders. Fires exactly on time.
 */

import type { TextChannel } from "discord.js";
import type { AppContext } from "./types.ts";
import type { Reminder } from "./memory.ts";
import { dateToSQLite, MS_PER_MIN } from "./time.ts";
import { buildReminderButtons } from "./handlers/reminder-buttons.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;

/** Parse simple cron patterns into next due date */
function getNextCronDate(cron: string, fromDate: Date): Date | null {
  const next = new Date(fromDate);

  switch (cron) {
    case "hourly":
      next.setHours(next.getHours() + 1);
      return next;
    case "daily":
      next.setDate(next.getDate() + 1);
      return next;
    case "weekly":
      next.setDate(next.getDate() + 7);
      return next;
    case "monthly":
      next.setMonth(next.getMonth() + 1);
      return next;
    default: {
      // Support "every Xh", "every Xm", "every Xd" patterns
      const match = cron.match(/^every\s+(\d+)\s*(m|min|h|hr|d|day)s?$/i);
      if (match) {
        const val = parseInt(match[1]);
        const unit = match[2].toLowerCase();
        if (unit === "m" || unit === "min") next.setMinutes(next.getMinutes() + val);
        else if (unit === "h" || unit === "hr") next.setHours(next.getHours() + val);
        else if (unit === "d" || unit === "day") next.setDate(next.getDate() + val);
        return next;
      }
      return null;
    }
  }
}

/** Format a reminder message for Discord */
function formatReminderMessage(reminder: Reminder, isNag: boolean): string {
  const prefix = isNag ? "**Nag**" : "**Reminder**";
  const category = reminder.category ? ` [${reminder.category}]` : "";
  const recurring = reminder.cron ? ` 🔁` : "";
  const nagInfo = isNag ? " *(reply to acknowledge)*" : "";
  const nagLabel = reminder.nagInterval ? ` 🔔` : "";

  return `${prefix}${category} for <@${reminder.userId}>: ${reminder.message}${recurring}${nagLabel}${nagInfo}`;
}

/**
 * Timer-based reminder scheduler.
 * Each reminder gets its own setTimeout — fires exactly when due.
 * Nag reminders get repeating timers after initial fire.
 */
export class ReminderScheduler {
  /** Active fire timers by reminder ID */
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  /** Active nag timers by reminder ID */
  private nagTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private ctx: AppContext | null = null;

  /** Initialize scheduler — load all pending reminders and schedule them */
  init(ctx: AppContext) {
    this.ctx = ctx;

    // Purge old completed reminders on startup
    const purged = ctx.memory.purgeOldReminders(7);
    if (purged > 0) console.error(`ReminderScheduler: purged ${purged} old reminders`);

    // Schedule all pending reminders
    const active = ctx.memory.getActiveReminders();
    for (const reminder of active) {
      this.scheduleReminder(reminder);
    }

    // Resume nag timers for fired-but-unacked reminders
    const unacked = ctx.memory.getNagReminders();
    for (const reminder of unacked) {
      this.scheduleNag(reminder);
    }

    console.error(`ReminderScheduler: initialized with ${active.length} pending, ${unacked.length} nagging`);
  }

  /** Schedule a reminder to fire at its due time */
  scheduleReminder(reminder: Reminder) {
    // Clear any existing timer for this ID
    this.clearTimer(reminder.id);
    this.setLongTimeout(this.timers, reminder.id, new Date(reminder.dueAt).getTime(), () => {
      void this.fireReminder(reminder);
    });
  }

  /** Schedule a nag ping for a fired reminder */
  private scheduleNag(reminder: Reminder) {
    if (!reminder.nagInterval) return;

    this.clearNagTimer(reminder.id);

    const targetMs = Date.now() + reminder.nagInterval * MS_PER_MIN;
    this.setLongTimeout(this.nagTimers, reminder.id, targetMs, () => {
      void this.fireNag(reminder);
    });
  }

  private setLongTimeout(
    timers: Map<number, ReturnType<typeof setTimeout>>,
    id: number,
    targetMs: number,
    onElapsed: () => void
  ) {
    const remainingMs = targetMs - Date.now();
    const delayMs = Math.max(0, Math.min(remainingMs, MAX_TIMEOUT_MS));

    const timer = setTimeout(() => {
      timers.delete(id);

      if (targetMs > Date.now()) {
        this.setLongTimeout(timers, id, targetMs, onElapsed);
        return;
      }

      onElapsed();
    }, delayMs);

    timers.set(id, timer);
  }

  /** Fire a due reminder */
  private async fireReminder(reminder: Reminder) {
    if (!this.ctx) return;

    try {
      const channel = await this.ctx.discord.channels.fetch(reminder.chatId);
      if (channel?.isTextBased()) {
        await (channel as TextChannel).send({
          content: formatReminderMessage(reminder, false),
          components: [buildReminderButtons(reminder.id)],
        });
      }
    } catch {
      // Channel not accessible — still mark as fired
    }

    this.ctx.memory.markReminderFired(reminder.id);

    // If recurring, create the next occurrence and schedule it
    if (reminder.cron) {
      const nextDate = getNextCronDate(reminder.cron, new Date(reminder.dueAt));
      if (nextDate) {
        const newId = this.ctx.memory.addReminder(
          reminder.userId,
          reminder.chatId,
          reminder.message,
          dateToSQLite(nextDate),
          {
            cron: reminder.cron,
            nagInterval: reminder.nagInterval ?? undefined,
            category: reminder.category ?? undefined,
          }
        );
        // Schedule the new occurrence
        if (newId != null) {
          const newReminder = this.ctx.memory.getReminder(newId);
          if (newReminder) this.scheduleReminder(newReminder);
        }
      }
    }

    // Start nag timer if nag mode is enabled
    if (reminder.nagInterval) {
      // Re-fetch to get updated state
      const updated = this.ctx.memory.getReminder(reminder.id);
      if (updated) this.scheduleNag(updated);
    }
  }

  /** Fire a nag ping for an unacknowledged reminder */
  private async fireNag(reminder: Reminder) {
    if (!this.ctx) return;

    // Re-fetch to check if acked/cancelled since timer was set
    const current = this.ctx.memory.getReminder(reminder.id);
    if (!current || current.ack) return;

    try {
      const channel = await this.ctx.discord.channels.fetch(current.chatId);
      if (channel?.isTextBased()) {
        await (channel as TextChannel).send({
          content: formatReminderMessage(current, true),
          components: [buildReminderButtons(current.id)],
        });
      }
    } catch {
      // Channel not accessible
    }

    this.ctx.memory.updateNagTime(current.id);

    // Schedule next nag using fresh state
    this.scheduleNag(current);
  }

  /** Cancel a reminder's timer */
  clearTimer(id: number) {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this.clearNagTimer(id);
  }

  /** Cancel a nag timer */
  clearNagTimer(id: number) {
    const timer = this.nagTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.nagTimers.delete(id);
    }
  }

  /** Get count of active timers (for status) */
  get activeTimerCount() {
    return this.timers.size;
  }

  get activeNagCount() {
    return this.nagTimers.size;
  }

  /** Clean up all timers */
  destroy() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const timer of this.nagTimers.values()) clearTimeout(timer);
    this.timers.clear();
    this.nagTimers.clear();
  }
}
