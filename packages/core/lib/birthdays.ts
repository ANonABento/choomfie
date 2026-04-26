/**
 * Birthday scheduling and date helpers.
 */

import type { User } from "discord.js";
import type { Birthday } from "./memory.ts";
import type { AppContext } from "./types.ts";
import { MS_PER_DAY } from "./time.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;

export interface BirthdayOccurrence {
  birthday: Birthday;
  daysUntil: number;
  nextDate: string;
  occurrenceYear: number;
  turningAge: number | null;
  isToday: boolean;
}

interface ParsedBirthday {
  birthday: string;
  year: number | null;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isValidMonthDay(month: number, day: number, year = 2024): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function currentLocalDate(from: Date): { year: number; month: number; day: number } {
  return {
    year: from.getFullYear(),
    month: from.getMonth() + 1,
    day: from.getDate(),
  };
}

function ordinal(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

function validOccurrenceYear(month: number, day: number, startYear: number): number {
  for (let year = startYear; year < startYear + 8; year++) {
    if (isValidMonthDay(month, day, year)) return year;
  }
  return startYear;
}

export function todayBirthdayKey(from = new Date()): string {
  return `${pad2(from.getMonth() + 1)}-${pad2(from.getDate())}`;
}

export function todayReminderKey(from = new Date()): string {
  const local = currentLocalDate(from);
  return `${local.year}-${pad2(local.month)}-${pad2(local.day)}`;
}

export function parseBirthdayInput(input: unknown): ParsedBirthday | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  let match = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);
    if (!isValidMonthDay(month, day, year)) return null;
    return { birthday: `${pad2(month)}-${pad2(day)}`, year };
  }

  match = trimmed.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;

  const month = parseInt(match[1], 10);
  const day = parseInt(match[2], 10);
  if (!isValidMonthDay(month, day)) return null;
  return { birthday: `${pad2(month)}-${pad2(day)}`, year: null };
}

export function getBirthdayOccurrence(
  birthday: Birthday,
  from = new Date()
): BirthdayOccurrence {
  const [monthRaw, dayRaw] = birthday.birthday.split("-");
  const month = parseInt(monthRaw, 10);
  const day = parseInt(dayRaw, 10);
  const today = currentLocalDate(from);
  const todayOrd = ordinal(today.year, today.month, today.day);

  let occurrenceYear = validOccurrenceYear(month, day, today.year);
  let occurrenceOrd = ordinal(occurrenceYear, month, day);

  if (occurrenceOrd < todayOrd) {
    occurrenceYear = validOccurrenceYear(month, day, today.year + 1);
    occurrenceOrd = ordinal(occurrenceYear, month, day);
  }

  return {
    birthday,
    daysUntil: occurrenceOrd - todayOrd,
    nextDate: `${occurrenceYear}-${birthday.birthday}`,
    occurrenceYear,
    turningAge: birthday.year ? occurrenceYear - birthday.year : null,
    isToday: occurrenceOrd === todayOrd,
  };
}

export function sortBirthdayOccurrences(
  birthdays: Birthday[],
  from = new Date()
): BirthdayOccurrence[] {
  return birthdays
    .map((birthday) => getBirthdayOccurrence(birthday, from))
    .sort((a, b) => {
      if (a.daysUntil !== b.daysUntil) return a.daysUntil - b.daysUntil;
      return a.birthday.name.localeCompare(b.birthday.name);
    });
}

export function getUpcomingBirthdayOccurrences(
  birthdays: Birthday[],
  days: number,
  from = new Date()
): BirthdayOccurrence[] {
  return sortBirthdayOccurrences(birthdays, from).filter(
    (occurrence) => occurrence.daysUntil <= days
  );
}

function formatMonthDay(nextDate: string): string {
  const [year, month, day] = nextDate.split("-").map((part) => parseInt(part, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function formatBirthdayOccurrence(occurrence: BirthdayOccurrence): string {
  const person = occurrence.birthday.userId
    ? `<@${occurrence.birthday.userId}> (${occurrence.birthday.name})`
    : occurrence.birthday.name;
  const when = occurrence.isToday
    ? "today"
    : occurrence.daysUntil === 1
      ? "tomorrow"
      : `in ${occurrence.daysUntil} days`;
  const age = occurrence.turningAge != null ? `, turning ${occurrence.turningAge}` : "";
  const notes = occurrence.birthday.notes ? ` — ${occurrence.birthday.notes}` : "";
  return `- ${person} — ${formatMonthDay(occurrence.nextDate)} (${when}${age})${notes}`;
}

function nextLocalMidnight(from = new Date()): Date {
  return new Date(
    from.getFullYear(),
    from.getMonth(),
    from.getDate() + 1,
    0,
    0,
    0,
    0
  );
}

export class BirthdayScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ctx: AppContext | null = null;

  constructor(ctx: AppContext | null = null) {
    this.ctx = ctx;
  }

  init(ctx: AppContext): void {
    this.ctx = ctx;
    void this.runDailyCheck();
    this.scheduleNext();
    console.error("BirthdayScheduler: initialized");
  }

  private scheduleNext(): void {
    this.clearTimer();
    this.setLongTimeout(nextLocalMidnight().getTime(), () => {
      void this.runDailyCheck();
      this.scheduleNext();
    });
  }

  private setLongTimeout(targetMs: number, onElapsed: () => void): void {
    const remainingMs = targetMs - Date.now();
    const delayMs = Math.max(0, Math.min(remainingMs, MAX_TIMEOUT_MS));

    this.timer = setTimeout(() => {
      this.timer = null;

      if (targetMs > Date.now()) {
        this.setLongTimeout(targetMs, onElapsed);
        return;
      }

      onElapsed();
    }, delayMs);
  }

  async runDailyCheck(now = new Date()): Promise<void> {
    if (!this.ctx?.ownerUserId) return;

    const todayKey = todayBirthdayKey(now);
    const reminderKey = todayReminderKey(now);
    const todaysBirthdays = this.ctx.memory
      .getTodaysBirthdays(todayKey)
      .filter((birthday) => birthday.lastRemindedOn !== reminderKey);
    if (todaysBirthdays.length === 0) return;

    let owner: User;
    try {
      owner = await this.ctx.discord.users.fetch(this.ctx.ownerUserId);
    } catch {
      return;
    }

    const birthdayList = sortBirthdayOccurrences(todaysBirthdays, now)
      .map(formatBirthdayOccurrence)
      .join("\n");
    try {
      await owner.send(`**Birthday reminder**\n\n**Today:**\n${birthdayList}`);
      this.ctx.messageStats.sent++;
      for (const birthday of todaysBirthdays) {
        this.ctx.memory.markBirthdayReminded(birthday.id, reminderKey);
      }
    } catch {
      // DMs disabled or Discord unavailable; try again on next startup/midnight.
    }
  }

  clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  destroy(): void {
    this.clearTimer();
  }
}
