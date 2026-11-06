/**
 * Chats: location → conversation bindings, the Claude chat the daemon holds,
 * Waymond's one-time import, and the daemon-side pieces behind /chat.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_BRAIN, parseDaemonControlRequest, titleFrom, UNTITLED_CHAT } from "@choomfie/shared";
import { ChatStore } from "../lib/chats/store.ts";
import { applyClaudeHold, CLAUDE_GLOBAL } from "../lib/chats/claude.ts";
import { resolveChatCwd, shortPath } from "../lib/chats/here.ts";
import { isOwnThread, wantsThread } from "../lib/chats/auto-thread.ts";
import { ConfigManager } from "../lib/config.ts";
import { ChannelType } from "discord.js";
import { parseChatState, withSeed } from "../daemon/chat-state.ts";
import { announcementFor } from "../daemon/runtime.ts";
import { PLUGIN_DIR } from "../daemon/constants.ts";

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

describe("Claude chat from the daemon's snapshot", () => {
  test("creates the record bound to the shared slot, titled by the first message", () => {
    const chats = store();
    const chat = applyClaudeHold(chats, { id: "c1", cwd: "/p", sdkSessionId: null }, "plan the robot arm")!;
    expect(chat.title).toBe("plan the robot arm");
    expect(chat.brain).toBe(CLAUDE_BRAIN);
    expect(chats.bound(CLAUDE_GLOBAL, CLAUDE_BRAIN)?.id).toBe("c1");
  });

  test("follows the live SDK session id and names an untitled chat once", () => {
    const chats = store();
    applyClaudeHold(chats, { id: "c1", cwd: "/p", sdkSessionId: null });
    expect(chats.get("c1")!.title).toBe(UNTITLED_CHAT);
    applyClaudeHold(chats, { id: "c1", cwd: "/p", sdkSessionId: "s1" }, "first words");
    applyClaudeHold(chats, { id: "c1", cwd: "/p", sdkSessionId: "s2" }, "later words");
    const got = chats.get("c1")!;
    expect(got.title).toBe("first words");
    expect(got.backendRef).toBe("s2");
  });

  test("a new held chat takes over the shared slot", () => {
    const chats = store();
    applyClaudeHold(chats, { id: "c1", cwd: "/p", sdkSessionId: "s1" });
    applyClaudeHold(chats, { id: "c2", cwd: "/q", sdkSessionId: null });
    expect(chats.bound(CLAUDE_GLOBAL, CLAUDE_BRAIN)?.id).toBe("c2");
    expect(chats.get("c1")!.backendRef).toBe("s1");
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

describe("daemon control: clear and resume", () => {
  const base = { requestedAt: Date.now() };
  test("resume carries the chat, session and cwd; clear can carry a cwd", () => {
    const r = parseDaemonControlRequest({ ...base, command: "resume", targetChat: "c1", sdkSessionId: "s1", cwd: "/p", title: "t" });
    expect(r).toMatchObject({ command: "resume", targetChat: "c1", sdkSessionId: "s1", cwd: "/p", title: "t" });
    expect(parseDaemonControlRequest({ ...base, command: "clear", cwd: "/q" })?.cwd).toBe("/q");
    expect(parseDaemonControlRequest({ ...base, command: "new", targetChat: "c2" })).toBeNull();
  });

  test("resume is refused without what the daemon needs to act", () => {
    expect(parseDaemonControlRequest({ ...base, command: "resume", targetChat: "c1" })).toBeNull();
  });
});

describe("daemon chat state", () => {
  test("parses only a well-formed file", () => {
    expect(parseChatState({ current: { id: "c", cwd: "/p" }, seeds: { c: "s", bad: 1 } })).toEqual({
      current: { id: "c", cwd: "/p" },
      seeds: { c: "s" },
    });
    expect(parseChatState({ current: { id: 1 } })).toBeNull();
  });

  test("seeds are replaced per chat and capped", () => {
    let seeds: Record<string, string> = {};
    for (let i = 0; i < 40; i++) seeds = withSeed(seeds, `c${i}`, `s${i}`);
    expect(Object.keys(seeds).length).toBe(30);
    expect(seeds.c39).toBe("s39");
    expect(seeds.c0).toBeUndefined();
    expect(withSeed({ a: "1" }, "a", undefined)).toEqual({});
  });

  test("the replacement session is told what happened", () => {
    expect(announcementFor({ requestedCommand: "resume", chatTitle: "arm" }, undefined, PLUGIN_DIR)).toContain('"arm" was just resumed');
    expect(announcementFor({ requestedCommand: "clear" }, undefined, "/tmp/x")).toContain("working in /tmp/x");
    expect(announcementFor({ requestedCommand: "clear" }, undefined, PLUGIN_DIR)).toContain("/clear");
    expect(announcementFor({ requestedCommand: "compact" }, "sum", PLUGIN_DIR)).toContain("compacted");
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
