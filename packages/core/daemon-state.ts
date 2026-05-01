import { writeFile } from "node:fs/promises";
import type { MetaState } from "./daemon-types.ts";

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function createInitialState(
  generateSessionId: () => string,
  initialRestartBackoff: number,
): MetaState {
  return {
    state: "STARTING",
    session: null,
    sessionId: generateSessionId(),
    turnCount: 0,
    totalInputTokens: 0,
    tokenUsageToday: { date: todayKey(), inputTokens: 0 },
    totalCostUsd: 0,
    sessionStartTime: 0,
    messageQueue: [],
    contextCheckTimer: null,
    contextCheckFailures: 0,
    restartBackoff: initialRestartBackoff,
    pushMessage: null,
    closeGenerator: null,
    restartTask: null,
    resultWaiters: [],
    lastAssistantText: null,
    workerHealth: {
      processAlive: false,
      lastHealthyAt: 0,
      consecutiveFailures: 0,
    },
    workerHealthTimer: null,
    totalCycles: 0,
    lastCycleReason: null,
  };
}

export async function writeDaemonState(
  state: MetaState,
  opts: {
    metaDir: string;
    tokenThreshold: number;
    turnThreshold: number;
    log: (msg: string) => void;
  },
): Promise<void> {
  const uptime = state.sessionStartTime > 0
    ? Math.round((Date.now() - state.sessionStartTime) / 1000)
    : 0;

  const data = {
    mode: "daemon",
    pid: process.pid,
    state: state.state,
    sessionId: state.sessionId,
    sessionUptimeSeconds: uptime,
    turns: { current: state.turnCount, threshold: opts.turnThreshold },
    tokens: { current: state.totalInputTokens, threshold: opts.tokenThreshold },
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
    await writeFile(`${opts.metaDir}/daemon-state.json`, JSON.stringify(data, null, 2));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    opts.log(`Failed to write daemon state: ${message}`);
  }
}
