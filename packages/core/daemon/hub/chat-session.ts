/**
 * One Claude chat's Agent SDK session in the hub's pool.
 *
 * Reuses the single-session runtime's per-state pieces (usage and rate-limit
 * accounting, handoff summaries, cycle thresholds) on a MetaState of its own.
 * What differs: no plugin (tools come from the hub's endpoint), no monitors of
 * its own beyond context, and a cycle keeps the same chat — the summary seeds
 * the new session, and the chat's backendRef moves to the new SDK session.
 */

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  CONTEXT_CHECK_INTERVAL,
  CYCLE_IDLE_DEBOUNCE_MS,
  INITIAL_RESTART_BACKOFF,
  MAX_RESTART_BACKOFF,
  PLUGIN_DIR,
} from "../constants.ts";
import { getErrorMessage } from "../error.ts";
import { createInitialState } from "../lifecycle.ts";
import { createMessageGenerator } from "../message-generator.ts";
import { captureHandoffSummary, handleSessionMessage, hardCeiling, shouldCycle } from "../runtime.ts";
import { createSession, isUnrecoverableAnthropicError } from "../session-core.ts";
import type { DaemonSettings, MetaState } from "../types.ts";
import type { LiveSession, PoolChat } from "./pool.ts";

/** Give up on a session after this many stream failures in a row. */
const MAX_STREAM_RETRIES = 5;

export interface ChatSessionDeps {
  location: string;
  chat: PoolChat;
  settings: DaemonSettings;
  mcp: { url: string; token: string };
  /** Summary a chat's latest session started with (system prompt, not in the transcript). */
  seed(chatId: string): string | undefined;
  setSeed(chatId: string, summary: string | undefined): void;
  /**
   * The SDK reported this chat's session id — store it as the chat's
   * backendRef. Null after a compact: the next session starts from the seed.
   */
  onSessionId(chatId: string, sdkSessionId: string | null): void;
  /** Input tokens this session just used, for the daemon's daily total. */
  onUsage(inputTokens: number): void;
  log(message: string): void;
}

export class ChatSession implements LiveSession {
  readonly chatId: string;
  readonly state: MetaState;
  readonly location: string;
  readonly title: string;
  private closed = false;
  private failed = false;
  private failures = 0;
  private reportedSessionId: string | null = null;
  private contextTimer: ReturnType<typeof setInterval> | null = null;
  private compacting = false;

  constructor(private readonly deps: ChatSessionDeps) {
    this.chatId = deps.chat.id;
    this.location = deps.location;
    this.title = deps.chat.title;
    this.state = createInitialState(deps.settings, {
      current: { id: deps.chat.id, cwd: deps.chat.cwd ?? PLUGIN_DIR },
      seeds: {},
    });
    this.reportedSessionId = deps.chat.backendRef;
  }

  /** Open the session: resume the chat's SDK session if it has one. */
  start(): this {
    const resume = this.deps.chat.backendRef ?? undefined;
    this.open(resume, resume ? this.deps.seed(this.chatId) : undefined);
    this.contextTimer = setInterval(() => void this.checkContext(), CONTEXT_CHECK_INTERVAL);
    return this;
  }

  private open(resume: string | undefined, summary: string | undefined) {
    const s = this.state;
    s.state = "STARTING";
    s.turnCount = 0;
    s.totalInputTokens = 0;
    s.totalCostUsd = 0;
    s.sessionStartTime = Date.now();
    s.lastAssistantText = null;
    s.resultWaiters = [];
    s.context = { tokens: null, maxTokens: null, percentage: null, checkedAt: null };
    s.modelUsage = {};
    s.turnInFlight = false;
    s.lastActivityAt = Date.now();
    s.pendingCycleReason = null;

    const { generator, push: enqueue, close } = createMessageGenerator();
    s.pushMessage = (msg: SDKUserMessage) => {
      s.turnInFlight = true;
      s.lastActivityAt = Date.now();
      enqueue(msg);
    };
    s.closeGenerator = close;
    const query = createSession(generator, summary, s.models, { cwd: s.chat.cwd, resume, mcp: this.deps.mcp });
    s.session = query;
    s.state = "ACTIVE";
    void this.consume(query);
  }

  private async consume(query: NonNullable<MetaState["session"]>) {
    try {
      for await (const message of query) {
        const before = this.usageToday();
        handleSessionMessage(this.state, message);
        const used = this.usageToday() - before;
        if (used > 0) this.deps.onUsage(used);
        const sid = this.state.chat.sdkSessionId;
        if (sid && sid !== this.reportedSessionId) {
          this.reportedSessionId = sid;
          this.deps.onSessionId(this.chatId, sid);
        }
        if (message.type === "result") this.failures = 0;
      }
    } catch (error: unknown) {
      if (this.closed || this.state.session !== query) return;
      await this.recover(error);
    }
  }

