/**
 * ChatSession: one chat's Agent SDK session in the daemon's pool — resuming
 * with the chat's seed, reporting its SDK session id, compacting into a fresh
 * session on the same chat, waiting for idle before a threshold compact, and
 * recovering from a broken stream. The SDK is replaced by a scripted fake.
 */
import { describe, expect, test } from "bun:test";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ChatSession, type ChatSessionDeps } from "../daemon/chat-session.ts";
import { CHAT_HOME, CYCLE_IDLE_DEBOUNCE_MS } from "../daemon/constants.ts";
import type { SessionPlacement } from "../daemon/session-core.ts";

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** Stands in for the SDK's Query: reads prompts, answers each with a result. */
class FakeQuery {
  prompts: string[] = [];
  closed = false;
  interrupted = 0;
  contextTokens = 1_000;
  private queue: SDKMessage[] = [];
  private wake: (() => void) | null = null;
  private failure: unknown = null;

  constructor(
    prompt: AsyncGenerator<SDKUserMessage>,
    readonly summary: string | undefined,
    readonly placement: SessionPlacement,
    answer: (text: string) => string | null
  ) {
    void (async () => {
      for await (const m of prompt) {
        const text = String(m.message.content);
        this.prompts.push(text);
        const reply = answer(text);
        if (reply !== null) this.emit({ type: "result", subtype: "success", num_turns: 1, total_cost_usd: 0, result: reply } as never);
      }
    })();
  }

  emit(m: SDKMessage) {
    this.queue.push(m);
    this.wake?.();
  }

  fail(error: unknown) {
    this.failure = error;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.failure) throw this.failure;
      if (this.closed) return;
      const next = this.queue.shift();
      if (next) yield next;
      else await new Promise<void>((r) => (this.wake = r));
    }
  }

  async getContextUsage() {
    return { totalTokens: this.contextTokens, maxTokens: 200_000, percentage: this.contextTokens / 2_000 };
  }

  async interrupt() {
    this.interrupted++;
  }

  close() {
    this.closed = true;
    this.wake?.();
  }
}

function setup(
  opts: {
    backendRef?: string | null;
    cwd?: string | null;
    model?: string | null;
    seed?: string;
    answer?: (text: string) => string | null;
  } = {}
) {
  const queries: FakeQuery[] = [];
  const models: unknown[] = [];
  const events = {
    sessionIds: [] as (string | null)[],
    cwds: [] as string[],
    compacted: [] as string[],
    logs: [] as string[],
    posted: [] as [string, string][],
  };
  const deps: ChatSessionDeps = {
    location: "t1",
    chat: { id: "chat1", backendRef: opts.backendRef ?? null, cwd: opts.cwd === undefined ? "/tmp" : opts.cwd, model: opts.model ?? null, title: "arm" },
    settings: { tokenThreshold: 120_000, turnThreshold: 2, maxSessions: 3, model: "opus" },
    mcp: { url: "http://127.0.0.1:1/mcp", token: "t" },
    seed: () => opts.seed,
    onCompacted: (_id, summary) => events.compacted.push(summary),
    onSessionId: (_id, sid, cwd) => {
      events.sessionIds.push(sid);
      events.cwds.push(cwd);
    },
    onUsage: () => {},
    onChange: () => {},
    log: (m) => events.logs.push(m),
    postReply: async (chatId, text) => void events.posted.push([chatId, text]),
    createSession: ((prompt: AsyncGenerator<SDKUserMessage>, summary: string | undefined, m: unknown, placement: SessionPlacement) => {
      models.push(m);
      const q = new FakeQuery(prompt, summary, placement, opts.answer ?? ((t) => (t.includes("handoff summary") ? "SUMMARY" : "ok")));
      queries.push(q);
      return q;
    }) as never,
  };
  const session = new ChatSession(deps);
  return { session, queries, events, models };
}

