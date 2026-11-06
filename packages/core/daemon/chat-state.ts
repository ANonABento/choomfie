/**
 * Which Choomfie chat the daemon's Claude session holds, kept across restarts.
 *
 * The worker owns the chat records (SQLite); the daemon only needs to know the
 * id and cwd of the one it is holding, so `/chat` and `/status` can name it,
 * and the handoff summary each chat's current session was started with — a
 * resumed session gets its transcript back from the SDK, but the summary lived
 * in the system prompt, not the transcript, so it has to be supplied again.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeJsonAtomic } from "@choomfie/shared";
import { META_DIR, PLUGIN_DIR } from "./constants.ts";
import { getErrorMessage } from "./error.ts";
import { log } from "./log.ts";

export const CHAT_STATE_PATH = `${META_DIR}/claude-chat.json`;

/** Seeds kept for resuming; older chats resume without one. */
const MAX_SEEDS = 30;

export interface HeldChat {
  id: string;
  cwd: string;
}

export interface ChatStateFile {
  current: HeldChat;
  /** chat id → handoff summary its latest session started with. */
  seeds: Record<string, string>;
}

export function freshChat(cwd: string = PLUGIN_DIR): HeldChat {
  return { id: randomUUID(), cwd };
}

export function parseChatState(raw: unknown): ChatStateFile | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const cur = r.current as Record<string, unknown> | undefined;
  if (!cur || typeof cur.id !== "string" || typeof cur.cwd !== "string") return null;
  const seeds: Record<string, string> = {};
  if (r.seeds && typeof r.seeds === "object") {
    for (const [k, v] of Object.entries(r.seeds as Record<string, unknown>)) if (typeof v === "string") seeds[k] = v;
  }
  return { current: { id: cur.id, cwd: cur.cwd }, seeds };
}

export function loadChatState(path: string = CHAT_STATE_PATH): ChatStateFile {
  try {
    const parsed = parseChatState(JSON.parse(readFileSync(path, "utf-8")));
    if (parsed) return parsed;
  } catch {
    // First run, or unreadable: start a chat of our own.
  }
  return { current: freshChat(), seeds: {} };
}

/** Record `summary` as the seed for `chatId`, dropping the oldest past the cap. */
export function withSeed(seeds: Record<string, string>, chatId: string, summary: string | undefined): Record<string, string> {
  const next = { ...seeds };
  delete next[chatId];
  if (summary) next[chatId] = summary;
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SEEDS))) delete next[k];
  return next;
}

export async function saveChatState(file: ChatStateFile, path: string = CHAT_STATE_PATH): Promise<void> {
  try {
    await writeJsonAtomic(path, file);
  } catch (error: unknown) {
    log(`Failed to write chat state: ${getErrorMessage(error)}`);
  }
}
