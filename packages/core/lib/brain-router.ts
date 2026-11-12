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
  fileBatches,
  getBrain,
  setBrainPoster,
  type Brain,
  type BrainApproval,
  type BrainMessage,
  type BrainReply,
  type BrainFile,
  type BrainTask,
  writeJsonAtomicSync,
} from "@choomfie/shared";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrainAccess } from "./config.ts";
import type { AppContext } from "./types.ts";
import { onReplySent } from "./typing.ts";
import { getBrainRelay } from "./ask-relay.ts";
import { findPatch, offerPatch } from "./patch-pr.ts";
import { takeChatNotes } from "./chat-notes.ts";
import { pipelineNote } from "./pipelines/thread-mode.ts";
import { recordThreadFiles } from "./pipelines/thread-files.ts";
import { pickPatch, pruneClones, type PlanBranch } from "./plan-branch.ts";
import type { ReviewState } from "./plan-review.ts";

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

/**
 * Discord: 5 buttons per row, 5 rows, 80-char labels, 100-char custom ids.
 * 24, not 25, so 💬 Reply always has a slot beside them.
 */
const MAX_CHOICES = 24;

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

export function choiceRows(all: string[]) {
  const choices = all.slice(0, MAX_CHOICES);
  const rows = [];
  for (let r = 0; r * 5 < choices.length; r++) {
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

/**
 * One brain chat for a plan's tasks, so each task builds on what the chat
 * already knows (the plan, the code it read, what earlier tasks did) instead
 * of starting from nothing. `tasks` counts what it has run; `open` is false
 * once a turn there may still be running in the background, so the next task
 * doesn't talk over it.
 */
export interface PlanChat {
  id: string;
  tasks: number;
  open: boolean;
}

/** A chat that has run this many tasks hands over to a fresh one (long chats cost more per message). */
export const PLAN_CHAT_TASKS = 1;

/** A task on the board is running, or Run all is: tasks share one chat, so one at a time. */
export function boardBusy(board: Pick<TaskBoard, "states" | "busy">): boolean {
  return !!board.busy || board.states.some((s) => s.kind === "running");
}

export interface TaskBoard {
  brainId: string;
  tasks: BrainTask[];
  context?: string;
  states: TaskState[];
  createdAt: number;
  /** The channel the board message is in (to redraw it from a task's thread). */
  channelId?: string;
  /** Repo → the plan's branch on it, opened by its first repo task. */
  plans?: Record<string, PlanBranch>;
  /** Task thread id → task index. */
  threads?: Record<string, number>;
  /** Repo → how the plan's review loop stands (lib/plan-review.ts). */
  reviews?: Record<string, ReviewState>;
  /** The brain chat the plan's tasks share (it moves into each task's thread). */
  workChat?: PlanChat;
  /** Not saved: "Run all" is working through the list. */
  busy?: boolean;
  /** Not saved: branches being opened right now. */
  opening?: Map<string, Promise<PlanBranch>>;
}

/**
 * Task-board message id → its plan's tasks and how each is going. Saved to
 * `meta/task-boards.json`, so a restart doesn't strand a plan halfway: its
 * buttons keep working, and a task the restart cut off shows as failed
 * (retry it).
 */
const taskBoards = new Map<string, TaskBoard>();
let boardsFile: string | null = null;
const BOARD_TTL_MS = 30 * 24 * 3600_000;

export function getTaskBoard(messageId: string): TaskBoard | undefined {
  return taskBoards.get(messageId);
}

/** The plan task a thread is running, if it's a task thread. */
export function taskForThread(threadId: string): { boardId: string; board: TaskBoard; index: number } | undefined {
  for (const [boardId, board] of taskBoards) {
    const index = board.threads?.[threadId];
    if (index !== undefined) return { boardId, board, index };
  }
  return undefined;
}

export function saveTaskBoards(): void {
  if (!boardsFile) return;
  const out: Record<string, Omit<TaskBoard, "busy" | "opening">> = {};
  for (const [id, { busy: _b, opening: _o, ...rest }] of taskBoards) out[id] = rest;
  try {
    writeJsonAtomicSync(boardsFile, out);
  } catch (e) {
    console.error(`[tasks] couldn't save task boards: ${errorMessage(e)}`);
  }
}

/** Load saved boards (once, at startup). Tasks a restart cut off become failed; old boards are dropped. */
export function loadTaskBoards(dataDir: string, now = Date.now()): void {
  boardsFile = join(dataDir, "meta", "task-boards.json");
  taskBoards.clear();
  try {
    const saved = existsSync(boardsFile) ? (JSON.parse(readFileSync(boardsFile, "utf8")) as Record<string, TaskBoard>) : {};
    for (const [id, b] of Object.entries(saved)) {
      if (!b || !Array.isArray(b.tasks) || !Array.isArray(b.states) || now - (b.createdAt ?? 0) > BOARD_TTL_MS) continue;
      b.states = b.states.map((s) => (s.kind === "running" ? { kind: "failed", url: s.url } : s));
      // A review a restart cut off can be started again from the board.
      for (const r of Object.values(b.reviews ?? {})) if (reviewActive(r)) r.status = "stuck";
      taskBoards.set(id, b);
    }
  } catch (e) {
    console.error(`[tasks] couldn't read saved task boards: ${errorMessage(e)}`);
    return; // can't tell which clones are in use: keep them all
  }
  // Clones no saved board uses any more are only taking space (the work is on GitHub).
  const keep = new Set([...taskBoards.values()].flatMap((b) => Object.values(b.plans ?? {}).map((p) => p.dir)));
  const removed = pruneClones(join(dataDir, "plans"), keep, now);
  if (removed.length) console.error(`[tasks] removed ${removed.length} old plan clone(s)`);
}

/** A review loop that's working right now (reviewing, fixing, or waiting for CI). */
export function reviewActive(r: ReviewState | undefined): boolean {
  return r?.status === "reviewing" || r?.status === "fixing" || r?.status === "checks";
}

/** Every task landed, the plan has a branch, and no review is running: the board offers 🔎 Review. */
export function reviewable(board: Pick<TaskBoard, "states" | "plans" | "reviews" | "busy">): boolean {
  return (
    !board.busy &&
    board.states.length > 0 &&
    board.states.every((s) => s.kind === "done") &&
    Object.values(board.plans ?? {}).length > 0 &&
    !Object.values(board.reviews ?? {}).some(reviewActive)
  );
}

/** The newest board posted in this chat (the plan's own thread or channel), if any. */
export function latestBoardIn(chatKey: string): { boardId: string; board: TaskBoard } | undefined {
  let best: { boardId: string; board: TaskBoard } | undefined;
  for (const [boardId, board] of taskBoards) {
    if (board.channelId === chatKey && (!best || board.createdAt > best.board.createdAt)) best = { boardId, board };
  }
  return best;
}

/** The thread's pipeline note for this brain's chat here (binding the chat the brain is about to use); these brains don't run on this machine. */
function threadPipelineNote(ctx: AppContext, brainId: string, message: { chatKey: string; content: string }): string | undefined {
  if (!ctx.chats.pipelineAt(message.chatKey)) return undefined;
  return pipelineNote(ctx, message.chatKey, ctx.chats.current(message.chatKey, brainId, message.content).id, true);
}

/**
 * What the planning chat can't see for itself: how its tasks went. They ran
 * in a chat of their own, and the repo is private, so the brain would
 * otherwise say none of them ran. Added to the owner's messages in a plan's
 * chat once any task has started.
 */
export function planStatusNote(chatKey: string): string | undefined {
  const plan = latestBoardIn(chatKey);
  if (!plan || plan.board.states.every((s) => s.kind === "idle")) return undefined;
  const { board } = plan;
  const word = { idle: "not run yet", running: "running now", done: "done", failed: "failed" } as const;
  const lines = board.tasks.map((t, i) => `${t.n}. ${t.title} [${t.mode}] — ${word[board.states[i]?.kind ?? "idle"]}`);
  const reviewWord = {
    reviewing: "being reviewed",
    fixing: "fixes running",
    checks: "waiting for CI",
    ready: "CI passed — the owner has a Merge button in the plan's merge thread",
    merged: "merged",
    stuck: "needs the owner (see the plan's merge thread)",
  } as const;
  const branches = Object.values(board.plans ?? {}).map((p) => {
    const r = board.reviews?.[p.repo];
    return (
      `${p.repo} (read it through the user's connected GitHub account), branch ${p.branch}${p.prUrl ? `, PR ${p.prUrl}` : ""}` +
      (r ? ` — ${reviewWord[r.status]}` : "")
    );
  });
  return [
    "[Plan status, from Choomfie (not the user): the tasks ran in a separate chat (one per plan, in each task's thread); finished code/cad tasks are committed to the plan's branch, one commit per task.",
    ...lines,
    ...(branches.length ? [`Repo: ${branches.join("; ")}`] : []),
    "When every task is done, Choomfie waits for CI (a failure comes back as a fix task) and offers the owner a Merge button. Don't tell the user to merge or mark the PR ready themselves. More tasks for this plan go on the same branch.",
    "]",
  ].join("\n");
}

/** Add a task to a plan's board (numbered after the last), and redraw it later. Returns its index. */
export function appendTask(board: TaskBoard, task: BrainTask): number {
  const n = Math.max(0, ...board.tasks.map((t) => t.n)) + 1;
  const repos = [...new Set(board.tasks.flatMap((t) => (t.repo ? [t.repo] : [])))];
  board.tasks.push({ ...task, n, ...(task.repo ? {} : repos.length === 1 ? { repo: repos[0] } : {}) });
  board.states.push({ kind: "idle" });
  saveTaskBoards();
  return board.tasks.length - 1;
}

type PlanTaskStarter = (ctx: AppContext, boardId: string, index: number, user: { id: string; username: string }) => Promise<boolean>;
let planTaskStarter: PlanTaskStarter | null = null;

/** The task handlers register how to run a board task (its thread, its branch); the router only triggers it. */
export function setPlanTaskStarter(fn: PlanTaskStarter): void {
  planTaskStarter = fn;
}

/** Forget every board (tests). */
export function resetTaskBoards(): void {
  taskBoards.clear();
  boardsFile = null;
}

const TASK_ICON = { running: "⏳", done: "✅", failed: "❌" } as const;

/** The prompt a task starts with: stands alone, since its chat never saw the planning conversation. */
export function taskPrompt(task: { n: number; spec: string }, context?: string): string {
  return [`Task ${task.n} of a plan: ${task.spec}`, context].filter(Boolean).join("\n\n");
}

/** A button per task: runnable until started, then a link to its thread showing how it went. Plus "Run all" while 2+ are idle. */
export function taskBoardRows(board: Pick<TaskBoard, "tasks" | "states" | "busy" | "plans" | "reviews">) {
  const rows = [];
  // Failed tasks can run again (their thread is still linked from the retry).
  const idle = board.busy ? 0 : board.states.filter((s) => s.kind === "idle" || s.kind === "failed").length;
  const review = reviewable(board);
  const tasks = board.tasks.slice(0, idle >= 2 || review ? 20 : 25);
  for (let r = 0; r * 5 < tasks.length; r++) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        tasks.slice(r * 5, r * 5 + 5).map((t, j) => {
          const i = r * 5 + j;
          const state = board.states[i] ?? { kind: "idle" };
          const label = `${t.n} · ${t.mode} · ${t.title}`;
          const b = new ButtonBuilder();
          if (state.kind === "idle") {
            return b.setCustomId(`brain:task:${i}`).setLabel(`▶ ${label}`.slice(0, 80)).setStyle(ButtonStyle.Secondary);
          }
          if (state.kind === "failed" && !board.busy) {
            return b.setCustomId(`brain:task:${i}`).setLabel(`↻ ${label} (failed — retry)`.slice(0, 80)).setStyle(ButtonStyle.Danger);
          }
          return b.setURL(state.url).setLabel(`${TASK_ICON[state.kind]} ${label}`.slice(0, 80)).setStyle(ButtonStyle.Link);
        })
      )
    );
  }
  if (idle >= 2) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("brain:taskall").setLabel(`▶ Run the remaining ${idle}, in order`).setStyle(ButtonStyle.Primary)
      )
    );
  }
  if (review) {
    const merged = Object.values(board.reviews ?? {}).some((r) => r.status === "merged");
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("brain:review").setLabel(merged ? "🔎 Review again" : "🔎 Review and merge").setStyle(ButtonStyle.Primary)
      )
    );
  }
  return rows;
}

