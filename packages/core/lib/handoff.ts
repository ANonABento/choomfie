/**
 * Carrying a conversation across a `/brain` switch.
 *
 * Every brain keeps its own chat per location, so the brain you switch to
 * starts blank. The Discord channel is the one transcript every brain writes
 * to, so the handoff reads that, not any brain's backend, and works the same
 * whatever the old brain was. The latest messages go to the new brain as a
 * chat note on its next message (`chat-notes.ts`); `/clear` is how you start
 * fresh instead.
 */

import { addChatNote } from "./chat-notes.ts";

export interface HandoffMessage {
  author: string;
  /** Posted by the bot: shown as the brain that was answering. */
  bot: boolean;
  content: string;
  at: number;
}

/** How much of the conversation goes across. */
export const HANDOFF_CHARS = 6_000;
const PER_MESSAGE_CHARS = 600;
const MAX_AGE_MS = 24 * 3_600_000;
const FETCH_LIMIT = 40;

/** The note for the new brain, or undefined when there's nothing worth carrying. */
export function handoffNote(fromLabel: string, toLabel: string, messages: HandoffMessage[], now = Date.now(), budget = HANDOFF_CHARS): string | undefined {
  const lines: string[] = [];
  let used = 0;
  // Newest first, until the budget runs out; then put them back in order.
  for (const m of [...messages].sort((a, b) => b.at - a.at)) {
    if (now - m.at > MAX_AGE_MS) break;
    // Status lines ("-# via Groq …") are for people, not context.
    const text = m.content
      .split("\n")
      .filter((l) => !l.startsWith("-# "))
      .join("\n")
      .trim();
    if (!text) continue;
    const clipped = text.length > PER_MESSAGE_CHARS ? `${text.slice(0, PER_MESSAGE_CHARS)}…` : text;
    const line = `${m.bot ? fromLabel : m.author}: ${clipped}`;
    if (used + line.length > budget) break;
    lines.unshift(line);
    used += line.length;
  }
  if (!lines.length) return undefined;
  return [
    `The owner just moved this chat from ${fromLabel} to you (${toLabel}). Its latest messages, oldest first, so you can pick up where it left off:`,
    ...lines,
  ].join("\n");
}

interface FetchableChannel {
  messages?: {
    fetch(opts: { limit: number }): Promise<Map<string, { author: { bot: boolean; username: string; globalName?: string | null }; member?: { displayName?: string } | null; content: string; createdTimestamp: number }>>;
  };
}

/** Read the channel's latest messages and leave the handoff for the new brain. False when nothing was carried. */
export async function carryContext(channel: unknown, locationId: string, fromLabel: string, toLabel: string): Promise<boolean> {
  const fetch = (channel as FetchableChannel | null)?.messages?.fetch;
  if (!fetch) return false;
  try {
    const got = await fetch.call((channel as FetchableChannel).messages, { limit: FETCH_LIMIT });
    const messages: HandoffMessage[] = [...got.values()].map((m) => ({
      author: m.member?.displayName ?? m.author.globalName ?? m.author.username,
      bot: m.author.bot,
      content: m.content,
      at: m.createdTimestamp,
    }));
    const note = handoffNote(fromLabel, toLabel, messages);
    if (!note) return false;
    addChatNote(locationId, note);
    return true;
  } catch (e) {
    console.error(`[handoff] couldn't read the conversation to carry: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}
