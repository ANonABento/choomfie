import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_PATH_RE,
  hasWaitingCard,
  answerState,
  parseMessages,
  parseTurn,
  replyFor,
} from "../../../plugins/waymond/api.ts";
import { framePrompt } from "../../../plugins/waymond/index.ts";

// Shapes as observed from app.ambition.inc on 2026-11-04.
const turn = (over: Record<string, unknown> = {}) => ({
  active: false,
  unanswered: false,
  job_id: "j",
  source_user_message_id: "u2",
  progress: {
    tools: [
      { tool: "search", type: "t", label: "Searching the web", status: "running" },
      { tool: "read", type: "t", label: "Reading", status: "done" },
    ],
    intent: "Looking into it",
    actions: [],
    content: "",
  },
  phase: "answer",
  progress_at: "2026-11-04 20:00:00",
  ...over,
});

describe("waymond api parsing", () => {
  test("parseTurn reads state and running tools only", () => {
    const t = parseTurn(turn({ active: true }));
    expect(t).toMatchObject({ active: true, sourceUserMessageId: "u2", intent: "Looking into it" });
    expect(t.running).toEqual(["Searching the web"]);
    expect(parseTurn(null)).toEqual({ active: false, running: [] } as never);
  });

  test("done only once our new message has an answer and Waymond is idle", () => {
    const before = parseMessages([
      { id: "u1", role: "user", content: "old" },
      { id: "a1", role: "assistant", content: "old answer" },
    ]);
    const base = new Set(before.map((m) => m.id));
    // Just sent: our message not visible yet.
    expect(answerState(before, base, false, false).done).toBe(false);
    const sent = [...before, ...parseMessages([{ id: "u2", role: "user", content: "new" }])];
    // Idle before the job started, no answer yet: not done.
    expect(answerState(sent, base, false, false).done).toBe(false);
    // Working.
    expect(answerState(sent, base, true, true).done).toBe(false);
    const answered = [...sent, ...parseMessages([{ id: "a2", role: "assistant", content: "OK" }])];
    // Fast answer we never saw as active (the observed case).
    expect(answerState(answered, base, false, false)).toMatchObject({ done: true, reply: "OK" });
    // Finished with tool actions only.
    expect(answerState(sent, base, false, true)).toMatchObject({ done: true, reply: "" });
  });

  test("idle turn after completion carries no source id (observed)", () => {
    expect(parseTurn({ active: false, unanswered: false })).toEqual({ active: false, running: [] } as never);
  });

  test("replyFor collects the answer to one message, not the next one", () => {
    const msgs = parseMessages([
      { id: "u1", role: "user", content: "first" },
      { id: "a1", role: "assistant", content: "answer one" },
      { id: "u2", role: "user", content: "second" },
      { id: "a2", role: "assistant", content: "part A" },
      { id: "a3", role: "assistant", content: "part B" },
      { id: "u3", role: "user", content: "third" },
    ]);
    expect(replyFor(msgs, "u2")).toBe("part A\n\npart B");
    expect(replyFor(msgs, "u1")).toBe("answer one");
    // Unknown id → trailing run after the last user message (none here).
    expect(replyFor(msgs, "missing")).toBe("");
    expect(replyFor(msgs.slice(0, 5), "missing")).toBe("part A\n\npart B");
  });

  test("waiting cards are detected per conversation whatever the value shape", () => {
    expect(hasWaitingCard({ total: 0, conversations: {} }, "c")).toBe(false);
    expect(hasWaitingCard({ total: 1, conversations: { c: 1 } }, "c")).toBe(true);
    expect(hasWaitingCard({ total: 1, conversations: { c: [{ id: "x" }] } }, "c")).toBe(true);
    expect(hasWaitingCard({ total: 1, conversations: { other: 1 } }, "c")).toBe(false);
  });

  test("conversation id is read from the chat URL", () => {
    const id = "f96c82f8-2298-485d-8e76-3317bba629f2";
    expect(CONVERSATION_PATH_RE.exec(`https://app.ambition.inc/chat/${id}`)?.[1]).toBe(id);
    expect(CONVERSATION_PATH_RE.exec("https://app.ambition.inc/chat?new=1")).toBeNull();
  });
});

describe("framePrompt", () => {
  test("owner messages pass through; others are labelled; attachments are named", () => {
    expect(framePrompt("hi", { role: "owner" }, [])).toBe("hi");
    expect(framePrompt("hi", { role: "user", user: "alex" }, [])).toBe("[Discord message from alex]\nhi");
    expect(framePrompt("look", { role: "owner" }, ["a.png (image/png, 3KB)"])).toContain("not forwarded: a.png");
  });
});