export interface PostOptions {
  /** No "Open draft PR" button: the caller commits the patch itself (a plan's branch). */
  noPatchOffer?: boolean;
}

/** The repo a plan task works in: its own, or the plan's one repo when its line doesn't say. */
export function planTaskRepo(board: Pick<TaskBoard, "tasks">, index: number): string | undefined {
  const task = board.tasks[index];
  if (!task) return undefined;
  const repos = [...new Set(board.tasks.flatMap((t) => (t.repo ? [t.repo] : [])))];
  return task.repo ?? (repos.length === 1 ? repos[0] : undefined);
}

export type Landing = { kind: "patch"; files: [BrainFile] } | { kind: "files"; files: BrainFile[]; folder: string };

/**
 * What a plan task's reply would put on the plan's branch: its patch (a repo
 * mode), or its files (a files mode, like cad → cad/). Undefined when the
 * task has no repo, or the reply has nothing for it.
 */
export function landingFor(board: Pick<TaskBoard, "brainId" | "tasks">, index: number, files: BrainFile[] | undefined): Landing | undefined {
  const task = board.tasks[index];
  if (!task || !planTaskRepo(board, index)) return undefined;
  const mode = getBrain(board.brainId)?.modes?.find((m) => m.id === task.mode);
  if (mode?.repo) {
    const patch = pickPatch(files);
    return patch ? { kind: "patch", files: [patch] } : undefined;
  }
  if (mode?.files) {
    const out = (files ?? []).filter((f) => !/\.(patch|diff)$/i.test(f.name));
    return out.length ? { kind: "files", files: out, folder: mode.files } : undefined;
  }
  return undefined;
}

