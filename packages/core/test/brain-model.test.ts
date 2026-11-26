import { afterEach, describe, expect, test } from "bun:test";
import { registerBrain, unregisterBrain } from "@choomfie/shared";
import { brainModelReply } from "../lib/handlers/brain-model.ts";
import { condensedHandoffNote, handoffNote, SUMMARIZE_OVER } from "../lib/handoff.ts";

function fakeChats() {
  const chats = new Map<string, { id: string; model: string | null }>();
  return {
    bound: (loc: string, brain: string) => chats.get(`${loc}|${brain}`) ?? null,
    current: (loc: string, brain: string) => {
      const k = `${loc}|${brain}`;
      if (!chats.has(k)) chats.set(k, { id: k, model: null });
      return chats.get(k)!;
    },
    setModel: (id: string, model: string | null) => void (chats.get(id)!.model = model),
  };
}

afterEach(() => {
  unregisterBrain("prov");
  unregisterBrain("plain");
});

describe("/model for other brains", () => {
  test("shows, sets, resets and rejects against the brain's own list", () => {
    registerBrain({ id: "prov", label: "Prov", send: async () => ({ text: "" }), models: () => [{ id: "big" }, { id: "Small-1" }] });
    const chats = fakeChats();
    const ctx = { chats } as never;
    expect(brainModelReply(ctx, "loc", "prov", null)).toContain("**big** (the default)");
    expect(brainModelReply(ctx, "loc", "prov", "small-1")).toContain("now runs on **Small-1**");
    expect(chats.bound("loc", "prov")!.model).toBe("Small-1");
    expect(brainModelReply(ctx, "loc", "prov", null)).toContain("runs on **Small-1** (default: big)");
    expect(brainModelReply(ctx, "loc", "prov", "nope")).toContain("has no model `nope`");
    expect(brainModelReply(ctx, "loc", "prov", "default")).toContain("back on the default");
    expect(chats.bound("loc", "prov")!.model).toBeNull();
  });

  test("a brain with no models, or one not loaded", () => {
    registerBrain({ id: "plain", label: "Plain", send: async () => ({ text: "" }) });
    const ctx = { chats: fakeChats() } as never;
    expect(brainModelReply(ctx, "loc", "plain", "x")).toContain("picks its own model");
    expect(brainModelReply(ctx, "loc", "gone", null)).toContain("isn't loaded");
  });
});

describe("handoff on /brain switch", () => {
  const now = 1_000_000_000_000;
  const m = (author: string, content: string, minsAgo: number, bot = false) => ({ author, bot, content, at: now - minsAgo * 60_000 });

  test("latest messages, oldest first, bot lines as the old brain, status lines dropped", () => {
    const note = handoffNote("Claude", "Free", [m("kev", "fix the parser", 3), m("bot", "Done — see diff\n-# via Groq", 2, true), m("kev", "now tests", 1)], now)!;
    expect(note).toStartWith("The owner just moved this chat from Claude to you (Free).");
    expect(note.split("\n").slice(1)).toEqual(["kev: fix the parser", "Claude: Done — see diff", "kev: now tests"]);
  });

  test("budget keeps the newest; old or empty conversations carry nothing", () => {
    const note = handoffNote("A", "B", [m("kev", "x".repeat(500), 3), m("kev", "newest", 1)], now, 100)!;
    expect(note.split("\n").slice(1)).toEqual(["kev: newest"]);
    expect(handoffNote("A", "B", [m("kev", "ancient", 60 * 25)], now)).toBeUndefined();
    expect(handoffNote("A", "B", [m("bot", "-# status only", 1, true)], now)).toBeUndefined();
  });

  test("a long handoff: the older part summarized, the last three messages word for word; a failed summary carries it as is", async () => {
    const long = Array.from({ length: 10 }, (_, i) => m("kev", `message ${i} ${"x".repeat(400)}`, 20 - i));
    const asked: string[] = [];
    const note = (await condensedHandoffNote("Claude", "Free", long, async (t) => (asked.push(t), "They planned a parser rewrite."), now))!;
    expect(note.split("\n").slice(0, 3)).toEqual(["The owner just moved this chat from Claude to you (Free). What happened before, in short:", "They planned a parser rewrite.", "The latest messages, word for word:"]);
    expect(note.split("\n").slice(3).map((l) => l.slice(0, 13))).toEqual(["kev: message ", "kev: message ", "kev: message "]);
    expect(asked[0]).toContain("message 0");
    expect(asked[0]).not.toContain("message 9");
    const failed = await condensedHandoffNote("Claude", "Free", long, async () => Promise.reject(new Error("all limited")), now);
    expect(failed).toBe(handoffNote("Claude", "Free", long, now));
    // Short, or nobody to summarize: as before.
    const short = [m("kev", "hi", 1)];
    expect(await condensedHandoffNote("A", "B", short, async () => "nope", now)).toBe(handoffNote("A", "B", short, now));
    expect(handoffNote("Claude", "Free", long, now)!.length).toBeGreaterThan(SUMMARIZE_OVER);
  });
});