describe("ChatSession", () => {
  test("a plain final answer is posted to the chat the message came from", async () => {
    const { session, events } = setup({ answer: () => "  hi there  " });
    session.start();
    session.push("hello", "c1");
    await tick();
    expect(events.posted).toEqual([["c1", "hi there"]]);
    void session.close();
  });

  test("no post when the model used reply, said nothing, or the prompt wasn't a Discord message", async () => {
    const { session, queries, events } = setup({ answer: (t) => (t === "silent" ? "" : t === "via-tool" ? null : "text") });
    session.start();
    session.push("internal"); // no target: a daemon prompt
    await tick();
    session.push("silent", "c1"); // empty final text
    await tick();
    session.push("via-tool", "c1");
    queries[0].emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__choomfie__reply", input: {} }] } } as never);
    queries[0].emit({ type: "result", subtype: "success", num_turns: 2, total_cost_usd: 0, result: "recap" } as never);
    await tick();
    expect(events.posted).toEqual([]);
    void session.close();
  });

  test("an interrupted turn posts nothing", async () => {
    const { session, queries, events } = setup({ answer: () => null });
    session.start();
    session.push("long job", "c1");
    queries[0].emit({ type: "result", subtype: "error_during_execution", num_turns: 1, total_cost_usd: 0 } as never);
    await tick();
    expect(events.posted).toEqual([]);
    void session.close();
  });

  test("a chat with a session resumes it, with the summary it started from", () => {
    const { session, queries } = setup({ backendRef: "sdk-1", seed: "earlier summary" });
    session.start();
    expect(queries[0].placement).toMatchObject({ resume: "sdk-1", cwd: "/tmp", mcp: { token: "t" } });
    expect(queries[0].summary).toBe("earlier summary");
    void session.close();
  });

  test("a chat with no project runs in the chat home, and its first session pins that cwd", async () => {
    const { session, queries, events } = setup({ cwd: null });
    session.start();
    expect(queries[0].placement.cwd).toBe(CHAT_HOME);
    queries[0].emit({ type: "system", subtype: "init", session_id: "sdk-2", model: "m", claude_code_version: "999.0.0" } as never);
    await tick();
    expect(events.cwds).toEqual([CHAT_HOME]);
    void session.close();
  });

  test("the chat's own model wins over the default; none means the default", () => {
    const own = setup({ model: "sonnet" });
    own.session.start();
    expect(own.models[0]).toMatchObject({ model: "sonnet" });
    expect(own.session.model).toBe("sonnet");
    void own.session.close();
    const plain = setup();
    plain.session.start();
    expect(plain.models[0]).toMatchObject({ model: "opus" });
    void plain.session.close();
  });

  test("a new chat starts fresh and reports its SDK session id once", async () => {
    const { session, queries, events } = setup();
    session.start();
    expect(queries[0].placement.resume).toBeUndefined();
    const init = { type: "system", subtype: "init", session_id: "sdk-9", model: "m", claude_code_version: "999.0.0" } as never;
    queries[0].emit(init);
    queries[0].emit(init);
    await tick();
    expect(events.sessionIds).toEqual(["sdk-9"]);
    void session.close();
  });

  test("compact: summary captured, same chat, fresh session seeded with it", async () => {
    const { session, queries, events } = setup({ backendRef: "sdk-1" });
    session.start();
    await session.compact("chan-1");
    expect(events.compacted).toEqual(["SUMMARY"]);
    // The old transcript must not be resumed again before the new session names itself.
    expect(events.sessionIds).toEqual([null]);
    expect(queries).toHaveLength(2);
    expect(queries[0].closed).toBe(true);
    expect(queries[1].placement.resume).toBeUndefined();
    expect(queries[1].summary).toBe("SUMMARY");
    await tick();
    expect(queries[1].prompts[0]).toContain("channel chan-1");
    expect(session.state.totalCycles).toBe(1);
    void session.close();
  });

  test("a soft threshold waits for the session to go idle", async () => {
    const { session, queries } = setup({ answer: () => null }); // turns stay in flight
    session.start();
    session.push("hello");
    session.state.turnCount = 5; // past turnThreshold (2)
    await session.checkContext();
    expect(session.state.pendingCycleReason).toBe("turn_threshold");
    expect(queries).toHaveLength(1);

    // Idle long enough: the next check compacts.
    session.state.turnInFlight = false;
    session.state.lastActivityAt = Date.now() - CYCLE_IDLE_DEBOUNCE_MS - 1;
    const compacting = session.checkContext();
    await tick();
    queries[0].emit({ type: "result", subtype: "success", num_turns: 1, total_cost_usd: 0, result: "S" } as never);
    await compacting;
    expect(queries).toHaveLength(2);
    expect(session.state.lastCycleReason).toBe("turn_threshold");
    void session.close();
  });

  test("past the hard ceiling it compacts even mid-turn", async () => {
    const { session, queries, events } = setup();
    session.start();
    session.state.turnCount = 1;
    queries[0].contextTokens = 190_000;
    await session.checkContext();
    expect(events.compacted).toEqual(["SUMMARY"]);
    expect(session.state.lastCycleReason).toBe("token_ceiling");
    void session.close();
  });

  test("never compacts before the session's first turn, so it can't compact in a loop", async () => {
    const { session, queries, events } = setup();
    session.start();
    queries[0].contextTokens = 190_000; // still over the line straight after a compact
    await session.checkContext();
    await session.checkContext();
    expect(events.compacted).toEqual([]);
    expect(queries).toHaveLength(1);
    void session.close();
  });

  test("an auth or billing failure gives up; the pool replaces it", async () => {
    const { session, queries } = setup();
    session.start();
    queries[0].fail(new Error("401 authentication_error"));
    await tick();
    expect(session.dead()).toBe(true);
    expect(queries).toHaveLength(1);
  });

  test("a transient failure reopens the same SDK session", async () => {
    const { session, queries } = setup({ backendRef: "sdk-1" });
    session.start();
    queries[0].fail(new Error("ECONNRESET"));
    await tick(2_200); // first backoff step
    expect(queries).toHaveLength(2);
    expect(queries[1].placement.resume).toBe("sdk-1");
    expect(session.dead()).toBe(false);
    void session.close();
  });
});
