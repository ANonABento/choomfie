/**
 * The daemon: the session pool's routing, a chat session's compact and
 * recovery, and the loopback tool endpoint sessions reach Choomfie through.
 */
import { describe, expect, test } from "bun:test";
import { SessionPool, type LiveSession, type PoolChat } from "../daemon/pool.ts";
import { startLocalMcp } from "../lib/remote-mcp.ts";
import { formatChannelPrompt } from "../daemon/incoming.ts";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_BRAIN } from "@choomfie/shared";
import { ChatStore } from "../lib/chats/store.ts";
import { migrateLegacy } from "../daemon/hub.ts";
import { PLUGIN_DIR } from "../daemon/constants.ts";

class FakeSession implements LiveSession {
  pushed: string[] = [];
  closed = false;
  isBusy = false;
  isDead = false;
  compacted = 0;
  interrupted = 0;
  constructor(readonly chatId: string, public last: number) {}
  busy() {
    return this.isBusy;
  }
  dead() {
    return this.isDead;
  }
  lastActivityAt() {
    return this.last;
  }
  push(c: string) {
    this.pushed.push(c);
  }
  async interrupt() {
    this.interrupted++;
    return true;
  }
  async compact() {
    this.compacted++;
  }
  async close() {
    this.closed = true;
  }
}

function setup(max = 2) {
  const bound = new Map<string, PoolChat>();
  const opened: { location: string; chat: PoolChat; session: FakeSession }[] = [];
  let clock = 1000;
  const pool = new SessionPool({
    max,
    idleMs: 500,
    log: () => {},
    now: () => clock,
    boundChat: (l) => bound.get(l) ?? null,
    open: (location, chat) => {
      const session = new FakeSession(chat.id, clock);
      opened.push({ location, chat, session });
      return session;
    },
  });
  const bind = (location: string, id: string, backendRef: string | null = null) =>
    bound.set(location, { id, backendRef, cwd: null, title: id });
  return { pool, bind, opened, tick: (ms: number) => (clock += ms), bound };
}

describe("SessionPool", () => {
  test("one session per location, reused for later messages", async () => {
    const { pool, bind, opened } = setup();
    bind("t1", "chatA");
    bind("t2", "chatB");
    await pool.deliver("t1", "hi");
    await pool.deliver("t1", "again");
    await pool.deliver("t2", "other");
    expect(opened.map((o) => o.location)).toEqual(["t1", "t2"]);
    expect(opened[0].session.pushed).toEqual(["hi", "again"]);
  });

  test("a message with no chat bound is dropped", async () => {
    const { pool } = setup();
    expect(await pool.deliver("nowhere", "hi")).toBe(false);
  });

  test("a rebound location (/clear, /resume) closes the old session and opens the bound chat", async () => {
    const { pool, bind, opened } = setup();
    bind("t1", "chatA");
    await pool.deliver("t1", "hi");
    bind("t1", "chatB", "sdk-b");
    await pool.release("t1");
    expect(opened[0].session.closed).toBe(true);
    await pool.deliver("t1", "next");
    expect(opened[1].chat).toMatchObject({ id: "chatB", backendRef: "sdk-b" });
  });

  test("a chat resumed elsewhere is closed where it was, so one transcript has one writer", async () => {
    const { pool, bind, bound, opened } = setup(5);
    bind("t1", "chatA", "sdk-a");
    await pool.deliver("t1", "hi");
    bound.delete("t1");
    bind("t2", "chatA", "sdk-a");
    await pool.deliver("t2", "moved");
    expect(opened[0].session.closed).toBe(true);
    expect(pool.sessions.has("t1")).toBe(false);
    expect(opened[1].location).toBe("t2");
  });

  test("at the cap, the least recently active idle session closes; busy ones are kept", async () => {
    const { pool, bind, opened, tick } = setup(2);
    bind("t1", "a");
    bind("t2", "b");
    bind("t3", "c");
    await pool.deliver("t1", "x");
    tick(10);
    await pool.deliver("t2", "x");
    opened[0].session.isBusy = true;
    tick(10);
    await pool.deliver("t3", "x");
    expect(opened[0].session.closed).toBe(false);
    expect(opened[1].session.closed).toBe(true);
    expect([...pool.sessions.keys()].sort()).toEqual(["t1", "t3"]);
  });

  test("all busy: goes over the cap instead of cutting a turn off", async () => {
    const { pool, bind, opened } = setup(1);
    bind("t1", "a");
    bind("t2", "b");
    await pool.deliver("t1", "x");
    opened[0].session.isBusy = true;
    await pool.deliver("t2", "x");
    expect(pool.sessions.size).toBe(2);
  });

  test("idle and dead sessions are evicted; stop and compact reach one location", async () => {
    const { pool, bind, opened, tick } = setup(5);
    bind("t1", "a");
    bind("t2", "b");
    bind("t3", "c");
    await pool.deliver("t1", "x");
    await pool.deliver("t2", "x");
    await pool.deliver("t3", "x");
    expect(await pool.stop("t2")).toBe(true);
    expect(await pool.compact("t2")).toBe(true);
    expect(opened[1].session).toMatchObject({ interrupted: 1, compacted: 1 });
    expect(await pool.stop("nowhere")).toBe(false);

    opened[2].session.isDead = true;
    opened[1].session.last = 10_000;
    tick(600);
    await pool.evictIdle();
    expect([...pool.sessions.keys()]).toEqual(["t2"]);
  });
});

