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
