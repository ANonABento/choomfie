import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_PATH_RE,
  hasWaitingCard,
  answerState,
  lateMessages,
  openOffers,
  parseMessages,
  parseTurn,
  replyFor,
} from "../../../plugins/waymond/api.ts";
import { framePrompt, originalName, toApproval } from "../../../plugins/waymond/index.ts";

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

describe("quick replies and background jobs (observed 2026-11-04)", () => {
  const observed = parseMessages([
    { id: "u1", role: "user", content: "pizza or tacos?", tool_calls: null },
    {
      id: "a1",
      role: "assistant",
      content: "Pizza or tacos?",
      tool_calls: [{ tool: "offer_replies", status: "completed", data: { options: ["I’ll go with pizza", "I’m choosing tacos"] } }],
    },
    { id: "u2", role: "user", content: "research the Raspberry Pi", tool_calls: null },
    {
      id: "a2",
      role: "assistant",
      content: "I've started researching…",
      tool_calls: [{ tool: "start_task", status: "completed", data: { research_job_id: "j" } }],
    },
  ]);

  test("offer_replies options are surfaced as choices", () => {
    const st = answerState(observed.slice(0, 2), new Set(), false, false);
    expect(st.options).toEqual(["I’ll go with pizza", "I’m choosing tacos"]);
    expect(st.background).toBe(false);
  });

  test("start_task marks the answer as continuing in the background", () => {
    const st = answerState(observed, new Set(["u1", "a1"]), false, false);
    expect(st).toMatchObject({ done: true, background: true, lastMessageId: "a2" });
  });

  test("late results: everything Waymond posted after the watermark that wasn't delivered", () => {
    const later = [...observed, ...parseMessages([
      { id: "u3", role: "user", content: "thanks" },
      { id: "a4", role: "assistant", content: "np" },
      // Background result landing after the newer exchange.
      { id: "a5", role: "assistant", content: "Here is the report." },
    ])];
    expect(lateMessages(later, "a2", new Set(["a4"])).map((m) => m.id)).toEqual(["a5"]);
    expect(lateMessages(later, "a2", new Set(["a4", "a5"]))).toEqual([]);
    expect(lateMessages(later, "unknown")).toEqual([]); // never re-post the window
  });
});

describe("framePrompt", () => {
  test("owner messages pass through; others are labelled", () => {
    expect(framePrompt("hi", { role: "owner" })).toBe("hi");
    expect(framePrompt("hi", { role: "user", user: "alex" })).toBe("[Discord message from alex]\nhi");
  });

  test("inbox prefixes are stripped from attachment names", () => {
    expect(originalName("/x/inbox/1793824118401_ab12cd_photo.png")).toBe("photo.png");
    expect(originalName("/x/inbox/plain.txt")).toBe("plain.txt");
  });
});

describe("approval cards (offer_post observed 2026-11-04)", () => {
  const card = (status: string) => ({
    id: "a9",
    role: "assistant",
    content: "I've drafted a one-line post for RedTeam.",
    tool_calls: [
      {
        tool: "offer_post",
        status: "completed",
        data: {
          offer: {
            kind: "post",
            title: "RedTeam",
            detail: "Bridge test, please ignore.",
            status,
            primary: "Send",
            offer_id: "offer-1",
            subtitle: "New message",
            image_url: null,
            secondary: "Not now",
          },
        },
      },
      { tool: "offer_replies", status: "completed", data: { options: [] } },
    ],
  });

  test("open offers become approvals with Ambition's own button labels", () => {
    const msgs = parseMessages([{ id: "u", role: "user", content: "go" }, card("open")]);
    const st = answerState(msgs, new Set(), false, false);
    expect(st.offers).toHaveLength(1);
    expect(toApproval(st.offers[0])).toEqual({
      id: "offer-1",
      title: "RedTeam · New message",
      detail: "Bridge test, please ignore.",
      approveLabel: "Send",
      declineLabel: "Not now",
    });
  });

  test("declined or sent offers are not offered again", () => {
    expect(openOffers(parseMessages([card("declined")]))).toEqual([]);
    expect(openOffers(parseMessages([card("sent")]))).toEqual([]);
  });
});