describe("inbound routing", () => {
  test("the location key routes but never reaches the prompt", () => {
    expect(formatChannelPrompt("hi", { chat_id: "ask:1", location_id: "g1", user: "k" })).toBe(
      '<channel source="choomfie" chat_id="ask:1" user="k">\nhi\n</channel>'
    );
  });
});

describe("startLocalMcp", () => {
  test("serves every tool and the worker's instructions, behind its token", async () => {
    const calls: string[] = [];
    const ep = startLocalMcp({
      name: "choomfie",
      version: "test",
      instructions: () => "You are Choomfie.",
      listTools: () => [
        { name: "reply", description: "r", inputSchema: { type: "object", properties: {} } },
        { name: "save_memory", description: "m", inputSchema: { type: "object", properties: {} } },
      ],
      callTool: async (name) => (calls.push(name), { content: [{ type: "text", text: "ok" }] }),
    });
    const rpc = (body: object, token = ep.token) =>
      fetch(ep.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
      });
    try {
      expect((await rpc({ method: "tools/list" }, "wrong")).status).toBe(401);
      const init = await (
        await rpc({
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
        })
      ).json();
      expect(init.result.instructions).toBe("You are Choomfie.");
      const list = await (await rpc({ method: "tools/list" })).json();
      expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["reply", "save_memory"]);
      const call = await (await rpc({ method: "tools/call", params: { name: "reply", arguments: {} } })).json();
      expect(call.result.content[0].text).toBe("ok");
      expect(calls).toEqual(["reply"]);
    } finally {
      ep.stop();
    }
  });
});

describe("migrateLegacy", () => {
  test("old shared chat: seeds folded in, binding dropped, sessions keep the cwd they ran in", () => {
    const dir = mkdtempSync(join(tmpdir(), "migrate-"));
    try {
      const db = new Database(":memory:");
      const chats = new ChatStore(db);
      const old = chats.create({ locationId: "claude:global", brain: CLAUDE_BRAIN, backendRef: "sdk-1" });
      chats.bind("claude:global", old.id);
      const fresh = chats.create({ locationId: "t1", brain: CLAUDE_BRAIN });
      const legacy = join(dir, "claude-chat.json");
      writeFileSync(legacy, JSON.stringify({ current: { id: old.id, cwd: "/x" }, seeds: { [old.id]: "old summary" } }));

      const seeds = migrateLegacy(db, { other: "kept" }, legacy);

      expect(seeds).toEqual({ other: "kept", [old.id]: "old summary" });
      expect(existsSync(legacy)).toBe(false);
      expect(chats.bound("claude:global", CLAUDE_BRAIN)).toBeNull();
      expect(chats.get(old.id)!.cwd).toBe(PLUGIN_DIR);
      expect(chats.get(fresh.id)!.cwd).toBeNull(); // no session yet: gets the chat home
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
