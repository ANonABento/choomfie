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

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import {
  CLAUDE_BRAIN,
  errorMessage,
  getBrain,
  setBrainPoster,
  type Brain,
  type BrainApproval,
  type BrainMessage,
  type BrainReply,
  type BrainTask,
} from "@choomfie/shared";
import type { BrainAccess } from "./config.ts";
import type { AppContext } from "./types.ts";
import { onReplySent } from "./typing.ts";
import { getBrainRelay } from "./ask-relay.ts";
import { findPatch, offerPatch } from "./patch-pr.ts";

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
    files?: { attachment: Buffer; name: string }[];
    reply?: { messageReference: string };
    components?: unknown[];
    embeds?: unknown[];
    allowedMentions?: { parse: never[]; repliedUser?: boolean };
  }): Promise<{ id: string } | unknown>;
}

/**
 * Brain output is outside text: an `@everyone` or `<@&role>` in it must not
 * ping anyone. Replying to the asker still notifies them, as a normal reply.
 */
export const NO_MENTIONS = { parse: [] as never[], repliedUser: true };

/** The parent channel of a thread, so a thread can inherit its channel's brain. */
export function parentChannelId(channel: unknown): string | null {
  const c = channel as { isThread?: () => boolean; parentId?: string | null } | null;
  return c?.isThread?.() ? (c.parentId ?? null) : null;
}

export interface PendingApproval {
  brainId: string;
  chatKey: string;
  approval: BrainApproval;
}

/** Approval card message id → what it approves. In memory: a restart expires them (approve in the app instead). */
const pendingApprovals = new Map<string, PendingApproval>();

export function getPendingApproval(messageId: string): PendingApproval | undefined {
  return pendingApprovals.get(messageId);
}

export function clearPendingApproval(messageId: string): void {
  pendingApprovals.delete(messageId);
}

export function approvalMessage(brainLabel: string, approval: BrainApproval) {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle(`${brainLabel} wants your OK: ${approval.title}`.slice(0, 256))
        .setDescription(approval.detail.slice(0, 4000) || "(no preview)")
        .setFooter({ text: "Only the owner can approve or decline this." }),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("brain:approval:yes").setLabel(approval.approveLabel.slice(0, 80) || "Approve").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("brain:approval:no").setLabel(approval.declineLabel.slice(0, 80) || "Decline").setStyle(ButtonStyle.Secondary)
      ),
    ],
  };
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

export type TaskState = { kind: "idle" } | { kind: "running" | "done" | "failed"; url: string };

export interface TaskBoard {
  brainId: string;
  tasks: BrainTask[];
  context?: string;
  states: TaskState[];
}

/** Task-board message id → its plan's tasks and how each is going. In memory: a restart expires them. */
const taskBoards = new Map<string, TaskBoard>();

export function getTaskBoard(messageId: string): TaskBoard | undefined {
  return taskBoards.get(messageId);
}

const TASK_ICON = { running: "⏳", done: "✅", failed: "❌" } as const;

