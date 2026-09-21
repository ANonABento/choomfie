/**
 * Reads inbound Discord messages written by the worker (see
 * `@choomfie/shared/daemon-incoming.ts`) and turns them into session prompts.
 *
 * This is the daemon's stand-in for the `claude/channel` capability, which no
 * Agent SDK session can register. Everything that capability does, once it is
 * past its gates, is three lines: take `{ content, meta }` off the notification,
 * format them into a `<channel>` block, and push that onto the prompt queue.
 * The daemon owns the prompt queue outright, so it can do the same thing
 * without asking anyone's permission.
 */

import { readdir, readFile, unlink } from "node:fs/promises";
import {
  daemonIncomingDir,
  isInboundMessageStale,
  parseInboundMessage,
  type InboundMessage,
} from "@choomfie/shared";
import { DATA_DIR } from "./constants.ts";
import { getErrorMessage } from "./error.ts";
import { log } from "./log.ts";

const INCOMING_DIR = daemonIncomingDir(DATA_DIR);

/** Meta keys Claude Code accepts as attributes; anything else it drops. */
const ATTRIBUTE_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Attribute-value escaping, matching Claude Code's own. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Render a message exactly as Claude Code renders a channel notification:
 *
 *   <channel source="choomfie" chat_id="…" user="…">
 *   the message
 *   </channel>
 *
 * Byte-for-byte deliberately. The persona and the tool instructions were
 * written against this shape in foreground mode, and a daemon session that saw
 * a different one would behave differently for reasons nobody could see. Meta
 * keys that are not valid attribute names are dropped, and values are escaped;
 * the body is inserted raw, as Claude Code inserts it.
 */
export function formatChannelPrompt(
  content: string,
  meta: Record<string, string> = {},
  source = "choomfie",
): string {
  const attributes = Object.entries(meta)
    .filter(([key]) => ATTRIBUTE_KEY.test(key))
    .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
    .join("");

  return `<channel source="${escapeAttribute(source)}"${attributes}>\n${content}\n</channel>`;
}

/**
 * Consume every pending message in `dir`, oldest first.
 *
 * Consume-once, like `consumeControlRequest`: each file is deleted *before* it
 * is returned, so a crash between reading and prompting loses the message
 * rather than replaying it into the next session. Malformed files are deleted
 * on the same principle — left in place, an unparseable file would be re-read
 * every second forever.
 *
 * Takes the path so it can be tested; `takeInboundMessages` is the real caller.
 */
export async function consumeIncoming(dir: string): Promise<InboundMessage[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch {
    return []; // No incoming directory yet — the common case until the first message.
  }

  // Filenames lead with epoch ms, so sorting them is sorting by arrival.
  names.sort();

  const messages: InboundMessage[] = [];
  for (const name of names) {
    const path = `${dir}/${name}`;

    let raw: string | null = null;
    try {
      raw = await readFile(path, "utf-8");
    } catch {
      continue; // Already swept, or being written right now — next pass gets it.
    }

    try {
      await unlink(path);
    } catch {
      // Already gone. Staleness covers anything we somehow fail to remove.
    }

    let message: InboundMessage | null = null;
    try {
      message = parseInboundMessage(JSON.parse(raw));
    } catch (error: unknown) {
      log(`Discarding unparseable inbound message: ${getErrorMessage(error)}`);
      continue;
    }
    if (!message) {
      log("Discarding malformed inbound message");
      continue;
    }

    if (isInboundMessageStale(message)) {
      const age = Math.round((Date.now() - message.receivedAt) / 1000);
      log(`Discarding stale inbound message (${age}s old)`);
      continue;
    }

    messages.push(message);
  }

  return messages;
}

export function takeInboundMessages(): Promise<InboundMessage[]> {
  return consumeIncoming(INCOMING_DIR);
}
