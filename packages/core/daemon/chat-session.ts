/**
 * One Claude chat's Agent SDK session in the daemon's pool.
 *
 * Tools come from the daemon's loopback endpoint; prompts are pushed by the
 * daemon. When context gets heavy the session compacts: it writes a handoff
 * summary, and the same chat carries on in a fresh SDK session seeded with it.
 */

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { CHAT_HOME, CONTEXT_CHECK_INTERVAL, INITIAL_RESTART_BACKOFF, MAX_RESTART_BACKOFF } from "./constants.ts";
import { getErrorMessage } from "./error.ts";
import { createInitialState } from "./lifecycle.ts";
import { createMessageGenerator } from "./message-generator.ts";
import { captureHandoffSummary, handleSessionMessage, hardCeiling, isIdleForCycle, shouldCycle } from "./runtime.ts";
import { createSession, isUnrecoverableAnthropicError } from "./session-core.ts";
import type { DaemonSettings, MetaState } from "./types.ts";
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
  /** The chat compacted: its next session starts from `summary`. */
  onCompacted(chatId: string, summary: string): void;
  /**
   * The SDK reported this chat's session id — store it as the chat's
   * backendRef, along with the cwd it ran in (a resume must come back there).
   * Null after a compact: the next session starts from the seed.
   */
  onSessionId(chatId: string, sdkSessionId: string | null, cwd: string): void;
  /** Input tokens this session just used, for the daemon's daily total. */
  onUsage(inputTokens: number): void;
  /** Something the state file reports changed (rate limits, model). */
  onChange(): void;
  /**
   * Post a turn's plain final answer to Discord (the worker's `reply` tool).
   * Saves the model a round-trip per answer: calling `reply` and then ending
   * the turn is two calls, each re-reading the whole context.
   */
  postReply?(chatId: string, text: string): Promise<void>;
  log(message: string): void;
  /** Replaces the Agent SDK (tests). */
  createSession?: typeof createSession;
}

export class ChatSession implements LiveSession {
  readonly chatId: string;
  readonly model: string | null;
  readonly state: MetaState;
  readonly location: string;
  readonly title: string;
  private closed = false;
  private failed = false;
  private failures = 0;
  private reportedSessionId: string | null;
  private contextTimer: ReturnType<typeof setInterval> | null = null;
  private compacting = false;
  /** Where this turn's plain final answer goes; null = nowhere (internal prompt, conversation mode). */
  private replyTarget: string | null = null;
  /** The model already answered with `reply` this turn — its final text isn't the answer. */
  private repliedThisTurn = false;

  constructor(private readonly deps: ChatSessionDeps) {
    this.chatId = deps.chat.id;
    this.location = deps.location;
    this.title = deps.chat.title;
    this.model = deps.chat.model;
    this.state = createInitialState(
      { ...deps.settings, ...(deps.chat.model ? { model: deps.chat.model } : {}) },
      { id: deps.chat.id, cwd: deps.chat.cwd ?? CHAT_HOME }
    );
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
    // Per-session, so it resets with the session. `rateLimit` deliberately
    // does not — plan windows belong to the account.
    s.modelUsage = {};
    s.turnInFlight = false;
    s.lastActivityAt = Date.now();
    s.pendingCycleReason = null;

    const { generator, push: enqueue, close } = createMessageGenerator();
    // Every prompt opens a turn and restarts the idle clock.
    s.pushMessage = (msg: SDKUserMessage) => {
      s.turnInFlight = true;
      s.lastActivityAt = Date.now();
      enqueue(msg);
    };
    s.closeGenerator = close;
    const query = (this.deps.createSession ?? createSession)(generator, summary, s.models, {
      cwd: s.chat.cwd,
      resume,
      mcp: this.deps.mcp,
    });
    s.session = query;
    s.state = "ACTIVE";
    void this.consume(query);
  }

  private async consume(query: NonNullable<MetaState["session"]>) {
    try {
      for await (const message of query) {
        const before = this.state.tokenUsageToday.inputTokens;
        handleSessionMessage(this.state, message, this.deps.onChange);
        this.watchForAnswer(message);
        const used = this.state.tokenUsageToday.inputTokens - before;
        if (used > 0) this.deps.onUsage(used);
        const sid = this.state.chat.sdkSessionId;
        if (sid && sid !== this.reportedSessionId) {
          this.reportedSessionId = sid;
          this.deps.onSessionId(this.chatId, sid, this.state.chat.cwd);
        }
        if (message.type === "result") this.failures = 0;
      }
    } catch (error: unknown) {
      if (this.closed || this.state.session !== query) return;
      await this.recover(error);
    }
  }

  /** Post a turn's final text when the model answered without calling `reply`. */
  private watchForAnswer(message: { type: string; subtype?: string; message?: unknown; result?: unknown }) {
    if (message.type === "assistant") {
      const content = (message.message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content) && content.some((b) => b?.type === "tool_use" && /(^|__)reply$/.test(String(b.name)))) {
        this.repliedThisTurn = true;
      }
      return;
    }
    if (message.type !== "result") return;
    const target = this.replyTarget;
    const replied = this.repliedThisTurn;
    this.replyTarget = null;
    this.repliedThisTurn = false;
    const text = message.subtype === "success" && typeof message.result === "string" ? message.result.trim() : "";
    if (!target || replied || !text || !this.deps.postReply) return;
    void this.deps.postReply(target, text).catch((e: unknown) =>
      this.deps.log(`"${this.title}": couldn't post the answer: ${getErrorMessage(e)}`)
    );
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

  /**
   * Every minute: read the context size. Past the hard ceiling, compact now;
   * past a soft threshold, compact once the session has gone idle.
   *
   * Never before this session's first turn: a compact costs a paid turn, and
   * a session still over the line straight after one would otherwise compact
   * again every minute.
   */
  async checkContext(): Promise<void> {
    const s = this.state;
    if (s.state !== "ACTIVE" || !s.session || this.compacting) return;
    try {
      const usage = await s.session.getContextUsage();
      s.context = { tokens: usage.totalTokens, maxTokens: usage.maxTokens, percentage: usage.percentage, checkedAt: Date.now() };
      if (s.turnCount === 0) return;
      if (usage.totalTokens >= hardCeiling(s)) {
        s.lastCycleReason = "token_ceiling";
        await this.compact();
        return;
      }
      if (!s.pendingCycleReason && shouldCycle(s, usage.totalTokens)) {
        s.pendingCycleReason = s.turnCount >= s.thresholds.turnThreshold ? "turn_threshold" : "token_threshold";
        this.deps.log(`"${this.title}": ${s.pendingCycleReason} — compacting once idle`);
      }
    } catch (error: unknown) {
      if (!s.pendingCycleReason && shouldCycle(s)) s.pendingCycleReason = "turn_threshold_fallback";
      this.deps.log(`"${this.title}": context check failed: ${getErrorMessage(error)}`);
    }
    if (s.pendingCycleReason && isIdleForCycle(s)) {
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

  push(content: string, replyTo: string | null = null): void {
    this.replyTarget = replyTo;
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
      // The handoff summary is a turn too; it must never be posted as an answer.
      this.replyTarget = null;
      const summary = await captureHandoffSummary(this.state);
      this.teardownQuery();
      this.state.totalCycles++;
      this.state.chat.sdkSessionId = null;
      // The new SDK session gets its id on its first prompt. Until then a
      // resume must not reload the long transcript this compact just dropped.
      this.reportedSessionId = null;
      this.deps.onSessionId(this.chatId, null, this.state.chat.cwd);
      this.deps.onCompacted(this.chatId, summary);
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
