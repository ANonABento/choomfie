import type {
  Query,
  SDKResultSuccess,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export type SessionState = "STARTING" | "ACTIVE" | "DRAINING" | "CYCLING";

/**
 * Session-cycling thresholds, resolved from config.json by the entry point.
 * Threaded through state so daemon/ never has to import core's lib/.
 */
export type DaemonThresholds = {
  tokenThreshold: number;
  turnThreshold: number;
};

/** Which model daemon sessions run on. Empty = the Agent SDK's own default. */
export type ModelSettings = {
  model?: string;
  fallbackModel?: string;
};

/** Everything daemon/ needs from config.json, resolved by the entry point. */
export type DaemonSettings = DaemonThresholds & ModelSettings;

export type HandoffEntry = {
  sessionId: string;
  timestamp: string;
  summary: string;
  tokenCount: number;
  turnCount: number;
  costUsd: number;
};

export type WorkerHealthStatus = {
  processAlive: boolean;
  lastHealthyAt: number;
  consecutiveFailures: number;
};

export type TokenUsageToday = {
  date: string;
  inputTokens: number;
};

export type MetaState = {
  state: SessionState;
  session: Query | null;
  sessionId: string;
  turnCount: number;
  totalInputTokens: number;
  tokenUsageToday: TokenUsageToday;
  totalCostUsd: number;
  sessionStartTime: number;
  messageQueue: SDKUserMessage[];
  contextCheckTimer: ReturnType<typeof setInterval> | null;
  contextCheckFailures: number;
  restartBackoff: number;
  pushMessage: ((msg: SDKUserMessage) => void) | null;
  closeGenerator: (() => void) | null;
  resultWaiters: Array<(result: SDKResultSuccess) => void>;
  lastAssistantText: string | null;
  workerHealth: WorkerHealthStatus;
  workerHealthTimer: ReturnType<typeof setInterval> | null;
  totalCycles: number;
  lastCycleReason: string | null;
  /** Cycling thresholds for this run, from config.json. */
  thresholds: DaemonThresholds;
  /** Model settings for this run, from config.json. Applied to every session. */
  models: ModelSettings;
};
