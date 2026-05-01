import { writeFile } from "node:fs/promises";
import { META_DIR, TOKEN_THRESHOLD, TURN_THRESHOLD } from "./constants.ts";
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
    turns: { current: state.turnCount, threshold: TURN_THRESHOLD },
    tokens: { current: state.totalInputTokens, threshold: TOKEN_THRESHOLD },
    tokenUsageToday: state.tokenUsageToday,
    costUsd: state.totalCostUsd,
    totalCycles: state.totalCycles,
    lastCycleReason: state.lastCycleReason,
    workerHealth: {
      processAlive: state.workerHealth.processAlive,
      lastHealthyAt: state.workerHealth.lastHealthyAt || null,
      consecutiveFailures: state.workerHealth.consecutiveFailures,
    },
    activeProvider: state.activeProvider,
    updatedAt: new Date().toISOString(),
  };

  try {
    await writeFile(DAEMON_STATE_PATH, JSON.stringify(data, null, 2));
  } catch (error: unknown) {
    log(`Failed to write daemon state: ${getErrorMessage(error)}`);
  }
}
