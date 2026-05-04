/**
 * Local-mode Discord handler — replaces the MCP-forward path when
 * ctx.localRuntime is active. Routes user messages through the LocalRuntime
 * (Ollama) and replies directly to the channel.
 *
 * Persona prompt is built from ConfigManager. Per-channel history is kept
 * in-memory (size-capped) and decays after the conversation timeout.
 */

import type { Message, TextBasedChannel } from "discord.js";
import type { AppContext } from "../types.ts";
import { onReplySent } from "../typing.ts";
import type { RoutingHints } from "./model-router.ts";

const HISTORY_PER_CHANNEL = 12;
const MAX_REPLY_CHARS = 1900;

type SendableChannel = TextBasedChannel & {
  send: (content: string) => Promise<unknown>;
};

function asSendable(channel: Message["channel"]): SendableChannel | null {
  if (!channel.isTextBased() || !("send" in channel)) return null;
  return channel as SendableChannel;
}

type HistoryEntry = { role: "user" | "assistant"; content: string; at: number };
const channelHistory = new Map<string, HistoryEntry[]>();

function pushHistory(channelId: string, entry: HistoryEntry, idleMs: number) {
  const now = Date.now();
  let entries = channelHistory.get(channelId);
  if (!entries) {
    entries = [];
    channelHistory.set(channelId, entries);
  }
  // Drop entries older than idle threshold; conversation has decayed.
  while (entries.length > 0 && now - entries[0].at > idleMs) {
    entries.shift();
  }
  entries.push(entry);
  while (entries.length > HISTORY_PER_CHANNEL) entries.shift();
}

function getHistory(channelId: string): Array<{ role: "user" | "assistant"; content: string }> {
  const entries = channelHistory.get(channelId) ?? [];
  return entries.map((e) => ({ role: e.role, content: e.content }));
}

function buildPersonaPrompt(ctx: AppContext): string {
  const persona = ctx.config.getActivePersona();
  return [
    `You are ${persona.name}. ${persona.personality}`,
    "",
    "Reply concisely. You're chatting in Discord — keep it short, casual, in character.",
    "If you don't know something, say so plainly. Don't invent tool calls or file paths.",
  ].join("\n");
}

function chunkMessage(text: string): string[] {
  if (text.length <= MAX_REPLY_CHARS) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_REPLY_CHARS) {
    let cut = remaining.lastIndexOf("\n", MAX_REPLY_CHARS);
    if (cut < MAX_REPLY_CHARS / 2) cut = MAX_REPLY_CHARS;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export interface LocalHandlerArgs {
  /** The Discord message that triggered the reply */
  message: Message;
  /** Cleaned message text (mention-stripped) */
  content: string;
  /** Channel meta (built upstream so attachments are already accounted for) */
  meta: Record<string, string>;
}

/** Handle a Discord message by routing it through the LocalRuntime. */
export async function handleLocalMessage(
  ctx: AppContext,
  args: LocalHandlerArgs,
): Promise<void> {
  const runtime = ctx.localRuntime;
  if (!runtime) return;

  const { message, content, meta } = args;
  const channelId = message.channelId;
  const idleMs = ctx.config.getConvoTimeoutMs();

  const hints: RoutingHints = {
    conversational: meta.conversation_mode === "true",
  };

  const personaPrompt = buildPersonaPrompt(ctx);
  const history = getHistory(channelId);

  pushHistory(channelId, { role: "user", content, at: Date.now() }, idleMs);

  let result;
  try {
    result = await runtime.reply(content, {
      personaPrompt,
      history,
      hints,
    });
  } catch (e: unknown) {
    onReplySent(channelId);
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`[local] reply failed: ${reason}`);
    await asSendable(message.channel)
      ?.send(`Local model error: ${reason}`)
      .catch(() => {});
    return;
  }

  onReplySent(channelId);

  const text = result.text.trim() || "(empty reply)";
  pushHistory(channelId, { role: "assistant", content: text, at: Date.now() }, idleMs);

  ctx.messageStats.sent++;

  const sender = asSendable(message.channel);
  if (!sender) return;
  for (const chunk of chunkMessage(text)) {
    await sender.send(chunk).catch((e: unknown) => {
      console.error(`[local] send failed: ${e}`);
    });
  }

  console.error(
    `[local] ${result.decision.route}/${result.decision.model} reason=${result.decision.reason} ` +
      `total=${result.totalMs.toFixed(0)}ms ttft=${result.firstTokenMs?.toFixed(0) ?? "?"}ms` +
      (result.tps ? ` tps=${result.tps.toFixed(1)}` : ""),
  );
}

/** Drop history for a channel — used on persona switch to avoid bleed-through. */
export function clearLocalHistory(channelId?: string) {
  if (channelId) channelHistory.delete(channelId);
  else channelHistory.clear();
}
