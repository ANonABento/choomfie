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
    turns: { current: state.turnCount, threshold: state.thresholds.turnThreshold },
    tokens: {
      current: state.totalInputTokens,
      threshold: state.thresholds.tokenThreshold,
    },
    tokenUsageToday: state.tokenUsageToday,
    costUsd: state.totalCostUsd,
    totalCycles: state.totalCycles,
    lastCycleReason: state.lastCycleReason,
    workerHealth: {
      processAlive: state.workerHealth.processAlive,
      lastHealthyAt: state.workerHealth.lastHealthyAt || null,
      consecutiveFailures: state.workerHealth.consecutiveFailures,
    },
    updatedAt: new Date().toISOString(),
  };

  try {
    await writeJsonAtomic(DAEMON_STATE_PATH, data);
  } catch (error: unknown) {
    log(`Failed to write daemon state: ${getErrorMessage(error)}`);
  }
}
