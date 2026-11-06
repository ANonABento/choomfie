/**
 * meta/daemon-state.json — the daemon's one-way report to the worker, read by
 * `/status`, `/usage`, the `status` tool and the rate-limit alerter
 * (`lib/daemon-status.ts` is the reader).
 *
 * Daemon-wide figures at the top level; each live session under `sessions`.
 * `turns`, `context`, `modelUsage` and the resolved model describe the most
 * recently active session, which is what a single-line summary wants.
 */

import { writeJsonAtomic } from "@choomfie/shared";
import { META_DIR } from "./constants.ts";
import { getErrorMessage } from "./error.ts";
import { log } from "./log.ts";
import type { RateLimitSnapshot } from "./rate-limit.ts";
import type { DaemonSettings, MetaState, TokenUsageToday } from "./types.ts";

export const DAEMON_STATE_PATH = `${META_DIR}/daemon-state.json`;

export interface LiveSessionState {
  location: string;
  title: string;
  busy: boolean;
  state: MetaState;
}

export interface DaemonStateInput {
  startedAt: number;
  settings: DaemonSettings;
  sessions: LiveSessionState[];
  usageToday: TokenUsageToday;
  /** Account-level: the newest any session has reported. */
  rateLimit: RateLimitSnapshot | null;
  totalCycles: number;
  worker: { alive: boolean; consecutiveFailures: number };
}

export function buildDaemonState(input: DaemonStateInput): Record<string, unknown> {
  const { settings, sessions } = input;
  const latest = sessions.reduce<MetaState | null>(
    (a, s) => (!a || s.state.lastActivityAt > a.lastActivityAt ? s.state : a),
    null
  );
  return {
    mode: "daemon",
    pid: process.pid,
    state: "ACTIVE",
    sessionUptimeSeconds: Math.round((Date.now() - input.startedAt) / 1000),
    // null rather than omitted, so readers can tell "default" from "not reported".
    model: settings.model ?? null,
    fallbackModel: settings.fallbackModel ?? null,
    // What `model` resolved to — an alias like "opus" is resolved by the SDK's
    // bundled Claude Code, which can lag the installed CLI.
    resolvedModel: latest?.resolved.model ?? null,
    claudeCodeVersion: latest?.resolved.claudeCodeVersion ?? null,
    turns: { current: latest?.turnCount ?? 0, threshold: settings.turnThreshold },
    // Live context size, which is what cycling compares against the threshold.
    context: {
      tokens: latest?.context.tokens ?? null,
      maxTokens: latest?.context.maxTokens ?? null,
      percentage: latest?.context.percentage ?? null,
      checkedAt: latest?.context.checkedAt ?? null,
      threshold: settings.tokenThreshold,
    },
    tokenUsageToday: input.usageToday,
    modelUsage: latest?.modelUsage ?? {},
    /** Plan rate-limit windows. Null on an API-key account, or before the first event. */
    rateLimit: input.rateLimit,
    costUsd: sessions.reduce((n, s) => n + s.state.totalCostUsd, 0),
    totalCycles: input.totalCycles,
    lastCycleReason: latest?.lastCycleReason ?? null,
    workerHealth: { processAlive: input.worker.alive, consecutiveFailures: input.worker.consecutiveFailures },
    maxSessions: settings.maxSessions,
    sessions: sessions.map((s) => ({
      location: s.location,
      chatId: s.state.chat.id,
      title: s.title,
      cwd: s.state.chat.cwd,
      model: s.state.models.model ?? null,
      sdkSessionId: s.state.chat.sdkSessionId,
      busy: s.busy,
      turns: s.state.turnCount,
      contextTokens: s.state.context.tokens,
      lastActivityAt: s.state.lastActivityAt,
    })),
    updatedAt: new Date().toISOString(),
  };
}

export async function writeDaemonState(data: Record<string, unknown>): Promise<void> {
  try {
    await writeJsonAtomic(DAEMON_STATE_PATH, data);
  } catch (error: unknown) {
    log(`Failed to write daemon state: ${getErrorMessage(error)}`);
  }
}
