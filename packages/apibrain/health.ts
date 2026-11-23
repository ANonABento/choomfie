/**
 * Cooldowns per capacity unit. A unit is whatever can fail on its own: one
 * key (`groq#2`), one model on a provider (`groq:openai/gpt-oss-20b`), or a
 * web brain (`waymond`). In memory: a restart clears every cooldown, which is
 * harmless (the first call just finds out again).
 */

import type { ProviderErrorKind } from "./errors.ts";

export interface HealthOptions {
  /** First cooldown for a repeated failure (5xx, timeout). Default 15s. */
  baseMs?: number;
  /** Longest exponential cooldown. Default 1h. */
  maxMs?: number;
  /** Failures in a row before a unit cools down. Default 2 (one blip is free). */
  threshold?: number;
}

export interface UnitHealth {
  until: number;
  failures: number;
  reason?: string;
}

const HOUR = 3_600_000;

/** How long each kind of failure benches its unit when the provider didn't say. */
export const COOLDOWN_MS: Partial<Record<ProviderErrorKind, number>> = {
  rate_limit: 60_000,
  quota: 6 * HOUR,
  auth: 6 * HOUR,
  model_gone: 24 * HOUR,
};

export class Health {
  private units = new Map<string, UnitHealth>();
  private readonly base: number;
  private readonly max: number;
  private readonly threshold: number;

  constructor(opts: HealthOptions = {}, private now: () => number = Date.now) {
    this.base = opts.baseMs ?? 15_000;
    this.max = opts.maxMs ?? HOUR;
    this.threshold = opts.threshold ?? 2;
  }

  available(unit: string): boolean {
    return (this.units.get(unit)?.until ?? 0) <= this.now();
  }

  /** Milliseconds until the unit is back (0 if it is). */
  waitMs(unit: string): number {
    return Math.max(0, (this.units.get(unit)?.until ?? 0) - this.now());
  }

  ok(unit: string): void {
    this.units.delete(unit);
  }

  /** Bench a unit for a known time (a rate limit with retry-after, a gone model). */
  cool(unit: string, ms: number, reason: string): void {
    const u = this.get(unit);
    u.until = Math.max(u.until, this.now() + ms);
    u.reason = reason;
  }

  /** An unexplained failure: free the first `threshold - 1` times, then exponential. */
  fail(unit: string, reason: string): void {
    const u = this.get(unit);
    u.failures += 1;
    u.reason = reason;
    if (u.failures >= this.threshold) {
      u.until = this.now() + Math.min(this.max, this.base * 2 ** (u.failures - this.threshold));
    }
  }

  /** Units that are cooling down right now, soonest back first. */
  cooling(): [string, UnitHealth][] {
    const now = this.now();
    return [...this.units].filter(([, u]) => u.until > now).sort((a, b) => a[1].until - b[1].until);
  }

  get(unit: string): UnitHealth {
    let u = this.units.get(unit);
    if (!u) this.units.set(unit, (u = { until: 0, failures: 0 }));
    return u;
  }
}

/** "3m", "2h", "45s" — for status lines. */
export function shortDuration(ms: number): string {
  if (ms >= HOUR) return `${Math.round(ms / HOUR)}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}
