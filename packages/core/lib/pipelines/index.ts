/**
 * Pipelines, put together: the configured pipelines, one runner for the
 * worker, and what happens when a job ends.
 *
 * - A job in a thread put on its pipeline (`/pipeline`), or started from a
 *   step card's button, posts the next step as a card: its text, pictures and
 *   a button per choice (lib/pipelines/cards.ts). The card it came from shows
 *   how it ended. Whoever ran the step (a click, Claude, Waymond), the way on
 *   is a click.
 * - Any other job posts its pictures (and its end, when the caller had moved
 *   on or can't relay it) and leaves a note for the chat's next message.
 *
 * Callers: the `pipeline` tool (tools/pipeline-tools.ts), the card buttons
 * (handlers/pipeline-cards.ts) and `/pipeline` (handlers/pipeline-command.ts).
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileBatches } from "@choomfie/shared";
import { addChatNote } from "../chat-notes.ts";
import type { SendableChannel } from "../brain-router.ts";
import type { AppContext } from "../types.ts";
import { announceJob, jobLine, newPictures, nextStep } from "./announce.ts";
import { buildArgv, PipelineError } from "./args.ts";
import { actionsFor, buttonRows, cardText, newCardId, saveCard, type Card, type CardAction, type PictureSource, type Sources, type Step } from "./cards.ts";
import { PipelineRunner, type CardMessage, type Job } from "./runner.ts";
import { hasThreadFiles, pruneByAge, resolveThreadFiles, type FileSpec } from "./thread-files.ts";

let runner: PipelineRunner | null = null;

const NO_MENTIONS = { parse: [] as never[] };

export async function chatChannel(ctx: AppContext, chatId: string): Promise<SendableChannel | null> {
  const ch = await ctx.discord?.channels.fetch(chatId).catch(() => null);
  return ch && "send" in ch ? (ch as unknown as SendableChannel) : null;
}

/** Edit a message in a chat; a message that's gone is left alone. */
async function editMessage(ctx: AppContext, chatId: string, messageId: string, edit: { content?: string; components?: unknown[] }): Promise<void> {
  const ch = (await ctx.discord?.channels.fetch(chatId).catch(() => null)) as { messages?: { edit(id: string, o: unknown): Promise<unknown> } } | null;
  await ch?.messages?.edit(messageId, edit).catch(() => {});
}

/** The folder a job's `{files}` names: the chat's pictures `spec` picks, copied in. */
export function filesFor(ctx: AppContext, chatId: string, spec: FileSpec, jobId: string): string {
  const base = join(ctx.DATA_DIR, "pipeline-files");
  pruneByAge(base);
  const dir = join(base, jobId);
  resolveThreadFiles(ctx.DATA_DIR, chatId, spec, dir);
  return dir;
}

/** Which kinds of pictures the chat has kept, for the buttons that hand them over. */
export function sourcesIn(ctx: AppContext, chatId: string): Sources {
  return { last_mine: hasThreadFiles(ctx.DATA_DIR, chatId, "last_mine"), last_reply: hasThreadFiles(ctx.DATA_DIR, chatId, "last_reply") };
}

/** Run a command for a card (a button, `/pipeline`); its end posts the next card. Throws PipelineError when it can't run. */
export function startCardJob(ctx: AppContext, pipeline: string, chatId: string, args: string[], files?: PictureSource, cardMsg?: CardMessage): Job {
  const p = ctx.config.getPipelines().get(pipeline);
  if (!p) throw new PipelineError(`no pipeline "${pipeline}" (it was removed from the config)`);
  const r = pipelineRunner(ctx);
  const id = r.newId(p.name);
  const argv = buildArgv(p, args, files ? filesFor(ctx, chatId, files, id) : undefined);
  return r.start(p, argv, args.slice(), chatId, id, { via: "card", ...(cardMsg ? { cardMsg } : {}) });
}

