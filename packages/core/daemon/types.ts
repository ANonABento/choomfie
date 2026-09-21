import type {
  ModelUsage,
  Query,
  SDKResultSuccess,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { DaemonControlCommand } from "@choomfie/shared";
import type { RateLimitSnapshot } from "./rate-limit.ts";

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

/**
 * Last reading from `getContextUsage()` — the live size of the session's
 * context, which is what the cycling threshold is compared against. Distinct
 * from `totalInputTokens`, which only ever grows.
 *
 * All null until the first context check lands (~60s into a session).
 */
export type ContextUsage = {
  tokens: number | null;
  maxTokens: number | null;
  percentage: number | null;
  checkedAt: number | null;
};

/** Extras for a cycle someone asked for, rather than one a threshold caused. */
export type CycleOptions = {
  /** Start the next session with no handoff summary — `/clear`, not `/compact`. */
  skipHandoff?: boolean;
  /** Discord channel to confirm in once the replacement session is up. */
  announceTo?: string;
  /** Which command asked, so the confirmation can say what actually happened. */
  requestedCommand?: DaemonControlCommand;
};

export type StartSessionOptions = Pick<
  CycleOptions,
  "announceTo" | "requestedCommand"
>;

export type MetaState = {
  state: SessionState;
  session: Query | null;
  sessionId: string;
  turnCount: number;
  totalInputTokens: number;
  tokenUsageToday: TokenUsageToday;
  totalCostUsd: number;
  sessionStartTime: number;
  contextCheckTimer: ReturnType<typeof setInterval> | null;
  contextCheckFailures: number;
  restartBackoff: number;
  pushMessage: ((msg: SDKUserMessage) => void) | null;
  closeGenerator: (() => void) | null;
  resultWaiters: Array<(result: SDKResultSuccess) => void>;
  lastAssistantText: string | null;
  workerHealth: WorkerHealthStatus;
  workerHealthTimer: ReturnType<typeof setInterval> | null;
  /** Last live context reading, for the state file and the cycling decision. */
  context: ContextUsage;
  /** Latest per-model usage snapshot for this session (cumulative, not a delta). */
  modelUsage: Record<string, ModelUsage>;
  /**
   * Latest plan rate-limit windows. Account-level, so it survives session
   * cycles — null only until the first `rate_limit_event` arrives, and always
   * null on an API-key account, which has no plan windows.
   */
  rateLimit: RateLimitSnapshot | null;
  /** Polls for `/compact` and `/clear` requests from the worker. */
  controlTimer: ReturnType<typeof setInterval> | null;
  /** Polls `meta/incoming` for inbound Discord messages from the worker. */
  incomingTimer: ReturnType<typeof setInterval> | null;
  totalCycles: number;
  lastCycleReason: string | null;
  /** Cycling thresholds for this run, from config.json. */
  thresholds: DaemonThresholds;
  /** Model settings for this run, from config.json. Applied to every session. */
  models: ModelSettings;
};
