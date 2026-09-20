import { unlink } from "node:fs/promises";
import { INITIAL_RESTART_BACKOFF } from "./constants.ts";
import { log } from "./log.ts";
import { releasePid } from "./pid.ts";
import { generateSessionId } from "./session-core.ts";
import { DAEMON_STATE_PATH } from "./state-file.ts";
import type { DaemonSettings, MetaState } from "./types.ts";

export function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function createInitialState(settings: DaemonSettings): MetaState {
  const { tokenThreshold, turnThreshold, model, fallbackModel } = settings;
  return {
    state: "STARTING",
    session: null,
    sessionId: generateSessionId(),
    turnCount: 0,
    totalInputTokens: 0,
    tokenUsageToday: { date: todayKey(), inputTokens: 0 },
    totalCostUsd: 0,
    sessionStartTime: 0,
    contextCheckTimer: null,
    contextCheckFailures: 0,
    restartBackoff: INITIAL_RESTART_BACKOFF,
    pushMessage: null,
    closeGenerator: null,
    resultWaiters: [],
    lastAssistantText: null,
    workerHealth: {
      processAlive: false,
      lastHealthyAt: 0,
      consecutiveFailures: 0,
    },
    workerHealthTimer: null,
    context: { tokens: null, maxTokens: null, percentage: null, checkedAt: null },
    modelUsage: {},
    rateLimit: null,
    controlTimer: null,
    totalCycles: 0,
    lastCycleReason: null,
    thresholds: { tokenThreshold, turnThreshold },
    models: { model, fallbackModel },
  };
}

export async function cleanup(state: MetaState): Promise<void> {
  if (state.workerHealthTimer) {
    clearInterval(state.workerHealthTimer);
    state.workerHealthTimer = null;
  }
  if (state.contextCheckTimer) {
    clearInterval(state.contextCheckTimer);
    state.contextCheckTimer = null;
  }
  if (state.controlTimer) {
    clearInterval(state.controlTimer);
    state.controlTimer = null;
  }
  try {
    state.closeGenerator?.();
    state.session?.close();
  } catch {
    // Best-effort session cleanup.
  }
  try {
    await unlink(DAEMON_STATE_PATH);
  } catch {
    // State file already removed.
  }
  await releasePid();
}

export function setupShutdown(state: MetaState): void {
  let shutdownCalled = false;

  const shutdown = async () => {
    if (shutdownCalled) return;
    shutdownCalled = true;
    log("Shutting down...");
    await cleanup(state);
    log("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);
}