  private usageToday(): number {
    return this.state.tokenUsageToday.inputTokens;
  }

  /** The stream broke: reopen on the same SDK session, backing off; give up on auth/billing. */
  private async recover(error: unknown) {
    this.failures++;
    const unrecoverable = isUnrecoverableAnthropicError(error);
    this.deps.log(`"${this.title}": session failed: ${getErrorMessage(error)} (${this.failures}/${MAX_STREAM_RETRIES})`);
    this.teardownQuery();
    if (unrecoverable || this.failures >= MAX_STREAM_RETRIES) {
      this.failed = true;
      this.deps.log(`"${this.title}": giving up${unrecoverable ? " (auth or billing — re-login or check the plan)" : ""}`);
      return;
    }
    const delay = Math.min(INITIAL_RESTART_BACKOFF * 2 ** (this.failures - 1), MAX_RESTART_BACKOFF);
    await new Promise((r) => setTimeout(r, delay));
    if (this.closed) return;
    const resume = this.state.chat.sdkSessionId ?? this.deps.chat.backendRef ?? undefined;
    this.open(resume, resume ? this.deps.seed(this.chatId) : undefined);
  }

  private teardownQuery() {
    const s = this.state;
    try {
      s.closeGenerator?.();
      s.session?.close();
    } catch {
      // Best effort.
    }
    s.session = null;
    s.pushMessage = null;
    s.closeGenerator = null;
    s.resultWaiters = [];
    s.turnInFlight = false;
  }

  private async checkContext() {
    const s = this.state;
    if (s.state !== "ACTIVE" || !s.session || this.compacting) return;
    try {
      const usage = await s.session.getContextUsage();
      s.context = { tokens: usage.totalTokens, maxTokens: usage.maxTokens, percentage: usage.percentage, checkedAt: Date.now() };
      if (usage.totalTokens >= hardCeiling(s)) {
        s.lastCycleReason = "token_ceiling";
        await this.compact();
        return;
      }
      if (!s.pendingCycleReason && shouldCycle(s, usage.totalTokens)) {
        s.pendingCycleReason = s.turnCount >= s.thresholds.turnThreshold ? "turn_threshold" : "token_threshold";
        this.deps.log(`"${this.title}": ${s.pendingCycleReason} — cycling once idle`);
      }
    } catch (error: unknown) {
      if (!s.pendingCycleReason && shouldCycle(s)) s.pendingCycleReason = "turn_threshold_fallback";
      this.deps.log(`"${this.title}": context check failed: ${getErrorMessage(error)}`);
    }
    if (s.pendingCycleReason && !s.turnInFlight && Date.now() - s.lastActivityAt >= CYCLE_IDLE_DEBOUNCE_MS) {
      s.lastCycleReason = s.pendingCycleReason;
      await this.compact();
    }
  }

  busy(): boolean {
    return this.state.turnInFlight || this.compacting;
  }

  dead(): boolean {
    return this.failed;
  }

  lastActivityAt(): number {
    return this.state.lastActivityAt;
  }

  push(content: string): void {
    if (!this.state.pushMessage) {
      this.deps.log(`"${this.title}": no live session — message dropped`);
      return;
    }
    this.state.pushMessage({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
  }

  async interrupt(): Promise<boolean> {
    if (!this.state.turnInFlight || !this.state.session) return false;
    await this.state.session.interrupt();
    return true;
  }

  /** Summarise, then start a fresh session on the same chat seeded with the summary. */
  async compact(announceTo?: string): Promise<void> {
    if (this.compacting || this.closed || !this.state.session) return;
    this.compacting = true;
    try {
      this.deps.log(`"${this.title}": compacting (${this.state.lastCycleReason ?? "requested"})`);
      const summary = await captureHandoffSummary(this.state);
      this.teardownQuery();
      this.state.totalCycles++;
      this.state.chat.sdkSessionId = null;
      // The new SDK session gets its id on its first prompt. Until then a
      // resume must not reload the long transcript this compact just dropped.
      this.reportedSessionId = null;
      this.deps.onSessionId(this.chatId, null);
      this.deps.setSeed(this.chatId, summary);
      if (this.closed) return;
      this.open(undefined, summary);
      if (announceTo) {
        this.push(
          "A /compact was just requested from Discord and your session has been replaced. " +
            "The handoff summary above is what carried over. " +
            `Post a brief, casual message in channel ${announceTo} confirming you're back. ` +
            "Use the reply tool with that channel_id. Keep it to one line."
        );
      }
    } finally {
      this.compacting = false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.contextTimer) clearInterval(this.contextTimer);
    this.contextTimer = null;
    this.teardownQuery();
    this.state.state = "CYCLING";
  }
}
