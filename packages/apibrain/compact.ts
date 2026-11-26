/**
 * Fold a chat's older turns into a rolling summary, so long conversations
 * stay inside a free tier's budget. Runs after a reply is posted, never in
 * front of one, at most once per chat every few minutes.
 */

import { estimateTokens } from "./context.ts";
import type { Transcript } from "./transcript.ts";

export interface CompactOptions {
  transcript: Transcript;
  chatId: string;
  /** The chat's input budget; compaction starts at `threshold` of it. */
  budget: number;
  /** Summarize this text into a few hundred tokens (a cheap model). */
  summarize(text: string): Promise<string>;
  threshold?: number;
  minIntervalMs?: number;
  /** `/compact`: fold now, whatever the size or the last run (still needs a few turns). */
  force?: boolean;
}

const lastRun = new Map<string, number>();
const running = new Set<string>();

/** True when a summary was written. */
export async function maybeCompact(opts: CompactOptions, now = Date.now()): Promise<boolean> {
  const { transcript, chatId } = opts;
  if (running.has(chatId)) return false;
  if (!opts.force && now - (lastRun.get(chatId) ?? 0) < (opts.minIntervalMs ?? 5 * 60_000)) return false;
  const summary = transcript.summary(chatId);
  const live = transcript.live(chatId);
  const total = estimateTokens(summary?.text ?? "") + live.reduce((n, t) => n + estimateTokens(t.content), 0);
  if (live.length < 4 || (!opts.force && total < opts.budget * (opts.threshold ?? 0.7))) return false;

  // The older half, ending on an assistant turn so a question isn't split from its answer.
  let cut = Math.floor(live.length / 2);
  while (cut > 1 && live[cut - 1].role !== "assistant") cut--;
  const older = live.slice(0, cut);
  running.add(chatId);
  lastRun.set(chatId, now);
  try {
    const text = [
      summary ? `Summary so far:\n${summary.text}\n` : "",
      "Conversation to fold in:",
      ...older.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content.slice(0, 4_000)}`),
    ].join("\n");
    const out = (await opts.summarize(text)).trim();
    if (!out) return false;
    transcript.setSummary(chatId, out, older.at(-1)!.id);
    return true;
  } catch (e) {
    console.error(`[apibrain] couldn't summarize chat ${chatId}: ${e instanceof Error ? e.message : e}`);
    return false;
  } finally {
    running.delete(chatId);
  }
}

/** The instruction for the summarizer. */
export const SUMMARY_PROMPT = [
  "Summarize this conversation for whoever continues it. Use these headings, leaving out any with nothing under them:",
  "Goals — what the user wants overall.",
  "Decisions — what was agreed or chosen.",
  "Facts — names, preferences, constraints, results.",
  "Open questions — what is still unanswered or unfinished.",
  "Verbatim — code, commands, numbers, file names, links that later turns may need, copied exactly.",
  "Short bullet points, under 350 words. Write only the summary.",
].join("\n");
