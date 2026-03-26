/**
 * Shared time utilities — constants, formatting, parsing.
 *
 * SQLite's datetime('now') returns 'YYYY-MM-DD HH:MM:SS' (space separator, no Z).
 * All dates stored in the DB must match this format for comparisons to work.
 * JavaScript's toISOString() returns 'YYYY-MM-DDTHH:MM:SS.sssZ' which breaks
 * SQLite string comparisons (T > space in ASCII).
 */

// --- Time constants (ms) ---

export const MS_PER_MIN = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

// --- SQLite formatting ---

/**
 * Convert any ISO 8601 datetime to SQLite-compatible format.
 * '2026-03-25T15:28:12Z'     → '2026-03-25 15:28:12'
 * '2026-03-25T15:28:12.000Z' → '2026-03-25 15:28:12'
 * '2026-03-25 15:28:12'      → '2026-03-25 15:28:12' (no-op)
 */
export function toSQLiteDatetime(iso: string): string {
  return iso.replace("T", " ").replace(/\.?\d*Z$/, "").trim();
}

/**
 * Get current UTC time in SQLite-compatible format.
 */
export function nowUTC(): string {
  return toSQLiteDatetime(new Date().toISOString());
}

/**
 * Convert a Date object to SQLite-compatible format.
 */
export function dateToSQLite(date: Date): string {
  return toSQLiteDatetime(date.toISOString());
}

// --- Duration formatting ---

/** Format milliseconds as human-readable duration (e.g. "2d 3h", "45m", "12s") */
export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);

  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** Format relative time from now (e.g. "in 5m", "2h ago") */
export function relativeTime(isoDate: string): string {
  const now = Date.now();
  const target = new Date(isoDate).getTime();
  const diffMs = target - now;
  const abs = Math.abs(diffMs);
  const past = diffMs < 0;

  if (abs < MS_PER_MIN) return past ? "just now" : "in <1 min";
  if (abs < MS_PER_HOUR) {
    const mins = Math.floor(abs / MS_PER_MIN);
    return past ? `${mins}m ago` : `in ${mins}m`;
  }
  if (abs < MS_PER_DAY) {
    const hrs = Math.floor(abs / MS_PER_HOUR);
    return past ? `${hrs}h ago` : `in ${hrs}h`;
  }
  const days = Math.floor(abs / MS_PER_DAY);
  return past ? `${days}d ago` : `in ${days}d`;
}

// --- Natural time parsing ---

/** Parse natural time expressions into a Date. Returns null if unparseable. */
export function parseNaturalTime(input: string): Date | null {
  const now = new Date();
  const lower = input.toLowerCase().trim();

  // "in X min/minutes/m"
  let match = lower.match(/^in\s+(\d+)\s*(m|min|mins|minutes?)$/);
  if (match) {
    return new Date(now.getTime() + parseInt(match[1]) * MS_PER_MIN);
  }

  // "in X hours/h/hr"
  match = lower.match(/^in\s+(\d+)\s*(h|hr|hrs|hours?)$/);
  if (match) {
    return new Date(now.getTime() + parseInt(match[1]) * MS_PER_HOUR);
  }

  // "in X days/d"
  match = lower.match(/^in\s+(\d+)\s*(d|days?)$/);
  if (match) {
    return new Date(now.getTime() + parseInt(match[1]) * MS_PER_DAY);
  }

  // "in Xh Ym" or "in X hours Y minutes"
  match = lower.match(/^in\s+(\d+)\s*h(?:ours?)?\s+(\d+)\s*m(?:in(?:ute)?s?)?$/);
  if (match) {
    return new Date(
      now.getTime() +
        parseInt(match[1]) * MS_PER_HOUR +
        parseInt(match[2]) * MS_PER_MIN
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

// --- Cron validation ---

const VALID_CRON = ["hourly", "daily", "weekly", "monthly"];
const CRON_PATTERN = /^every\s+\d+\s*(m|min|h|hr|d|day)s?$/i;

/** Check if a cron pattern string is valid */
export function isValidCron(pattern: string): boolean {
  return VALID_CRON.includes(pattern) || CRON_PATTERN.test(pattern);
}
