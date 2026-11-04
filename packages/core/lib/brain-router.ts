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

import {
  CLAUDE_BRAIN,
  errorMessage,
  getBrain,
  type Brain,
  type BrainMessage,
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

interface SendableChannel {
  send(options: { content?: string; files?: string[]; reply?: { messageReference: string } }): Promise<unknown>;
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
      const chunks = chunkForDiscord(reply.text || "(no reply)");
      for (let i = 0; i < chunks.length; i++) {
        const last = i === chunks.length - 1;
        await channel.send({
          content: chunks[i],
          ...(i === 0 ? { reply: { messageReference: message.messageId } } : {}),
          ...(last && reply.files?.length ? { files: reply.files } : {}),
        });
      }
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
