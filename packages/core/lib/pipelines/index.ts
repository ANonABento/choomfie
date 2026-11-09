/**
 * Pipelines, put together: the configured pipelines, one runner for the
 * worker, and what happens when a job ends (its pictures posted in the chat
 * that asked, and a note for that chat's next message if the caller had moved
 * on). The tools in tools/pipeline-tools.ts are the only callers.
 */

import { join } from "node:path";
import { addChatNote } from "../chat-notes.ts";
import type { SendableChannel } from "../brain-router.ts";
import type { AppContext } from "../types.ts";
import { announceJob, jobLine, nextStep } from "./announce.ts";
import { PipelineRunner, type Job } from "./runner.ts";

let runner: PipelineRunner | null = null;

async function chatChannel(ctx: AppContext, chatId: string): Promise<SendableChannel | null> {
  const ch = await ctx.discord?.channels.fetch(chatId).catch(() => null);
  return ch && "send" in ch ? (ch as unknown as SendableChannel) : null;
}

async function onFinish(ctx: AppContext, job: Job): Promise<void> {
  if (job.background) {
    const say = nextStep(job)?.say;
    addChatNote(job.chatId, `pipeline job ${job.id}: ${jobLine(job)}${say ? `. Next: ${say}` : ""}`);
  }
  const channel = await chatChannel(ctx, job.chatId);
  if (channel) await announceJob(channel, job);
}

/** The worker's runner, made on first use. */
export function pipelineRunner(ctx: AppContext): PipelineRunner {
  runner ??= new PipelineRunner(join(ctx.DATA_DIR, "pipeline-logs"), (job) => onFinish(ctx, job));
  return runner;
}

/** Stop running jobs (worker shutdown). */
export function stopPipelines(): void {
  runner?.stopAll();
}

/** Tests only. */
export function _setRunner(r: PipelineRunner | null): void {
  runner = r;
}
