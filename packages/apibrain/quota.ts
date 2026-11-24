/**
 * Local usage counters per key, so the free path stops short of a provider's
 * limit instead of finding it with a 429.
 *
 * Two sources, the stricter wins: our own counts against the configured
 * limits (rpm/rpd/tpm/tpd), and what the provider's headers last said
 * (remaining requests, and when that resets). Daily counts are saved to
 * `meta/apibrain-usage.json`, so a worker restart doesn't hand out a fresh day.
 */

import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomicSync } from "@choomfie/shared";
import type { RateSnapshot } from "./client.ts";
import type { Limits } from "./provider.ts";

interface Counter {
  /** Day the daily counts belong to (YYYY-MM-DD) in the provider's reset zone (UTC unless set). */
  day: string;
  requestsToday: number;
  tokensToday: number;
  /** [timestamp, tokens] in the last minute. Not saved. */
  minute: [number, number][];
  /** The provider said: nothing left until this time. Not saved. */
  blockedUntil?: number;
  /** Requests left per the last response's headers. Not saved. */
  headerRemaining?: number;
}

/** The date at `t` in a time zone, YYYY-MM-DD. */
export function dayIn(t: number, zone = "UTC"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
}

/** Milliseconds from `t` to the next midnight in a time zone. */
export function msToMidnight(t: number, zone = "UTC"): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(t);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const into = ((get("hour") * 60 + get("minute")) * 60 + get("second")) * 1000 + (t % 1000);
  return 86_400_000 - into;
}

export class Quota {
  private counters = new Map<string, Counter>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Provider id → the zone its days reset in. */
  private zones = new Map<string, string>();

  constructor(
    /** Where to keep daily counts; null keeps them in memory (tests, the CLI). */
    private file: string | null = null,
    private now: () => number = Date.now
  ) {
    if (file && existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, { day: string; requestsToday: number; tokensToday: number }>;
        for (const [unit, c] of Object.entries(saved)) {
          if (c && typeof c.day === "string") this.counters.set(unit, { day: c.day, requestsToday: c.requestsToday | 0, tokensToday: c.tokensToday | 0, minute: [] });
        }
      } catch (e) {
        console.error(`[apibrain] couldn't read ${file}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  /** A provider's daily limits reset at midnight in this zone, not UTC. */
  zone(providerId: string, timeZone: string): void {
    this.zones.set(providerId, timeZone);
  }

  private zoneOf(unit: string): string {
    return this.zones.get(unit.split(/[#:]/)[0]) ?? "UTC";
  }

  /** Room for one more request of about `tokens` on this unit? */
  hasCapacity(unit: string, limits: Limits = {}, tokens = 0): boolean {
    return this.waitMs(unit, limits, tokens) === 0;
  }

  /** 0 when there's room; otherwise roughly how long until there is. */
  waitMs(unit: string, limits: Limits = {}, tokens = 0): number {
    const c = this.counter(unit);
    const now = this.now();
    if (c.blockedUntil && c.blockedUntil > now) return c.blockedUntil - now;
    if ((limits.rpd && c.requestsToday >= limits.rpd) || (limits.tpd && c.tokensToday + tokens > limits.tpd)) {
      return msToMidnight(now, this.zoneOf(unit));
    }
    const minuteTokens = c.minute.reduce((s, [, t]) => s + t, 0);
    const oldest = c.minute[0]?.[0] ?? now;
    if (limits.rpm && c.minute.length >= limits.rpm) return Math.max(1, oldest + 60_000 - now);
    // An empty minute always lets one through: a prompt over the TPM is the provider's to refuse.
    if (limits.tpm && c.minute.length && minuteTokens + tokens > limits.tpm) return Math.max(1, oldest + 60_000 - now);
    return 0;
  }

  record(unit: string, tokens: number, rate?: RateSnapshot): void {
    const c = this.counter(unit);
    const now = this.now();
    c.requestsToday += 1;
    c.tokensToday += tokens;
    c.minute.push([now, tokens]);
    if (rate) this.observe(unit, rate);
    this.scheduleSave();
  }

  /** Take the provider's word on what's left (headers on any response, 429s included). */
  observe(unit: string, rate: RateSnapshot): void {
    const c = this.counter(unit);
    if (rate.remainingRequests !== undefined) c.headerRemaining = rate.remainingRequests;
    if (rate.remainingRequests === 0 && rate.resetRequestsMs) c.blockedUntil = this.now() + rate.resetRequestsMs;
  }

  usage(unit: string): { requestsToday: number; tokensToday: number; headerRemaining?: number } {
    const c = this.counter(unit);
    return { requestsToday: c.requestsToday, tokensToday: c.tokensToday, headerRemaining: c.headerRemaining };
  }

  /** Requests and tokens today across every unit of a provider (its keys, and each model on them). */
  providerToday(providerId: string): { requests: number; tokens: number } {
    let requests = 0;
    let tokens = 0;
    for (const unit of [...this.counters.keys()]) {
      if (!unit.startsWith(`${providerId}#`)) continue;
      const c = this.counter(unit);
      requests += c.requestsToday;
      tokens += c.tokensToday;
    }
    return { requests, tokens };
  }

  /** Write pending counts now (shutdown). */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.file) return;
    const out: Record<string, { day: string; requestsToday: number; tokensToday: number }> = {};
    for (const [unit, c] of this.counters) out[unit] = { day: c.day, requestsToday: c.requestsToday, tokensToday: c.tokensToday };
    try {
      writeJsonAtomicSync(this.file, out);
    } catch (e) {
      console.error(`[apibrain] couldn't save usage: ${e instanceof Error ? e.message : e}`);
    }
  }

  private scheduleSave(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 5_000);
    this.saveTimer.unref?.();
  }

  private counter(unit: string): Counter {
    const now = this.now();
    const day = dayIn(now, this.zoneOf(unit));
    let c = this.counters.get(unit);
    if (!c) this.counters.set(unit, (c = { day, requestsToday: 0, tokensToday: 0, minute: [] }));
    if (c.day !== day) Object.assign(c, { day, requestsToday: 0, tokensToday: 0 });
    const cutoff = now - 60_000;
    while (c.minute.length && c.minute[0][0] <= cutoff) c.minute.shift();
    return c;
  }
}