/** A button per task: runnable until started, then a link to its thread showing how it went. */
export function taskBoardRows(board: Pick<TaskBoard, "tasks" | "states">) {
  const rows = [];
  for (let r = 0; r * 5 < board.tasks.length; r++) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        board.tasks.slice(r * 5, r * 5 + 5).map((t, j) => {
          const i = r * 5 + j;
          const state = board.states[i] ?? { kind: "idle" };
          const label = `${t.n} · ${t.mode} · ${t.title}`;
          const b = new ButtonBuilder();
          if (state.kind === "idle") {
            return b.setCustomId(`brain:task:${i}`).setLabel(`▶ ${label}`.slice(0, 80)).setStyle(ButtonStyle.Secondary);
          }
          return b.setURL(state.url).setLabel(`${TASK_ICON[state.kind]} ${label}`.slice(0, 80)).setStyle(ButtonStyle.Link);
        })
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
  const fallback = choices.length ? "(pick one)" : reply.approvals?.length || reply.files?.length ? "" : "(no reply)";
  const chunks = chunkForDiscord(reply.text || fallback);
  if (!chunks.length && reply.files?.length) chunks.push(""); // files alone still need a message
  for (let i = 0; i < chunks.length; i++) {
    const last = i === chunks.length - 1;
    const sent = await channel.send({
      allowedMentions: NO_MENTIONS,
      content: chunks[i],
      ...(i === 0 && replyTo ? { reply: { messageReference: replyTo } } : {}),
      ...(last && reply.files?.length
        ? { files: reply.files.map((f) => ({ attachment: Buffer.from(f.data), name: f.name })) }
        : {}),
      ...(last && choices.length ? { components: choiceRows(choices) } : {}),
    });
    const id = (sent as { id?: unknown } | undefined)?.id;
    if (last && choices.length && typeof id === "string") pendingChoices.set(id, { brainId, chatKey, choices });
  }
  // A plan's tasks: one button each, which runs it in its own thread (owner only).
  if (reply.tasks?.length) {
    const board: TaskBoard = { brainId, tasks: reply.tasks, context: reply.taskContext, states: reply.tasks.map(() => ({ kind: "idle" })) };
    const sent = await channel.send({
      allowedMentions: NO_MENTIONS,
      content: "📋 **Tasks** — click one to run it in its own thread.",
      components: taskBoardRows(board),
    });
    const id = (sent as { id?: unknown } | undefined)?.id;
    if (typeof id === "string") taskBoards.set(id, board);
  }
  // A patch made in the brain's sandbox: the owner can turn it into a draft PR.
  const patch = findPatch(reply.text, reply.files);
  if (patch) {
    const sent = await channel.send({
      allowedMentions: NO_MENTIONS,
      content: `📦 Patch for **${patch.repo}** (\`${patch.file.name}\`)`,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("brain:pr").setLabel("Open draft PR").setStyle(ButtonStyle.Primary)
        ),
      ],
    });
    const id = (sent as { id?: unknown } | undefined)?.id;
    if (typeof id === "string") offerPatch(id, patch);
  }
  // One message per approval, so each card is resolved on its own.
  const label = getBrain(brainId)?.label ?? brainId;
  for (const approval of reply.approvals ?? []) {
    const sent = await channel.send({ ...approvalMessage(label, approval), allowedMentions: NO_MENTIONS });
    const id = (sent as { id?: unknown } | undefined)?.id;
    if (typeof id === "string") pendingApprovals.set(id, { brainId, chatKey, approval });
  }
}

/** Lets plugins post late results (background jobs) through the same formatting. */
export function installBrainPoster(ctx: AppContext): void {
  setBrainPoster(async (brainId, chatKey, reply) => {
    const fetched = await ctx.discord?.channels.fetch(chatKey).catch(() => null);
    // A chat the bot isn't in (group DM /choomfie) can still be answered while its
    // interaction is open; after that the result stays in the brain's own app.
    const channel = fetched && "send" in fetched ? (fetched as unknown as SendableChannel) : getBrainRelay(chatKey);
    if (!channel) throw new Error(`channel ${chatKey} not reachable`);
    await postBrainReply(channel, brainId, chatKey, reply);
  });
}

/** One in-flight request per backend conversation; later messages queue behind it. */
const queues = new Map<string, Promise<unknown>>();

export function dispatchToBrain(
  ctx: AppContext,
  brain: Brain,
  channel: SendableChannel,
  /** `messageId` anchors the reply; omit it when the message is in another channel. */
  message: BrainMessage & { messageId?: string }
): Promise<boolean> {
  const prev = queues.get(message.chatKey) ?? Promise.resolve();
  const run = prev.then(async () => {
    try {
      const reply = await brain.send(message, ctx);
      await postBrainReply(channel, brain.id, message.chatKey, reply, message.messageId);
      return true;
    } catch (e) {
      console.error(`[brain:${brain.id}] ${errorMessage(e)}`);
      await channel
        .send({
          allowedMentions: NO_MENTIONS,
          content: `⚠️ ${brain.label} didn't answer: ${errorMessage(e).slice(0, 300)}`,
          ...(message.messageId ? { reply: { messageReference: message.messageId } } : {}),
        })
        .catch(() => {});
      return false;
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
