import { afterEach, expect, test } from "bun:test";
import { registerBrain, unregisterBrain, type ChatRecord } from "@choomfie/shared";
import { chatStateLines } from "../lib/chats/here.ts";

const chat = (over: Partial<ChatRecord>): ChatRecord =>
  ({ id: "c1", title: "songs", createdAt: "2026-11-26 01:00:00", cwd: null, model: null, mode: null, ...over }) as ChatRecord;
const ctx = { DATA_DIR: "/tmp/choomfie-test" };

afterEach(() => unregisterBrain("waymond"));

test("a chat held by another brain says so, and how to release it", () => {
  registerBrain({ id: "waymond", label: "Waymond", send: async () => ({ text: "" }) });
  const lines = chatStateLines(ctx, "free", chat({ model: "waymond" }));
  expect(lines[0]).toContain("Chat: **songs**");
  expect(lines[1]).toStartWith("Held by **Waymond**");
  expect(lines[1]).toContain("`/model auto`");
});

test("a plain model pick and a mode are shown as such", () => {
  const lines = chatStateLines(ctx, "free", chat({ model: "groq:openai/gpt-oss-120b", mode: "code" }));
  expect(lines).toContain("Model: **groq:openai/gpt-oss-120b** (`/model auto` to let it choose)");
  expect(lines).toContain("Mode: **code**");
  expect(chatStateLines(ctx, "free", chat({}))).toHaveLength(1);
});