/**
 * Post a card: its pictures, text and buttons (the last batch of pictures goes
 * with the buttons, so they sit under what they're about). The chat's previous
 * unused card loses its buttons: only the newest one runs.
 */
export async function postCard(
  ctx: AppContext,
  channel: SendableChannel,
  pipeline: string,
  chatId: string,
  text: string,
  actions: CardAction[],
  pictures: string[] = []
): Promise<Card> {
  const card: Card = { id: newCardId(), pipeline, chatId, actions };
  const attach = (batch: { name: string; data: Uint8Array }[]) => batch.map((f) => ({ attachment: Buffer.from(f.data), name: f.name }));
  const batches = fileBatches(pictures.map((p) => ({ name: basename(p), data: new Uint8Array(readFileSync(p)) })));
  const last = batches.pop();
  for (const batch of batches) await channel.send({ allowedMentions: NO_MENTIONS, files: attach(batch) });
  const sent = (await channel.send({
    allowedMentions: NO_MENTIONS,
    content: text || undefined,
    ...(last ? { files: attach(last) } : {}),
    components: buttonRows(card.id, actions),
  })) as { id?: string } | undefined;
  card.messageId = sent?.id;
  const before = saveCard(card);
  if (before?.messageId) await editMessage(ctx, chatId, before.messageId, { components: [] });
  return card;
}

/** Post a pipeline step as a card. */
export async function postStep(ctx: AppContext, channel: SendableChannel, pipeline: string, chatId: string, step: Step, header?: string, pictures: string[] = []): Promise<Card> {
  return postCard(ctx, channel, pipeline, chatId, cardText(step, header), actionsFor(step, sourcesIn(ctx, chatId)), pictures);
}

/** A job that ends in a card: the card it came from shows how it ended, then the next step. */
async function finishCard(ctx: AppContext, channel: SendableChannel, job: Job): Promise<void> {
  const line = jobLine(job);
  if (job.cardMsg) await editMessage(ctx, job.chatId, job.cardMsg.messageId, { content: `${job.cardMsg.text}\n${line}`.slice(0, 2000), components: [] });
  const step: Step = (nextStep(job) as Step | undefined) ?? { waiting: "input" };
  // The card it came from already says how it went; a plain `next` (a look, not a change) needs no line.
  const quiet = job.state === "done" && (job.cardMsg || job.args[0] === "next");
  await postStep(ctx, channel, job.pipeline, job.chatId, step, quiet ? undefined : line, newPictures(job));
}

/** The job's step goes to a card: started from one, or a step (with `next`) in a thread on its pipeline. */
function endsInCard(ctx: AppContext, job: Job): boolean {
  if (job.via === "card") return true;
  return !!nextStep(job) && ctx.chats?.pipelineAt?.(job.chatId)?.pipeline === job.pipeline;
}

async function onFinish(ctx: AppContext, job: Job): Promise<void> {
  const say = nextStep(job)?.say;
  if (job.background || job.via === "card") {
    addChatNote(job.chatId, `pipeline job ${job.id}${job.via === "card" ? " (the owner clicked its button)" : ""}: ${jobLine(job)}${say ? `. Next: ${say}` : ""}`);
  }
  const channel = await chatChannel(ctx, job.chatId);
  if (!channel) return;
  if (endsInCard(ctx, job)) await finishCard(ctx, channel, job);
  else await announceJob(channel, job);
}

/** The worker's runner, made on first use. */
export function pipelineRunner(ctx: AppContext): PipelineRunner {
  runner ??= new PipelineRunner(join(ctx.DATA_DIR, "pipeline-logs"), (job) => onFinish(ctx, job));
  return runner;
}

/** Jobs queued or running now (none if no pipeline ran since startup). */
export function activeJobs(): Job[] {
  return runner?.list().filter((j) => j.state === "queued" || j.state === "running") ?? [];
}

/** Stop running jobs (worker shutdown). */
export function stopPipelines(): void {
  runner?.stopAll();
}

/** Tests only. */
export function _setRunner(r: PipelineRunner | null): void {
  runner = r;
}
