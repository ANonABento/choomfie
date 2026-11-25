/** Convert an unknown thrown value into a readable message. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const UNIT_MS: Record<string, number> = { s: 1000, m: MINUTE, h: HOUR, d: DAY, w: 7 * DAY };

/**
 * When an "out of quota" message says the allowance comes back, as epoch ms.
 * Reads relative times ("in 3 hours", "try again in 2h 15m", "resets in 4 days")
 * and absolute ones that `Date.parse` takes ("resets at 2026-11-27T17:00:00Z").
 * Undefined when it says nothing usable.
 */
export function parseResetAt(text: string, now = Date.now()): number | undefined {
  const rel = /\bin\s+((?:\d+(?:\.\d+)?\s*(?:seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\b[\s,and]*)+)/i.exec(text);
  if (rel) {
    let ms = 0;
    for (const [, n, unit] of rel[1].matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
      const u = unit.toLowerCase();
      const key = u.startsWith("mo") ? "" : u.startsWith("mi") || u === "m" ? "m" : u[0];
      if (UNIT_MS[key]) ms += Number(n) * UNIT_MS[key];
    }
    if (ms > 0) return now + ms;
  }
  const iso = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/.exec(text);
  if (iso) {
    const at = Date.parse(iso[0].replace(" ", "T"));
    if (Number.isFinite(at) && at > now) return at;
  }
  return undefined;
}

/**
 * A brain's allowance is spent (a site's daily or weekly cap, a CLI's
 * quota): not broken, just done until `resetAt`. Thrown by web-brain adapters
 * and harnesses; the free brain benches that member until then instead of
 * counting it as a failure. Checked by name (`isQuotaReached`), so a copy of
 * the class from another package still counts.
 */
export class QuotaReachedError extends Error {
  constructor(
    readonly brainLabel: string,
    /** Epoch ms when it comes back, when the site or CLI said. */
    readonly resetAt?: number,
    /** The site's own words, for the logs. */
    readonly detail?: string
  ) {
    super(`${brainLabel} is out of its free allowance${resetAt ? ` until ${new Date(resetAt).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}` : " for now"}.`);
    this.name = "QuotaReachedError";
  }
}

export function isQuotaReached(e: unknown): e is QuotaReachedError {
  return (e as { name?: string } | null)?.name === "QuotaReachedError";
}
