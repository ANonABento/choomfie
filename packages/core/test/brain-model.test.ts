import { afterEach, describe, expect, test } from "bun:test";
import { registerBrain, unregisterBrain } from "@choomfie/shared";
import { brainModelReply } from "../lib/handlers/brain-model.ts";
import { handoffNote } from "../lib/handoff.ts";

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
});
