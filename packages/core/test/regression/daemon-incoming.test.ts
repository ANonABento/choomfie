/**
 * The worker→daemon inbound-message channel.
 *
 * Daemon sessions cannot register Claude Code's `claude/channel` capability, so
 * a Discord message reaches them as a file in `meta/incoming` rather than an MCP
 * notification. These tests guard the properties that keep that substitution
 * invisible: the prompt Claude sees is byte-identical to the one the capability
 * would have built, a message is delivered exactly once, and a message nobody
 * consumed is discarded rather than answered hours later.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INCOMING_MAX_PENDING,
  INCOMING_MESSAGE_STALE_MS,
  daemonIncomingDir,
  inboundMessageFilename,
  isDaemonOwnedProcess,
  isInboundMessageStale,
  parseInboundMessage,
} from "@choomfie/shared";
import { deliverInboundMessage } from "../../lib/daemon-status.ts";
import { consumeIncoming, formatChannelPrompt } from "../../daemon/incoming.ts";

const dirs: string[] = [];
function newDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "choomfie-incoming-"));
  mkdirSync(join(dir, "meta"), { recursive: true });
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const META = { chat_id: "123", user: "kev", message_id: "999" };

describe("channel prompt format", () => {
  test("matches the block Claude Code builds from a channel notification", () => {
    // Decompiled from the SDK's bundled cli.js: `<channel source="…" k="v">`,
    // newline, the raw body, newline, closing tag. The persona and tool
    // instructions were written against this shape in foreground mode.
    expect(formatChannelPrompt("hey", META)).toBe(
      '<channel source="choomfie" chat_id="123" user="kev" message_id="999">\n' +
        "hey\n" +
        "</channel>",
    );
  });

  test("escapes attribute values so a quote in a username cannot break the tag", () => {
    const prompt = formatChannelPrompt("hi", { user: `a"b&c<d>e'f` });
    expect(prompt).toContain(`user="a&quot;b&amp;c&lt;d&gt;e&apos;f"`);
    expect(prompt.split("\n")[0]!.endsWith('">')).toBe(true);
  });

  test("leaves the body raw, as Claude Code does", () => {
    // The body is content, not markup — escaping it would show the user their
    // own message mangled back at them.
    expect(formatChannelPrompt("2 < 3 & \"quoted\"", {})).toContain('2 < 3 & "quoted"');
  });

  test("drops meta keys that are not valid attribute names", () => {
    const prompt = formatChannelPrompt("hi", { "not-a-name": "x", ok_1: "y" });
    expect(prompt).toContain('ok_1="y"');
    expect(prompt).not.toContain("not-a-name");
  });

  test("a message with no meta still produces a well-formed block", () => {
    expect(formatChannelPrompt("hi")).toBe('<channel source="choomfie">\nhi\n</channel>');
  });
});

describe("message parsing", () => {
  test("a half-written or junk file reads as no message", () => {
    for (const junk of [null, undefined, 42, "hi", [], {}, { content: "hi" }]) {
      expect(parseInboundMessage(junk)).toBeNull();
    }
  });

  test("drops non-string meta values rather than coercing them", () => {
    // Meta becomes XML attributes; a nested object would reach Claude as
    // `[object Object]`.
    const parsed = parseInboundMessage({
      content: "hi",
      receivedAt: Date.now(),
      meta: { user: "kev", attachments: { name: "x" }, count: 3 },
    });
    expect(parsed?.meta).toEqual({ user: "kev" });
  });

  test("an empty message body is still a message", () => {
    // The worker substitutes a placeholder for empty content, but a bare
    // @mention must not read as a malformed file.
    expect(parseInboundMessage({ content: "", receivedAt: Date.now() })).not.toBeNull();
  });
});

describe("staleness", () => {
  test("a message written while the daemon was down is not answered later", () => {
    const old = { content: "hi", meta: {}, receivedAt: Date.now() - INCOMING_MESSAGE_STALE_MS - 1 };
    expect(isInboundMessageStale(old)).toBe(true);
    expect(isInboundMessageStale({ content: "hi", meta: {}, receivedAt: Date.now() })).toBe(false);
  });
});

describe("routing", () => {
  test("only a daemon-launched process uses the incoming queue", () => {
    // The worker inherits CHOOMFIE_DAEMON_PID through the supervisor. Exactly
    // one delivery route per process: get this wrong and messages are either
    // dropped (foreground writing files nobody reads) or doubled.
    expect(isDaemonOwnedProcess({ CHOOMFIE_DAEMON_PID: "4242" })).toBe(true);
    expect(isDaemonOwnedProcess({})).toBe(false);
  });
});

describe("worker side", () => {
  test("writes a message the daemon's parser accepts", async () => {
    const dir = newDataDir();
    await deliverInboundMessage(dir, "hey there", META);

    const names = readdirSync(daemonIncomingDir(dir));
    expect(names).toHaveLength(1);

    const parsed = parseInboundMessage(
      JSON.parse(await readFile(join(daemonIncomingDir(dir), names[0]!), "utf-8")),
    );
    expect(parsed!.content).toBe("hey there");
    expect(parsed!.meta).toEqual(META);
    expect(isInboundMessageStale(parsed!)).toBe(false);
  });

  test("messages queue rather than overwrite each other", async () => {
    // Unlike a control request, where the newest wins, every Discord message
    // has to be delivered.
    const dir = newDataDir();
    await deliverInboundMessage(dir, "first", { ...META, message_id: "1" });
    await deliverInboundMessage(dir, "second", { ...META, message_id: "2" });

    expect(readdirSync(daemonIncomingDir(dir))).toHaveLength(2);
  });

  test("filenames sort chronologically", () => {
    // consumeIncoming orders by filename, so this is what preserves conversation
    // order across a batch.
    const early = inboundMessageFilename(1_700_000_000_000, "b");
    const late = inboundMessageFilename(1_700_000_000_001, "a");
    expect([late, early].sort()).toEqual([early, late]);
  });

  test("a message id that is not filename-safe cannot escape the incoming directory", () => {
    expect(inboundMessageFilename(1, "../../etc/passwd")).toBe("1-etcpasswd.json");
  });

  test("stops the queue growing without bound when nothing consumes it", async () => {
    const dir = newDataDir();
    for (let i = 0; i < INCOMING_MAX_PENDING + 5; i++) {
      await deliverInboundMessage(dir, `m${i}`, { ...META, message_id: String(i) });
    }

    const names = readdirSync(daemonIncomingDir(dir)).sort();
    expect(names).toHaveLength(INCOMING_MAX_PENDING);
    // The oldest are the ones dropped: recent messages are the ones still
    // worth answering.
    expect(names.some((n) => n.endsWith("-0.json"))).toBe(false);
  });
});

describe("daemon side", () => {
  test("an empty or absent queue is not an error", async () => {
    const dir = newDataDir();
    expect(await consumeIncoming(daemonIncomingDir(dir))).toEqual([]);
    mkdirSync(daemonIncomingDir(dir), { recursive: true });
    expect(await consumeIncoming(daemonIncomingDir(dir))).toEqual([]);
  });

  test("delivers in arrival order and consumes exactly once", async () => {
    const dir = newDataDir();
    await deliverInboundMessage(dir, "first", { ...META, message_id: "1" });
    await deliverInboundMessage(dir, "second", { ...META, message_id: "2" });

    const messages = await consumeIncoming(daemonIncomingDir(dir));
    expect(messages.map((m) => m.content)).toEqual(["first", "second"]);

    // Deleted before the caller prompts, so a crash mid-turn cannot replay the
    // message into the session that replaces this one.
    expect(readdirSync(daemonIncomingDir(dir))).toHaveLength(0);
    expect(await consumeIncoming(daemonIncomingDir(dir))).toEqual([]);
  });

  test("garbage is consumed too, not re-read every second", async () => {
    const dir = newDataDir();
    const incoming = daemonIncomingDir(dir);
    mkdirSync(incoming, { recursive: true });
    const path = join(incoming, "1-junk.json");
    writeFileSync(path, "{not json");

    expect(await consumeIncoming(incoming)).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  test("a stale message is deleted and never delivered", async () => {
    const dir = newDataDir();
    const incoming = daemonIncomingDir(dir);
    mkdirSync(incoming, { recursive: true });
    const path = join(incoming, "1-old.json");
    writeFileSync(
      path,
      JSON.stringify({
        content: "yesterday's question",
        meta: META,
        receivedAt: Date.now() - INCOMING_MESSAGE_STALE_MS - 1000,
      }),
    );

    expect(await consumeIncoming(incoming)).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  test("one bad file does not block the messages behind it", async () => {
    const dir = newDataDir();
    const incoming = daemonIncomingDir(dir);
    mkdirSync(incoming, { recursive: true });
    writeFileSync(join(incoming, "1-bad.json"), "{not json");
    writeFileSync(
      join(incoming, "2-good.json"),
      JSON.stringify({ content: "still here", meta: META, receivedAt: Date.now() }),
    );

    const messages = await consumeIncoming(incoming);
    expect(messages.map((m) => m.content)).toEqual(["still here"]);
  });

  test("ignores files that are not ours", async () => {
    const dir = newDataDir();
    const incoming = daemonIncomingDir(dir);
    mkdirSync(incoming, { recursive: true });
    // writeJsonAtomic's temp files live next to the target; sweeping one
    // mid-write would read a partial file and delete the real message.
    writeFileSync(join(incoming, "1-x.json.123.456.tmp"), "half a fi");

    expect(await consumeIncoming(incoming)).toEqual([]);
    expect(existsSync(join(incoming, "1-x.json.123.456.tmp"))).toBe(true);
  });
});
