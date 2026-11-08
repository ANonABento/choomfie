import type {
  ModelUsage,
  Query,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { RateLimitSnapshot } from "./rate-limit.ts";

export type SessionState = "STARTING" | "ACTIVE" | "CYCLING";

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
  /** Reasoning effort (`low` … `max`); unset = Claude Code's default. */
  effort?: string;
};

/** Everything daemon/ needs from config.json, resolved by the entry point. */
export type DaemonSettings = DaemonThresholds &
  ModelSettings & {
    /** Most Claude sessions running at once; idle ones close first. */
    maxSessions: number;
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

/** The Choomfie chat a session holds. The worker keeps the record (SQLite). */
export type SessionChat = {
  id: string;
  cwd: string;
  /** The live SDK session's id, from its `system/init`. Null until the first prompt. */
  sdkSessionId: string | null;
};

/** One Agent SDK session's state: what it is running and what it has used. */
export type MetaState = {
  state: SessionState;
  session: Query | null;
  turnCount: number;
  totalInputTokens: number;
  tokenUsageToday: TokenUsageToday;
  totalCostUsd: number;
  sessionStartTime: number;
  pushMessage: ((msg: SDKUserMessage) => void) | null;
  closeGenerator: (() => void) | null;
  resultWaiters: Array<(result: SDKResultMessage) => void>;
  lastAssistantText: string | null;
  /** Last live context reading, for the state file and the cycling decision. */
  context: ContextUsage;
  /** Latest per-model usage snapshot for this session (cumulative, not a delta). */
  modelUsage: Record<string, ModelUsage>;
  /**
   * Latest plan rate-limit windows. Account-level, so a compact keeps it —
   * null only until the first `rate_limit_event` arrives, and always null on
   * an API-key account, which has no plan windows.
   */
  rateLimit: RateLimitSnapshot | null;
  totalCycles: number;
  lastCycleReason: string | null;
  /**
   * A prompt has been pushed (or the model is producing output) and no `result`
   * has closed it yet. Cleared by every result, success or error.
   */
  turnInFlight: boolean;
  /** Last prompt pushed or stream message received — the idle debounce clock. */
  lastActivityAt: number;
  /**
   * A soft threshold was crossed; the compact waits for the session to go idle.
   * Holds the reason it will be recorded under. Null when nothing is pending.
   */
  pendingCycleReason: string | null;
  /** Cycling thresholds for this run, from config.json. */
  thresholds: DaemonThresholds;
  /** Model settings for this run, from config.json. Applied to every session. */
  models: ModelSettings;
  /**
   * What the session actually runs, from its `system/init` message. `models.model`
   * may be an alias ("opus") resolved by the SDK's bundled Claude Code, so this
   * is the only place the real model shows up. Null until init arrives.
   */
  resolved: { model: string | null; claudeCodeVersion: string | null };
  chat: SessionChat;
};
