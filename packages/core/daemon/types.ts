import type {
  Query,
  SDKResultSuccess,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export type SessionState = "STARTING" | "ACTIVE" | "DRAINING" | "CYCLING";

export type ModelProvider = "anthropic" | "ollama";

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
  /** Current model provider — switches to "ollama" on repeated Anthropic failures. */
  activeProvider: ModelProvider;
  /** Consecutive Anthropic API failures used to trigger the fallback threshold. */
  anthropicFailureCount: number;
};
