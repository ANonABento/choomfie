/**
 * Showing a job's result in the chat that asked for it, so the user sees
 * every checkpoint whichever brain ran the job (Waymond can't attach a file
 * from this machine; Claude needn't repeat it).
 *
 * The result contract (a pipeline with `json`): `show` is a list of picture
 * paths, and `next` (optional) is the step after it: `{say, show, waiting}`.
 * A picture is posted once per chat until it changes, so asking "what's next"
 * again doesn't repost the same sheet.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { fileBatches } from "@choomfie/shared";
import type { SendableChannel } from "../brain-router.ts";
import type { Job } from "./runner.ts";
import { isImage } from "./thread-files.ts";

/** Chat → signatures (path + mtime) of pictures already posted there. */
const posted = new Map<string, Set<string>>();
const MAX_REMEMBERED = 500;

const NO_MENTIONS = { parse: [] as never[] };

export interface NextStep {
  say?: string;
  show?: string[];
  waiting?: string;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

/** The step after the job, from its result. */
export function nextStep(job: Job): NextStep | undefined {
  const n = job.result?.next;
  return n && typeof n === "object" ? (n as NextStep) : undefined;
}

/** One line on how the job ended. */
export function jobLine(job: Job): string {
  const what = `${job.pipeline} \`${job.args.join(" ")}\``;
  const took = job.startedAt !== undefined && job.endedAt !== undefined ? ` in ${formatDuration(job.endedAt - job.startedAt)}` : "";
  if (job.state === "done") return `✅ ${what} finished${took}`;
  if (job.state === "stopped") return `⏹️ ${what} stopped`;
  if (job.state === "failed") return `❌ ${what} failed${took}: ${job.error ?? "unknown error"}`;
  return `⏳ ${what} ${job.state}`;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Pictures from the result not yet posted in this chat as they are now. Marks them posted. */
export function newPictures(job: Job): string[] {
  const seen = posted.get(job.chatId) ?? new Set<string>();
  const out: string[] = [];
  for (const p of new Set([...strings(job.result?.show), ...strings(nextStep(job)?.show)])) {
    if (!isImage(p) || !existsSync(p)) continue;
    const sig = `${p}@${statSync(p).mtimeMs}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(p);
  }
  if (seen.size > MAX_REMEMBERED) posted.set(job.chatId, new Set([...seen].slice(-MAX_REMEMBERED)));
  else posted.set(job.chatId, seen);
  return out;
}

/**
 * Post the job's end to its chat: always when it ran in the background (the
 * caller has moved on) or its caller can't relay it (`postResult`: Waymond's
 * turn ends at the approval, so its result would reach nobody), otherwise only
 * when it has new pictures to show.
 */
export async function announceJob(channel: SendableChannel, job: Job): Promise<void> {
  const pictures = newPictures(job);
  const always = job.background || job.postResult;
  if (!always && !pictures.length) return;
  const say = nextStep(job)?.say;
  const content = [always ? jobLine(job) : "", say ?? ""].filter(Boolean).join("\n").slice(0, 1900);
  const files = pictures.map((p) => ({ name: basename(p), data: new Uint8Array(readFileSync(p)) }));
  const [first, ...more] = fileBatches(files);
  const attach = (batch: typeof files) => batch.map((f) => ({ attachment: Buffer.from(f.data), name: f.name }));
  await channel.send({ allowedMentions: NO_MENTIONS, content: content || undefined, ...(first ? { files: attach(first) } : {}) });
  for (const batch of more) await channel.send({ allowedMentions: NO_MENTIONS, files: attach(batch) });
}

/** Tests only. */
export function _resetPosted(): void {
  posted.clear();
}
