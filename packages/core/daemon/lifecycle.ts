import type { DaemonSettings, MetaState, SessionChat } from "./types.ts";

/** Local calendar date (YYYY-MM-DD): "today" should roll over at your midnight, not UTC's. */
export function todayKey(): string {
  return new Date().toLocaleDateString("en-CA");
}

export function createInitialState(
  settings: DaemonSettings,
  chat: Omit<SessionChat, "sdkSessionId">
): MetaState {
  const { tokenThreshold, turnThreshold, model, fallbackModel } = settings;
  return {
    state: "STARTING",
    session: null,
    turnCount: 0,
    totalInputTokens: 0,
    tokenUsageToday: { date: todayKey(), inputTokens: 0 },
    totalCostUsd: 0,
    sessionStartTime: 0,
    pushMessage: null,
    closeGenerator: null,
    resultWaiters: [],
    lastAssistantText: null,
    context: { tokens: null, maxTokens: null, percentage: null, checkedAt: null },
    modelUsage: {},
    rateLimit: null,
    totalCycles: 0,
    lastCycleReason: null,
    turnInFlight: false,
    lastActivityAt: 0,
    pendingCycleReason: null,
    thresholds: { tokenThreshold, turnThreshold },
    models: { model, fallbackModel },
    resolved: { model: null, claudeCodeVersion: null },
    chat: { ...chat, sdkSessionId: null },
  };
}
