/**
 * Chats: location → conversation bindings, titles, the cwd allowlist,
 * auto-thread, and the daemon-side pieces behind /clear and /resume.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_BRAIN, titleFrom, UNTITLED_CHAT } from "@choomfie/shared";
import { ChatStore } from "../lib/chats/store.ts";
import { resolveChatCwd, shortPath } from "../lib/chats/here.ts";
import { isOwnThread, wantsThread } from "../lib/chats/auto-thread.ts";
import { ConfigManager } from "../lib/config.ts";
import { ChannelType } from "discord.js";
import { parseSeeds, withSeed } from "../daemon/seeds.ts";

const store = () => new ChatStore(new Database(":memory:"));

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "choomfie-chats-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("ChatStore", () => {
  test("current() creates and binds once, then returns the same chat", () => {
    const chats = store();
    const a = chats.current("chan1", "waymond", "hello there");
    expect(a.title).toBe("hello there");
    expect(chats.current("chan1", "waymond", "ignored").id).toBe(a.id);
    expect(chats.locationOf(a.id)).toBe("chan1");
  });

  test("bindings are per brain, so switching /brain and back finds the old chat", () => {
    const chats = store();
    const w = chats.current("chan1", "waymond");
    const g = chats.current("chan1", "gemini");
    expect(g.id).not.toBe(w.id);
    expect(chats.bound("chan1", "waymond")?.id).toBe(w.id);
  });

  test("start() replaces the live chat but keeps the old one listable", () => {
    const chats = store();
    const old = chats.current("chan1", "waymond", "old");
    const fresh = chats.start("chan1", "waymond", "fresh");
    expect(chats.bound("chan1", "waymond")?.id).toBe(fresh.id);
    expect(chats.list({ brain: "waymond" }).map((c) => c.id)).toContain(old.id);
  });

  test("binding a chat somewhere else moves it — one location per chat", () => {
    const chats = store();
    const a = chats.current("chan1", "waymond");
    chats.bind("chan2", a.id);
    expect(chats.bound("chan1", "waymond")).toBeNull();
    expect(chats.locationOf(a.id)).toBe("chan2");
  });

  test("list is most recently active first; search matches titles literally", () => {
    const chats = store();
    const a = chats.create({ locationId: "x", brain: "waymond", title: "gripper rack 100%" });
    chats.create({ locationId: "y", brain: "waymond", title: "placard layout" });
    chats.touch(a.id);
    // Same-second timestamps fall back to insertion order, so force a gap.
    (chats as unknown as { db: Database }).db.query("UPDATE chats SET last_active_at = '2099-01-01 00:00:00' WHERE id = ?").run(a.id);
    expect(chats.list({ brain: "waymond" })[0].id).toBe(a.id);
    expect(chats.search("100%").map((c) => c.title)).toEqual(["gripper rack 100%"]);
    expect(chats.search("_").length).toBe(0);
  });

  test("backend refs and datetimes use SQLite format", () => {
    const chats = store();
    const a = chats.current("chan1", "waymond");
    chats.setBackendRef(a.id, "conv-1");
    const got = chats.get(a.id)!;
    expect(got.backendRef).toBe("conv-1");
    expect(got.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe("titleFrom", () => {
  test("strips mentions, collapses whitespace, clips", () => {
    expect(titleFrom("<@123>   fix   the\ngripper")).toBe("fix the gripper");
    expect(titleFrom("")).toBe(UNTITLED_CHAT);
    expect(titleFrom("x".repeat(100)).length).toBe(60);
  });
});

describe("cwd allowlist", () => {
  test("allows a root and anything under it, refuses siblings and missing paths", () => {
    const root = tmp();
    mkdirSync(join(root, "proj"));
    const other = tmp();
    expect(resolveChatCwd(join(root, "proj"), [root])).toEqual({ cwd: join(realpathSync(root), "proj") });
    expect("error" in resolveChatCwd(other, [root])).toBe(true);
    expect("error" in resolveChatCwd(join(root, "nope"), [root])).toBe(true);
    expect("error" in resolveChatCwd(root, [])).toBe(true);
  });

  test("a prefix that isn't a path boundary doesn't count", () => {
    const base = tmp();
    mkdirSync(join(base, "proj"));
    mkdirSync(join(base, "project-evil"));
    expect("error" in resolveChatCwd(join(base, "project-evil"), [join(base, "proj")])).toBe(true);
  });

  test("a symlink inside a root that points outside is refused", () => {
    const root = tmp();
    const outside = tmp();
    symlinkSync(outside, join(root, "link"));
    expect("error" in resolveChatCwd(join(root, "link"), [root])).toBe(true);
  });

  test("shortPath only abbreviates the real home directory", () => {
    const h = process.env.HOME!;
    expect(shortPath(`${h}/x`)).toBe("~/x");
    expect(shortPath(`${h}x/y`)).toBe(`${h}x/y`);
  });
});

describe("per-chat model", () => {
  test("stored on the chat; null means the default", () => {
    const chats = store();
    const c = chats.current("t1", CLAUDE_BRAIN, "hi");
    expect(c.model).toBeNull();
    chats.setModel(c.id, "sonnet");
    expect(chats.bound("t1", CLAUDE_BRAIN)!.model).toBe("sonnet");
    chats.setModel(c.id, null);
    expect(chats.get(c.id)!.model).toBeNull();
  });

  test("a database from before the column gets it on open, rows intact", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE chats (id TEXT PRIMARY KEY, brain TEXT NOT NULL, backend_ref TEXT, title TEXT NOT NULL,
      cwd TEXT, location_id TEXT NOT NULL, created_at TEXT NOT NULL, last_active_at TEXT NOT NULL)`);
    db.exec(`INSERT INTO chats VALUES ('c1', 'claude', 's1', 'old', NULL, 't1', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`);
    const chats = new ChatStore(db);
    expect(chats.get("c1")).toMatchObject({ title: "old", backendRef: "s1", model: null });
    new ChatStore(db); // idempotent
  });
});

describe("current(): the chat for a message", () => {
  test("each location gets its own chat, titled from its first message", () => {
    const chats = store();
    const a = chats.current("t1", CLAUDE_BRAIN, "<@1> plan the gripper");
    const b = chats.current("t2", CLAUDE_BRAIN, "robot wiring");
    expect(a.title).toBe("plan the gripper");
    expect(b.id).not.toBe(a.id);
    expect(chats.current("t1", CLAUDE_BRAIN, "more").id).toBe(a.id);
    expect(chats.get(a.id)!.title).toBe("plan the gripper");
  });

  test("an untitled chat (from /clear) takes its title from the next message", () => {
    const chats = store();
    const fresh = chats.start("t1", CLAUDE_BRAIN);
    expect(fresh.title).toBe(UNTITLED_CHAT);
    expect(chats.current("t1", CLAUDE_BRAIN, "   ").title).toBe(UNTITLED_CHAT);
    expect(chats.current("t1", CLAUDE_BRAIN, "wire the arm").title).toBe("wire the arm");
  });

  test("brains keep separate chats at one location", () => {
    const chats = store();
    expect(chats.current("c", CLAUDE_BRAIN, "x").id).not.toBe(chats.current("c", "waymond", "y").id);
  });
});

describe("seeds", () => {
  test("only string summaries are read back", () => {
    expect(parseSeeds({ c: "s", bad: 1 })).toEqual({ c: "s" });
    expect(parseSeeds(null)).toEqual({});
  });

  test("seeds are replaced per chat and capped", () => {
    let seeds: Record<string, string> = {};
    for (let i = 0; i < 40; i++) seeds = withSeed(seeds, `c${i}`, `s${i}`);
    expect(Object.keys(seeds).length).toBe(30);
    expect(seeds.c39).toBe("s39");
    expect(seeds.c0).toBeUndefined();
    expect(withSeed({ a: "1" }, "a", undefined)).toEqual({});
  });
});

describe("auto-thread", () => {
  const BOT = "111";
  const text = { type: ChannelType.GuildText, isThread: () => false };
  const msg = (content: string, channel: object = text, guildId: string | null = "g") => ({ content, channel, guildId });

  test("an explicit @mention in a text channel opens a thread", () => {
    expect(wantsThread(msg("<@111> plan the arm"), BOT, true)).toBe(true);
    expect(wantsThread(msg("<@!111> hi"), BOT, true)).toBe(true);
  });

  test("not when off, not in DMs, threads or other channels, not for a bare reply", () => {
    expect(wantsThread(msg("<@111> hi"), BOT, false)).toBe(false);
    expect(wantsThread(msg("<@111> hi", text, null), BOT, true)).toBe(false);
    expect(wantsThread(msg("<@111> hi", { type: ChannelType.PublicThread, isThread: () => true }), BOT, true)).toBe(false);
    expect(wantsThread(msg("<@111> hi", { type: ChannelType.GuildAnnouncement }), BOT, true)).toBe(false);
    expect(wantsThread(msg("replying without a ping"), BOT, true)).toBe(false);
    expect(wantsThread(msg("<@222> not us"), BOT, true)).toBe(false);
  });

  test("only threads the bot started count as its own", () => {
    expect(isOwnThread({ isThread: () => true, ownerId: BOT }, BOT)).toBe(true);
    expect(isOwnThread({ isThread: () => true, ownerId: "999" }, BOT)).toBe(false);
    expect(isOwnThread(text, BOT)).toBe(false);
  });

  test("threads are on by default and can be turned off per channel", () => {
    const dir = mkdtempSync(join(tmpdir(), "autothread-"));
    dirs.push(dir);
    const cfg = new ConfigManager(dir);
    expect(cfg.getAutoThread("c1")).toBe(true);
    cfg.setAutoThread("c1", false);
    cfg.setAutoThread("c1", false);
    expect(new ConfigManager(dir).getAutoThread("c1")).toBe(false);
    expect(new ConfigManager(dir).getAutoThread("c2")).toBe(true);
    cfg.setAutoThread("c1", true);
    expect(new ConfigManager(dir).getAutoThread("c1")).toBe(true);
    expect(new ConfigManager(dir).getConfig().inlineChannels).toBeUndefined();
  });
});
