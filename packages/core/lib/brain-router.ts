/**
 * Brain router — decides who answers a Discord message, and delivers non-Claude
 * replies.
 *
 * Runs in the worker *after* the trigger rules, the allowlist and the rate
 * limit, and *before* the message is forwarded to Claude. It never widens
 * access: `brainAccess` can only narrow who reaches a non-Claude brain, and
 * anyone it turns away still gets the normal Claude path.
 *
 * The per-channel brain map is routing only. It is never consulted to decide
 * whether someone may talk to Choomfie at all — that stays in access.json.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import {
  CLAUDE_BRAIN,
  errorMessage,
  getBrain,
  setBrainPoster,
  type Brain,
  type BrainMessage,
  type BrainReply,
} from "@choomfie/shared";
import type { BrainAccess } from "./config.ts";
import type { AppContext } from "./types.ts";
import { onReplySent } from "./typing.ts";

export type RouteDecision =
  /** Forward to the Claude session as usual. */
  | { kind: "claude" }
  /** Hand to a registered brain. */
  | { kind: "brain"; brain: Brain }
  /** Channel is set to a brain that isn't loaded (plugin disabled, crashed). */
  | { kind: "unavailable"; brainId: string }
  /** Brain channel, but a conversation-mode message: nobody answers. */
  | { kind: "ignore" };

export interface RouteInput {
  channelId: string;
  /** Parent channel of a thread, so threads inherit their channel's brain. */
  parentId?: string | null;
  isOwner: boolean;
  /** Ambient message picked up because the channel is mid-conversation (not a mention/reply/DM). */
  isConversationMode: boolean;
  access: BrainAccess;
  channelBrain: (channelId: string) => string | undefined;
  lookup?: (id: string) => Brain | undefined;
}

/** The brain id configured for a channel, falling back to its parent, then claude. */
export function resolveBrainId(
  channelId: string,
  parentId: string | null | undefined,
  channelBrain: (channelId: string) => string | undefined
): string {
  return channelBrain(channelId) ?? (parentId ? channelBrain(parentId) : undefined) ?? CLAUDE_BRAIN;
}

export function decideRoute(input: RouteInput): RouteDecision {
  const brainId = resolveBrainId(input.channelId, input.parentId, input.channelBrain);
  if (brainId === CLAUDE_BRAIN) return { kind: "claude" };

  // Upstream already required the allowlist; this only narrows further.
  const permitted = input.isOwner || input.access === "allowlist";
  if (!permitted) return { kind: "claude" };

  // Claude reads ambient conversation and chooses to stay quiet. A brain
  // driver can't, so it only answers messages addressed to it.
  if (input.isConversationMode) return { kind: "ignore" };

  const brain = (input.lookup ?? getBrain)(brainId);
  return brain ? { kind: "brain", brain } : { kind: "unavailable", brainId };
}

const DISCORD_LIMIT = 2000;

/** Split on paragraph/line boundaries where possible, hard-cut otherwise. */
export function chunkForDiscord(text: string, limit = DISCORD_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
    const at = cut > limit / 2 ? cut : limit;
    chunks.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export interface SendableChannel {
  send(options: {
    content?: string;
    files?: string[];
    reply?: { messageReference: string };
    components?: unknown[];
  }): Promise<{ id: string } | unknown>;
}

/** Discord: 5 buttons per row, 5 rows, 80-char labels, 100-char custom ids. */
const MAX_CHOICES = 25;

export interface PendingChoices {
  brainId: string;
  chatKey: string;
  choices: string[];
}

/** Button message id → the quick replies it offers. In memory: a restart expires them. */
const pendingChoices = new Map<string, PendingChoices>();

export function takeChoices(messageId: string): PendingChoices | undefined {
  const p = pendingChoices.get(messageId);
  pendingChoices.delete(messageId);
  return p;
}

export function choiceRows(choices: string[]) {
  const rows = [];
  for (let r = 0; r * 5 < Math.min(choices.length, MAX_CHOICES); r++) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        choices.slice(r * 5, r * 5 + 5).map((label, i) =>
          new ButtonBuilder()
            .setCustomId(`brain:choice:${r * 5 + i}`)
            .setLabel(label.length > 80 ? label.slice(0, 77) + "…" : label)
            .setStyle(ButtonStyle.Secondary)
        )
      )
    );
  }
  return rows;
}

/** Post a brain's reply: chunked, threaded to `replyTo` when given, quick replies as buttons on the last chunk. */
export async function postBrainReply(
  channel: SendableChannel,
  brainId: string,
  chatKey: string,
  reply: BrainReply,
  replyTo?: string
): Promise<void> {
  const choices = (reply.choices ?? []).filter(Boolean).slice(0, MAX_CHOICES);
  const chunks = chunkForDiscord(reply.text || (choices.length ? "(pick one)" : "(no reply)"));
  for (let i = 0; i < chunks.length; i++) {
    const last = i === chunks.length - 1;
    const sent = await channel.send({
      content: chunks[i],
      ...(i === 0 && replyTo ? { reply: { messageReference: replyTo } } : {}),
      ...(last && reply.files?.length ? { files: reply.files } : {}),
      ...(last && choices.length ? { components: choiceRows(choices) } : {}),
    });
    const id = (sent as { id?: unknown } | undefined)?.id;
    if (last && choices.length && typeof id === "string") pendingChoices.set(id, { brainId, chatKey, choices });
  }
}

/** Lets plugins post late results (background jobs) through the same formatting. */
export function installBrainPoster(ctx: AppContext): void {
  setBrainPoster(async (brainId, chatKey, reply) => {
    const channel = await ctx.discord?.channels.fetch(chatKey).catch(() => null);
    if (!channel || !("send" in channel)) throw new Error(`channel ${chatKey} not reachable`);
    await postBrainReply(channel as unknown as SendableChannel, brainId, chatKey, reply);
  });
}

/** One in-flight request per backend conversation; later messages queue behind it. */
const queues = new Map<string, Promise<void>>();

export function dispatchToBrain(
  ctx: AppContext,
  brain: Brain,
  channel: SendableChannel,
  message: BrainMessage & { messageId: string }
): Promise<void> {
  const prev = queues.get(message.chatKey) ?? Promise.resolve();
  const run = prev.then(async () => {
    try {
      const reply = await brain.send(message, ctx);
      await postBrainReply(channel, brain.id, message.chatKey, reply, message.messageId);
    } catch (e) {
      console.error(`[brain:${brain.id}] ${errorMessage(e)}`);
      await channel
        .send({
          content: `⚠️ ${brain.label} didn't answer: ${errorMessage(e).slice(0, 300)}`,
          reply: { messageReference: message.messageId },
        })
        .catch(() => {});
    } finally {
      onReplySent(message.chatKey);
    }
  });
  const tail = run.finally(() => {
    if (queues.get(message.chatKey) === tail) queues.delete(message.chatKey);
  });
  queues.set(message.chatKey, tail);
  return run;
}