/** "Commit to the plan's branch" button message id → what to commit. In memory: a restart expires them. */
const pendingLands = new Map<string, Landing & { boardId: string; index: number }>();

export function takeLand(messageId: string) {
  const p = pendingLands.get(messageId);
  pendingLands.delete(messageId);
  return p;
}

/** Post a brain's reply: chunked, threaded to `replyTo` when given, quick replies as buttons on the last chunk. */
export async function postBrainReply(
  channel: SendableChannel,
  brainId: string,
  chatKey: string,
  reply: BrainReply,
  replyTo?: string,
  opts: PostOptions = {}
): Promise<void> {
  const choices = (reply.choices ?? []).filter(Boolean).slice(0, MAX_CHOICES);
  const fallback = choices.length ? "(pick one)" : reply.approvals?.length || reply.files?.length ? "" : "(no reply)";
  const chunks = chunkForDiscord(reply.text || fallback);
  if (!chunks.length && reply.files?.length) chunks.push(""); // files alone still need a message
  // More files than one message carries go on in messages of their own, right after.
  const [firstFiles, ...moreFiles] = fileBatches(reply.files ?? []);
  const attach = (files: BrainFile[]) => files.map((f) => ({ attachment: Buffer.from(f.data), name: f.name }));
  for (let i = 0; i < chunks.length; i++) {
    const last = i === chunks.length - 1;
    const sent = await channel.send({
      allowedMentions: NO_MENTIONS,
      content: chunks[i],
      ...(i === 0 && replyTo ? { reply: { messageReference: replyTo } } : {}),
      ...(last && firstFiles ? { files: attach(firstFiles) } : {}),
      ...(last && choices.length ? { components: choiceRows(choices) } : {}),
    });
    const id = (sent as { id?: unknown } | undefined)?.id;
    if (last && choices.length && typeof id === "string") pendingChoices.set(id, { brainId, chatKey, choices });
    // The reply's images, kept so a tool can ask for "the last reply" (the pipeline tool's files).
    if (last && reply.files?.length && threadFilesDir) {
      try {
        recordThreadFiles(threadFilesDir, chatKey, typeof id === "string" ? id : `reply-${Date.now()}`, "brain", reply.files);
      } catch (e) {
        console.error(`[brain:${brainId}] couldn't keep the reply's files: ${errorMessage(e)}`);
      }
    }
  }
  for (const files of moreFiles) await channel.send({ allowedMentions: NO_MENTIONS, files: attach(files) });
  // A plan's tasks: one button each, which runs it in its own thread (owner only).
  // A single task the brain will run right away needs no buttons.
  if (reply.tasks?.length && !reply.runNow) {
    // A new list in a plan's chat continues that plan: same branch, same PR, not a fresh branch off main.
    const earlier = latestBoardIn(chatKey)?.board;
    const board: TaskBoard = {
      brainId,
      tasks: reply.tasks,
      context: reply.taskContext,
      states: reply.tasks.map(() => ({ kind: "idle" })),
      createdAt: Date.now(),
      channelId: chatKey,
      ...(earlier?.plans && earlier.brainId === brainId ? { plans: { ...earlier.plans } } : {}),
    };
    const sent = await channel.send({
      allowedMentions: NO_MENTIONS,
      content: "📋 **Tasks** — click one to run it in its own thread.",
      components: taskBoardRows(board),
    });
    const id = (sent as { id?: unknown } | undefined)?.id;
    if (typeof id === "string") {
      taskBoards.set(id, board);
      saveTaskBoards();
    }
  }
  // A patch made in the brain's sandbox: the owner can turn it into a draft PR.
  // A follow-up in a plan task's thread ("continue"): what it hands back goes on the plan's branch.
  const planTask = opts.noPatchOffer ? undefined : taskForThread(chatKey);
  const land = planTask ? landingFor(planTask.board, planTask.index, reply.files) : undefined;
  if (planTask && land) {
    const what = land.kind === "patch" ? `Patch (\`${land.files[0].name}\`)` : `${land.files.length} file${land.files.length === 1 ? "" : "s"} for ${land.folder}/`;
    const sent = await channel.send({
      allowedMentions: NO_MENTIONS,
      content: `📦 ${what} — task ${planTask.board.tasks[planTask.index].n} of the plan`,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("brain:landtask").setLabel("Commit to the plan's branch").setStyle(ButtonStyle.Primary)
        ),
      ],
    });
    const id = (sent as { id?: unknown } | undefined)?.id;
    if (typeof id === "string") pendingLands.set(id, { boardId: planTask.boardId, index: planTask.index, ...land });
  }
  const planPatch = land?.kind === "patch";
  const patch = opts.noPatchOffer || planPatch ? null : findPatch(reply.text, reply.files);
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

