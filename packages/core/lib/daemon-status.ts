/**
 * Reading the daemon's state file from the worker.
 *
 * The worker cannot ask the daemon anything directly — the daemon is two
 * processes above it (daemon → Agent SDK → claude CLI → supervisor → worker).
 * `meta/daemon-state.json` is the daemon's side of that one-way channel;
 * `meta/control.json` (written by `requestDaemonControl` below) is the worker's.
 */

import { readFile } from "node:fs/promises";
import {
  daemonControlPath,
  readLiveDaemonPid,
  writeJsonAtomic,
  type DaemonControlCommand,
  type DaemonControlRequest,
} from "@choomfie/shared";

/** The subset of the state file anything here reads. */
export interface DaemonSnapshot {
  pid?: number;
  state?: string;
  sessionId?: string;
  sessionUptimeSeconds?: number;
  model?: string | null;
  fallbackModel?: string | null;
  turns?: { current?: number; threshold?: number };
  context?: {
    tokens?: number | null;
    maxTokens?: number | null;
    percentage?: number | null;
    checkedAt?: number | null;
    threshold?: number;
  };
  cumulativeInputTokens?: number;
  tokenUsageToday?: { date?: string; inputTokens?: number };
  modelUsage?: Record<string, ModelUsageSnapshot>;
  rateLimit?: RateLimitSnapshot | null;
  costUsd?: number;
  totalCycles?: number;
  lastCycleReason?: string | null;
  workerHealth?: { processAlive?: boolean };
  updatedAt?: string;
}

export interface ModelUsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
}

export interface RateLimitWindowSnapshot {
  utilization?: number;
  resetsAt?: number | null;
}

export interface RateLimitSnapshot {
  status?: string | null;
  windows?: Record<string, RateLimitWindowSnapshot>;
  tightest?: string | null;
  isUsingOverage?: boolean;
  overageStatus?: string | null;
  updatedAt?: number;
}

function daemonPidPath(dataDir: string): string {
  return `${dataDir}/meta/meta.pid`;
}

/**
 * How old a rate-limit snapshot may be before it stops being evidence.
 *
 * The daemon only learns its utilization from a `rate_limit_event`, which the
 * SDK sends on a turn. An idle session takes no turns, so the snapshot ages:
 * observed 10.9h old on a session that had handled 4 messages overnight. Past
 * this, the numbers describe a window that may have rolled over since.
 */
export const RATE_LIMIT_STALE_MS = 30 * 60 * 1000;

/** One window, read with its reset time taken into account. */
export interface RateLimitWindowView {
  name: string;
  utilization: number;
  resetsAt: number | null;
  /**
   * The reset time has passed, so `utilization` describes the *previous*
   * window. Reported at 97% with a reset two hours gone, the plain number reads
   * as "still nearly out" when the true answer is "reset, and unknown until the
   * next turn".
   */
  expired: boolean;
}

/**
 * Windows in a fixed order, each tagged with whether its reset has passed.
 *
 * `resetsAt` is unix *seconds* from the SDK; `now` is ms, so the comparison
 * scales it rather than the other way round — Discord's `<t:>` wants the
 * seconds back unscaled.
 */
export function viewRateLimitWindows(
  rateLimit: RateLimitSnapshot | null | undefined,
  order: readonly string[] = [],
  now: number = Date.now(),
): RateLimitWindowView[] {
  const entries = Object.entries(rateLimit?.windows ?? {});
  const rank = (name: string) => {
    const index = order.indexOf(name);
    return index === -1 ? order.length : index;
  };
  return entries
    .filter(([, w]) => typeof w.utilization === "number")
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([name, w]) => ({
      name,
      utilization: w.utilization!,
      resetsAt: w.resetsAt ?? null,
      expired: w.resetsAt != null && w.resetsAt * 1000 <= now,
    }));
}

/** True when the snapshot is too old to describe the present. */
export function isRateLimitStale(
  rateLimit: RateLimitSnapshot | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!rateLimit?.updatedAt) return false;
  return now - rateLimit.updatedAt > RATE_LIMIT_STALE_MS;
}

/**
 * Highest utilization across windows that still describe the current period.
 * Returns null when every window has expired — "we don't know" rather than 0,
 * which would read as "plenty left".
 */
export function peakUtilization(views: RateLimitWindowView[]): number | null {
  const live = views.filter((w) => !w.expired);
  if (live.length === 0) return null;
  return Math.max(...live.map((w) => w.utilization));
}

/**
 * The daemon's current state, or null when Choomfie is running in foreground
 * mode.
 *
 * The PID check is the point: the state file is left behind by an unclean
 * shutdown, and reporting a dead daemon's last known turn count as live is
 * worse than reporting nothing. `readLiveDaemonPid` matches on the daemon entry
 * point, so a recycled PID belonging to some unrelated process won't pass.
 */
export async function readDaemonStatus(
  dataDir: string,
): Promise<DaemonSnapshot | null> {
  if ((await readLiveDaemonPid(daemonPidPath(dataDir))) === null) return null;

  try {
    const snapshot = JSON.parse(
      await readFile(`${dataDir}/meta/daemon-state.json`, "utf-8"),
    ) as DaemonSnapshot;
    return snapshot && typeof snapshot === "object" ? snapshot : null;
  } catch {
    // Daemon is up but hasn't written state yet, or the file is mid-write.
    return null;
  }
}

/** True when a live daemon is supervising this worker. */
export async function isDaemonMode(dataDir: string): Promise<boolean> {
  return (await readLiveDaemonPid(daemonPidPath(dataDir))) !== null;
}

/**
 * Ask the daemon to compact or clear its session.
 *
 * Fire-and-forget by nature: the daemon replaces the very session that would
 * have carried a reply back, so the caller confirms optimistically and the new
 * session reports in afterwards.
 */
export async function requestDaemonControl(
  dataDir: string,
  command: DaemonControlCommand,
  opts: { requestedBy?: string; chatId?: string } = {},
): Promise<void> {
  const request: DaemonControlRequest = {
    command,
    requestedAt: Date.now(),
    requestedBy: opts.requestedBy,
    chatId: opts.chatId,
  };
  await writeJsonAtomic(daemonControlPath(dataDir), request);
}

/** Human-readable context line, e.g. "48,120 / 120,000 (37.4% of window)". */
export function formatContextUsage(snapshot: DaemonSnapshot): string {
  const context = snapshot.context;
  if (!context || context.tokens === null || context.tokens === undefined) {
    return "not measured yet";
  }
  const threshold = context.threshold
    ? ` / ${context.threshold.toLocaleString()}`
    : "";
  const share =
    context.percentage === null || context.percentage === undefined
      ? ""
      : ` (${context.percentage.toFixed(1)}% of window)`;
  return `${context.tokens.toLocaleString()}${threshold}${share}`;
}
