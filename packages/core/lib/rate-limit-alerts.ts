/**
 * Telling the owner, in Discord, that the plan limit is close or spent.
 *
 * The daemon already knows: every `rate_limit_event` lands in
 * `meta/daemon-state.json`. Nothing read it but `/usage`, so the only way to
 * learn you were at 97% was to go and ask.
 *
 * This poller lives in the **worker**, not the daemon, and that is the whole
 * design. The daemon's only route to Discord is to push a message into the
 * Claude session and have it call the `reply` tool — the exact path that stops
 * working when requests are being refused. The worker reads the state file
 * directly and DMs through discord.js, so the "you are rate limited" message
 * still goes out when the session is the thing that's broken.
 *
 * Foreground mode gates itself: `readDaemonStatus` returns null when no live
 * daemon owns the PID file, so this quietly does nothing.
 */

import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "@choomfie/shared";
import {
  isRateLimitStale,
  peakUtilization,
  readDaemonStatus,
  viewRateLimitWindows,
  type RateLimitWindowView,
} from "./daemon-status.ts";
import type { AppContext } from "./types.ts";

/** Warn once the tightest live window crosses this. */
export const WARN_THRESHOLD = 0.9;

const POLL_INTERVAL_MS = 60_000;

const WINDOW_ORDER = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"];

const WINDOW_LABELS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "Weekly",
  seven_day_opus: "Weekly (Opus)",
  seven_day_sonnet: "Weekly (Sonnet)",
};

export type AlertLevel = "warning" | "rejected";

/**
 * What we last told the owner.
 *
 * Persisted rather than held in memory because the worker is disposable — it is
 * respawned on every session cycle, and an in-memory flag would mean a fresh
 * "you're at 94%" DM after each one.
 */
export interface AlertRecord {
  level: AlertLevel;
  /** Window name + reset time: a rolled-over window earns a new alert. */
  key: string;
  notifiedAt: number;
}

function alertStatePath(dataDir: string): string {
  return `${dataDir}/meta/rate-limit-alert.json`;
}

function windowLabel(name: string): string {
  return WINDOW_LABELS[name] ?? name.replace(/_/g, " ");
}

/**
 * The alert a snapshot deserves, or null for "nothing to say".
 *
 * Exported for tests: the decision is the part worth pinning down, and it is
 * pure — no clock, no filesystem, no Discord.
 */
export function decideAlert(
  windows: RateLimitWindowView[],
  status: string | null | undefined,
  stale: boolean,
): { level: AlertLevel; key: string; window: RateLimitWindowView } | null {
  // A stale snapshot describes a window that may have rolled over since. Acting
  // on it is how `/usage` came to report "rate limited" eleven hours after the
  // fact — don't repeat that in a DM the owner can't dismiss.
  if (stale) return null;

  const live = windows.filter((w) => !w.expired);
  if (live.length === 0) return null;

  // Report against the window actually driving the limit, not the first one.
  const tightest = live.reduce((a, b) => (b.utilization > a.utilization ? b : a));
  const key = `${tightest.name}:${tightest.resetsAt ?? "unknown"}`;

  if (status === "rejected") return { level: "rejected", key, window: tightest };

  const peak = peakUtilization(windows);
  if (peak !== null && peak >= WARN_THRESHOLD) {
    return { level: "warning", key, window: tightest };
  }
  return null;
}

/** True when this alert says something the last one didn't. */
export function shouldNotify(
  decision: { level: AlertLevel; key: string },
  last: AlertRecord | null,
): boolean {
  if (!last) return true;
  // A new window (or a different one now binding) is new information.
  if (last.key !== decision.key) return true;
  // Escalation is worth a second message; the same level again is not.
  return last.level !== decision.level && decision.level === "rejected";
}

export function buildAlertMessage(
  level: AlertLevel,
  window: RateLimitWindowView,
): string {
  const label = windowLabel(window.name);
  const resets = window.resetsAt
    ? ` Resets <t:${Math.floor(window.resetsAt)}:R>.`
    : "";

  if (level === "rejected") {
    return (
      `🛑 **Rate limited** — the ${label} window is spent.${resets}\n` +
      "I won't be able to answer until it resets, and messages sent meanwhile " +
      "won't be queued. `/usage` for the full picture."
    );
  }
  return (
    `⚠️ **${label} limit at ${(window.utilization * 100).toFixed(0)}%**.${resets}\n` +
    "Still working, but worth pacing — `/usage` for the full picture."
  );
}

async function readLastAlert(dataDir: string): Promise<AlertRecord | null> {
  try {
    const parsed = JSON.parse(
      await readFile(alertStatePath(dataDir), "utf-8"),
    ) as AlertRecord;
    return parsed && typeof parsed.key === "string" ? parsed : null;
  } catch {
    // Never alerted, or the file is unreadable. Treating that as "not yet
    // alerted" risks one duplicate DM; treating it as "already alerted" would
    // swallow the real one.
    return null;
  }
}

async function dmOwner(ctx: AppContext, message: string): Promise<boolean> {
  if (!ctx.ownerUserId) return false;
  try {
    const user = await ctx.discord.users.fetch(ctx.ownerUserId);
    await user.send(message);
    return true;
  } catch {
    // Owner has DMs closed, or the gateway is down. Nothing to escalate to.
    return false;
  }
}

/** One poll. Exported so a test can drive it without a timer. */
export async function checkRateLimit(
  ctx: AppContext,
  now: number = Date.now(),
): Promise<void> {
  const daemon = await readDaemonStatus(ctx.DATA_DIR);
  const rateLimit = daemon?.rateLimit;
  if (!rateLimit) return;

  const windows = viewRateLimitWindows(rateLimit, WINDOW_ORDER, now);
  const decision = decideAlert(
    windows,
    rateLimit.status,
    isRateLimitStale(rateLimit, now),
  );

  const last = await readLastAlert(ctx.DATA_DIR);

  if (!decision) {
    // Back under the threshold, or the window rolled over. Forget the last
    // alert so the next crossing is announced instead of being deduped away.
    if (last) {
      try {
        await writeJsonAtomic(alertStatePath(ctx.DATA_DIR), null);
      } catch {
        // Clearing is best-effort; worst case one alert is missed.
      }
    }
    return;
  }

  if (!shouldNotify(decision, last)) return;

  const sent = await dmOwner(ctx, buildAlertMessage(decision.level, decision.window));
  // Only record what actually arrived — a DM that failed to send must not
  // suppress the retry on the next poll.
  if (!sent) return;

  const record: AlertRecord = {
    level: decision.level,
    key: decision.key,
    notifiedAt: now,
  };
  try {
    await writeJsonAtomic(alertStatePath(ctx.DATA_DIR), record);
  } catch {
    // Unwritable data dir: the alert was delivered, so a possible duplicate on
    // the next poll is the better failure.
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startRateLimitAlerts(ctx: AppContext): void {
  stopRateLimitAlerts();
  timer = setInterval(() => {
    void checkRateLimit(ctx).catch(() => {
      // A poller that throws must never take the worker with it.
    });
  }, POLL_INTERVAL_MS);
  timer.unref?.();
}

export function stopRateLimitAlerts(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