/** Where brain replies' images are kept (the data dir); set at boot by installBrainPoster. */
let threadFilesDir: string | null = null;

/** Lets plugins post late results (background jobs) through the same formatting. */
export function installBrainPoster(ctx: AppContext): void {
  threadFilesDir = ctx.DATA_DIR;
  loadTaskBoards(ctx.DATA_DIR);
  setBrainPoster(async (brainId, chatKey, reply) => {
    const fetched = await ctx.discord?.channels.fetch(chatKey).catch(() => null);
    // A chat the bot isn't in (group DM /choomfie) can still be answered while its
    // interaction is open; after that the result stays in the brain's own app.
    const channel = fetched && "send" in fetched ? (fetched as unknown as SendableChannel) : getBrainRelay(chatKey);
    if (!channel) throw new Error(`channel ${chatKey} not reachable`);
    await postBrainReply(channel, brainId, chatKey, reply);
  });
}

/** One in-flight request per backend conversation; later ones queue behind it. */
const queues = new Map<string, Promise<void>>();

/** What a restart would cut off here: brain replies in progress, plan tasks running, reviews going. Empty when idle. */
export function runningWork(): string[] {
  const out: string[] = [];
  if (queues.size) out.push(`${queues.size} brain repl${queues.size === 1 ? "y" : "ies"} in progress`);
  let tasks = 0;
  let reviews = 0;
  for (const b of taskBoards.values()) {
    tasks += b.states.filter((s) => s.kind === "running").length;
    reviews += Object.values(b.reviews ?? {}).filter(reviewActive).length;
  }
  if (tasks) out.push(`${tasks} plan task${tasks === 1 ? "" : "s"} running`);
  if (reviews) out.push(`${reviews} plan review${reviews === 1 ? "" : "s"} going`);
  return out;
}

