import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeCompact } from "../compact.ts";
import { buildMessages, estimateTokens, recap, systemPrompt, userContent } from "../context.ts";
import { Transcript } from "../transcript.ts";

describe("Transcript", () => {
  test("keyed by chat id; summary hides covered turns", () => {
    const t = new Transcript(":memory:");
    const a = t.add("chat1", "user", "hi");
    t.add("chat1", "assistant", "hello", "groq", "m");
    t.add("chat2", "user", "other chat");
    expect(t.live("chat1").map((x) => x.content)).toEqual(["hi", "hello"]);
    t.setSummary("chat1", "they said hi", a);
    expect(t.live("chat1").map((x) => x.content)).toEqual(["hello"]);
    expect(t.lastAnsweredBy("chat1", "groq")).toBeGreaterThan(a);
    expect(t.lastAnsweredBy("chat1", "waymond")).toBe(0);
    expect(t.live("fresh-chat-after-clear")).toEqual([]);
  });
});

describe("buildMessages", () => {
  const turns = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `turn ${i} `.repeat(40), member: null, model: null }));

  test("keeps the newest turns that fit, starting on a user turn", () => {
    const current = userContent("now?", [], false);
    const built = buildMessages({ system: "sys", summary: { text: "older stuff", uptoId: 0 }, history: turns, current, budget: 300 });
    expect(built.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(built.messages[1].content).toContain("older stuff");
    expect(built.messages.at(-1)).toEqual({ role: "user", content: "now?" });
    const middle = built.messages.slice(2, -1);
    expect(middle[0]?.role).toBe("user");
    expect(built.tokens).toBeLessThanOrEqual(300);
    expect(built.dropped).toBeGreaterThan(0);
  });
});

describe("userContent", () => {
  const dir = mkdtempSync(join(tmpdir(), "apibrain-ctx-"));
  const png = join(dir, "123_abc_photo.png");
  const txt = join(dir, "456_def_notes.md");
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(txt, "# Notes\nhello");

  test("images become data URLs for vision models, notes otherwise; text files inline", () => {
    const seen = userContent("look", [png, txt], true);
    expect(Array.isArray(seen.content)).toBe(true);
    const parts = seen.content as { type: string; text?: string }[];
    expect(parts[1].type).toBe("image_url");
    expect(parts[0].text).toContain("File notes.md:");
    expect(seen.record).toBe("look\n[image: photo.png]\n[file: notes.md]");

    const blind = userContent("look", [png], false);
    expect(blind.content).toBe("look\n\n[image photo.png attached — this model can't see images]");
  });
});

test("systemPrompt carries the persona and the mode frame", () => {
  const s = systemPrompt({ name: "Choomfie", personality: "Be fun." }, "Work in code mode.");
  expect(s).toStartWith("You are Choomfie. Be fun.");
  expect(s).toEndWith("Work in code mode.");
});

test("recap lists what a brain missed", () => {
  const r = recap(null, [
    { id: 3, role: "user", content: "what's 2+2", member: null, model: null },
    { id: 4, role: "assistant", content: "4", member: "groq", model: "m" },
  ]);
  expect(r).toContain("User: what's 2+2\nAssistant (groq): 4");
  expect(recap(null, [])).toBe("");
});

test("maybeCompact folds the older half into a summary", async () => {
  const t = new Transcript(":memory:");
  for (let i = 0; i < 8; i++) t.add("c", i % 2 ? "assistant" : "user", `message ${i} `.repeat(50));
  let asked = "";
  const did = await maybeCompact({ transcript: t, chatId: "c", budget: 500, summarize: async (text) => ((asked = text), "the gist") });
  expect(did).toBe(true);
  expect(asked).toContain("message 0");
  expect(t.summary("c")?.text).toBe("the gist");
  expect(t.live("c").length).toBe(4);
  expect(t.live("c")[0].role).toBe("user");
  // Rate-limited per chat.
  expect(await maybeCompact({ transcript: t, chatId: "c", budget: 1, summarize: async () => "again" })).toBe(false);
  expect(estimateTokens("abcd")).toBe(1);
});
