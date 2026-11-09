/**
 * A plan's tasks share one brain chat (cost: each task builds on what the chat
 * already knows instead of starting over). Driven through the real task
 * buttons, with a fake Discord and a fake brain.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ChannelType } from "discord.js";
import { buttonHandlers, registerBrain, unregisterBrain, type Brain, type BrainReply } from "@choomfie/shared";
import { getTaskBoard, loadTaskBoards, PLAN_CHAT_TASKS, postBrainReply, resetTaskBoards } from "../lib/brain-router.ts";
import { ChatStore } from "../lib/chats/store.ts";
import "../lib/handlers/brain-command.ts";

type Seen = { thread: string; chat: string | undefined; mode: string | null | undefined; content: string };

function setup(reply: (n: number) => BrainReply = () => ({ text: "done" })) {
  const dir = mkdtempSync(join(tmpdir(), "plan-chat-"));
  mkdirSync(join(dir, "meta"));
  loadTaskBoards(dir);
  const chats = new ChatStore(new Database(":memory:"));
  const ctx = { ownerUserId: "me", chats, DATA_DIR: dir, config: { setChannelBrain() {} } };
  const seen: Seen[] = [];
  const brain: Brain = {
    id: "waymond",
    label: "Waymond",
    send: async (m) => {
      const chat = chats.bound(m.chatKey, "waymond");
      seen.push({ thread: m.chatKey, chat: chat?.id, mode: chat?.mode, content: m.content });
      return reply(seen.length);
    },
  };
  registerBrain(brain);
  let threads = 0;
  const thread = () => {
    const id = `t${++threads}`;
    return { id, url: `https://d/${id}`, send: async () => ({ id: `${id}-m` }), isTextBased: () => true, sendTyping: async () => {}, members: { add: async () => {} } };
  };
  const parent = { type: ChannelType.GuildText, threads: { create: async () => thread() }, send: async () => ({ id: "board" }) };
  const ephemerals: string[] = [];
  const press = async (customId: string) => {
    const interaction = {
      user: { id: "me", username: "me" },
      guildId: "g",
      channel: parent,
      message: { id: "board", url: "https://d/board", edit: async () => {} },
      reply: async (o: { content: string }) => void ephemerals.push(o.content),
      deferUpdate: async () => {},
      followUp: async () => {},
    };
    await buttonHandlers.get("brain")!(interaction as never, customId.split(":"), ctx as never);
  };
  return { ctx, chats, seen, parent, press, ephemerals };
}

const tasks = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ n: i + 1, mode: i % 2 ? "research" : "plan", title: `T${i + 1}`, spec: `do ${i + 1}` }));

afterEach(() => {
  unregisterBrain("waymond");
  resetTaskBoards();
});

describe("a plan's tasks share one chat", () => {
  test("Run all: one chat moves through the task threads, each task in its own mode; a fresh one after the cap", async () => {
    const { seen, parent, press } = setup();
    await postBrainReply(parent, "waymond", "planchat", { text: "Plan.", tasks: tasks(PLAN_CHAT_TASKS + 1), taskContext: "THE PLAN CONTEXT" });
    await press("brain:taskall");

    expect(seen).toHaveLength(PLAN_CHAT_TASKS + 1);
    expect(new Set(seen.map((s) => s.thread)).size).toBe(PLAN_CHAT_TASKS + 1); // a thread per task, still
    const first = seen[0].chat;
    expect(seen.slice(0, PLAN_CHAT_TASKS).every((s) => s.chat === first)).toBe(true);
    expect(seen[PLAN_CHAT_TASKS].chat).not.toBe(first); // hands over after the cap
    expect(seen.map((s) => s.mode)).toEqual(tasks(PLAN_CHAT_TASKS + 1).map((t) => t.mode));

    // The plan's context goes to a chat once; a continuing task is told it's the same chat.
    expect(seen[0].content).toContain("THE PLAN CONTEXT");
    expect(seen[1].content).not.toContain("THE PLAN CONTEXT");
    expect(seen[1].content).toContain("same plan, same chat");
    expect(seen[PLAN_CHAT_TASKS].content).toContain("THE PLAN CONTEXT");

    const board = getTaskBoard("board")!;
    expect(board.states.every((s) => s.kind === "done")).toBe(true);
    expect(board.workChat).toMatchObject({ id: seen[PLAN_CHAT_TASKS].chat, tasks: 1, open: true });
  });

  test("a task still running in the background: the next task gets a chat of its own", async () => {
    const { seen, parent, press } = setup((n) => (n === 1 ? { text: "on it", background: true } : { text: "done" }));
    await postBrainReply(parent, "waymond", "planchat", { text: "Plan.", tasks: tasks(2), taskContext: "CTX" });
    await press("brain:task:0");
    await press("brain:task:1");
    expect(seen).toHaveLength(2);
    expect(seen[1].chat).not.toBe(seen[0].chat);
    expect(seen[1].content).toContain("CTX");
  });

  test("the owner moving the chat off its task thread (/clear there) starts a fresh one", async () => {
    const { seen, chats, parent, press } = setup();
    await postBrainReply(parent, "waymond", "planchat", { text: "Plan.", tasks: tasks(2), taskContext: "CTX" });
    await press("brain:task:0");
    chats.start(seen[0].thread, "waymond"); // /clear in task 1's thread
    await press("brain:task:1");
    expect(seen[1].chat).not.toBe(seen[0].chat);
  });

  test("one task at a time: a second task is refused while one runs", async () => {
    const { seen, parent, press, ephemerals } = setup();
    await postBrainReply(parent, "waymond", "planchat", { text: "Plan.", tasks: tasks(2) });
    getTaskBoard("board")!.states[0] = { kind: "running", url: "https://d/t0" };
    await press("brain:task:1");
    expect(seen).toHaveLength(0);
    expect(ephemerals[0]).toContain("one at a time");
  });
});