/**
 * Run `job` when the conversation `chatKey` is free: Discord messages and
 * askBrain share the queue, so nothing talks over a reply in progress.
 */
export function inConversation<T>(chatKey: string, job: () => Promise<T>): Promise<T> {
  const run = (queues.get(chatKey) ?? Promise.resolve()).then(job);
  const tail: Promise<void> = run
    .then(
      () => {},
      () => {}
    )
    .then(() => {
      if (queues.get(chatKey) === tail) queues.delete(chatKey);
    });
  queues.set(chatKey, tail);
  return run;
}

export function dispatchToBrain(
  ctx: AppContext,
  brain: Brain,
  channel: SendableChannel,
  /** `messageId` anchors the reply; omit it when the message is in another channel. */
  message: BrainMessage & { messageId?: string },
  opts: PostOptions = {}
): Promise<BrainReply | null> {
  return inConversation(message.chatKey, async () => {
    try {
      const owner = message.meta?.role === "owner";
      const notes = owner
        ? [threadPipelineNote(ctx, brain.id, message), planStatusNote(message.chatKey), takeChatNotes(message.chatKey)].filter(Boolean)
        : [];
      const reply = await brain.send(notes.length ? { ...message, content: [message.content, ...notes].join("\n\n") } : message, ctx);
      await postBrainReply(channel, brain.id, message.chatKey, reply, message.messageId, opts);
      const task = reply.runNow ? reply.tasks?.[0] : undefined;
      const plan = task && message.meta?.role === "owner" && planTaskStarter ? latestBoardIn(message.chatKey) : undefined;
      if (task && plan && boardBusy(plan.board)) {
        // A task is running: queue it on the board rather than run two things in the plan's chat at once.
        const added = plan.board.tasks[appendTask(plan.board, task)];
        await channel
          .send({ allowedMentions: NO_MENTIONS, content: `-# → added to the plan as **task ${added.n}** — start it from the board once the running task finishes` })
          .catch(() => {});
      } else if (task && plan) {
        // The plan's own chat asked for one more job: it joins the plan, and runs as its next task.
        const index = appendTask(plan.board, task);
        const added = plan.board.tasks[index];
        await channel
          .send({ allowedMentions: NO_MENTIONS, content: `-# → added to the plan as **task ${added.n}** (\`${added.mode}\`) — running it in its own thread` })
          .catch(() => {});
        void planTaskStarter!(ctx, plan.boardId, index, { id: message.meta.user_id ?? "", username: message.meta.user ?? "" }).then(async (ok) => {
          if (!ok) {
            await channel
              .send({ allowedMentions: NO_MENTIONS, content: `-# Couldn't start task ${added.n} — run it from the plan's board.` })
              .catch(() => {});
          }
        });
      } else if (task) {
        // One job for one mode: switch this chat to it and start, in this same thread.
        const chat = ctx.chats.bound(message.chatKey, brain.id);
        if (chat) ctx.chats.setMode(chat.id, task.mode);
        await channel.send({ allowedMentions: NO_MENTIONS, content: `-# → **${task.mode}** mode · \`/mode off\` to go back to auto` }).catch(() => {});
        void dispatchToBrain(ctx, brain, channel, { ...message, messageId: undefined, content: taskPrompt(task, reply.taskContext), filePaths: [] });
      }
      return reply;
    } catch (e) {
      console.error(`[brain:${brain.id}] ${errorMessage(e)}`);
      await channel
        .send({
          allowedMentions: NO_MENTIONS,
          content: `⚠️ ${brain.label} didn't answer: ${errorMessage(e).slice(0, 300)}`,
          ...(message.messageId ? { reply: { messageReference: message.messageId } } : {}),
        })
        .catch(() => {});
      return null;
    } finally {
      onReplySent(message.chatKey);
    }
  });
}
