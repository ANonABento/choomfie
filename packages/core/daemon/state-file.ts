import { writeJsonAtomic } from "@choomfie/shared";
import { META_DIR } from "./constants.ts";
import { getErrorMessage } from "./error.ts";
import { log } from "./log.ts";
import type { MetaState } from "./types.ts";

export const DAEMON_STATE_PATH = `${META_DIR}/daemon-state.json`;

export async function writeDaemonState(state: MetaState): Promise<void> {
  const uptime =
    state.sessionStartTime > 0
      ? Math.round((Date.now() - state.sessionStartTime) / 1000)
      : 0;

  const data = {
    mode: "daemon",
    pid: process.pid,
    state: state.state,
    sessionId: state.sessionId,
    sessionUptimeSeconds: uptime,
    // null rather than omitted, so readers can tell "default" from "not reported".
    model: state.models.model ?? null,
    fallbackModel: state.models.fallbackModel ?? null,
    // What `model` actually resolved to — an alias like "opus" is resolved by
    // the SDK's bundled Claude Code, which can lag the installed CLI.
    resolvedModel: state.resolved.model,
    claudeCodeVersion: state.resolved.claudeCodeVersion,
    turns: { current: state.turnCount, threshold: state.thresholds.turnThreshold },
    // Live context size, which is what `shouldCycle` compares against the
    // threshold. Null until the first check lands. Replaces a `tokens.current`
    // that reported cumulative input tokens against this same threshold —
    // a number that measured something else entirely.
    context: {
      tokens: state.context.tokens,
      maxTokens: state.context.maxTokens,
      percentage: state.context.percentage,
      checkedAt: state.context.checkedAt,
      threshold: state.thresholds.tokenThreshold,
    },
    /** Input tokens (cache included) this session has read in. Resets each cycle. */
    cumulativeInputTokens: state.totalInputTokens,
    tokenUsageToday: state.tokenUsageToday,
    /** Per-model token and cost breakdown for this session. */
    modelUsage: state.modelUsage,
    /** Plan rate-limit windows. Null on an API-key account, or before the first event. */
    rateLimit: state.rateLimit,
    costUsd: state.totalCostUsd,
    totalCycles: state.totalCycles,
    lastCycleReason: state.lastCycleReason,
    /** A threshold was crossed and the cycle is waiting for the session to go idle. */
    pendingCycleReason: state.pendingCycleReason,
    workerHealth: {
      processAlive: state.workerHealth.processAlive,
      lastHealthyAt: state.workerHealth.lastHealthyAt || null,
      consecutiveFailures: state.workerHealth.consecutiveFailures,
    },
    /** The Choomfie chat this session holds — the worker keeps the record, keyed by `id`. */
    chat: {
      id: state.chat.id,
      cwd: state.chat.cwd,
      sdkSessionId: state.chat.sdkSessionId,
    },
    updatedAt: new Date().toISOString(),
  };

  try {
    await writeJsonAtomic(DAEMON_STATE_PATH, data);
  } catch (error: unknown) {
    log(`Failed to write daemon state: ${getErrorMessage(error)}`);
  }
}
