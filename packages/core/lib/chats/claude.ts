/**
 * The Claude side of chats.
 *
 * Until sessions can run side by side (one per chat), every Claude location
 * shares the daemon's one session — so Claude chats are bound to a single
 * global location rather than to the channel you're in. `/resume` on a
 * Claude chat swaps the session for everyone, which is why it is owner-only.
 *
 * The daemon decides which chat its session holds (its id, cwd and live SDK
 * session id are in daemon-state.json); the worker keeps the record. This
 * brings the record up to date from the daemon's snapshot.
 */

import { CLAUDE_BRAIN, isDaemonOwnedProcess, titleFrom, UNTITLED_CHAT, type ChatRecord } from "@choomfie/shared";
import { readDaemonStateFile, readDaemonStatus, type DaemonSnapshot } from "../daemon-status.ts";
import type { AppContext } from "../types.ts";
import type { ChatStore } from "./store.ts";

/** Where Claude chats are bound while there is one shared session. */
export const CLAUDE_GLOBAL = "claude:global";

type Held = NonNullable<DaemonSnapshot["chat"]>;

/** Upsert the held chat's record. `firstText` names an untitled chat. */
export function applyClaudeHold(chats: ChatStore, held: Held, firstText?: string): ChatRecord | null {
  if (!held.id) return null;
  let chat = chats.get(held.id);
  if (!chat) {
    chat = chats.create({
      id: held.id,
      brain: CLAUDE_BRAIN,
      locationId: CLAUDE_GLOBAL,
      title: firstText ? titleFrom(firstText) : UNTITLED_CHAT,
      cwd: held.cwd ?? null,
      backendRef: held.sdkSessionId ?? null,
    });
  } else {
    if (firstText && chat.title === UNTITLED_CHAT) chats.rename(chat.id, titleFrom(firstText));
    if (held.sdkSessionId && held.sdkSessionId !== chat.backendRef) chats.setBackendRef(chat.id, held.sdkSessionId);
    else if (firstText) chats.touch(chat.id);
    if (held.cwd && held.cwd !== chat.cwd) chats.setCwd(chat.id, held.cwd);
  }
  if (chats.bound(CLAUDE_GLOBAL, CLAUDE_BRAIN)?.id !== chat.id) chats.bind(CLAUDE_GLOBAL, chat.id);
  return chats.get(chat.id);
}

/** The Claude chat the daemon holds right now, or null in foreground mode. */
export async function syncClaudeChat(ctx: AppContext, firstText?: string): Promise<ChatRecord | null> {
  // A worker the daemon launched knows it's alive; skip the `ps` check — this
  // runs on every message to Claude.
  const snapshot = isDaemonOwnedProcess() ? await readDaemonStateFile(ctx.DATA_DIR) : await readDaemonStatus(ctx.DATA_DIR);
  if (!snapshot?.chat) return null;
  return applyClaudeHold(ctx.chats, snapshot.chat, firstText);
}

/**
 * Is the daemon running one Claude session per location? Read from its state
 * file — a daemon-launched worker skips the `ps` liveness check, since this
 * runs on every message to Claude.
 */
export async function claudeIsPerLocation(ctx: AppContext): Promise<boolean> {
  const snapshot = isDaemonOwnedProcess() ? await readDaemonStateFile(ctx.DATA_DIR) : await readDaemonStatus(ctx.DATA_DIR);
  return snapshot?.multiSession === true;
}

/**
 * The Claude chat at a location. Multi-session: its own chat, created (titled
 * from `firstText`) when there is none yet and a message is on its way.
 * Otherwise the one shared chat the daemon holds.
 */
export async function claudeChatAt(ctx: AppContext, location: string, firstText?: string): Promise<ChatRecord | null> {
  if (!(await claudeIsPerLocation(ctx))) return syncClaudeChat(ctx, firstText);
  const chat = ctx.chats.bound(location, CLAUDE_BRAIN);
  if (!chat) return firstText === undefined ? null : ctx.chats.start(location, CLAUDE_BRAIN, titleFrom(firstText));
  if (firstText !== undefined) {
    if (chat.title === UNTITLED_CHAT && firstText.trim()) ctx.chats.rename(chat.id, titleFrom(firstText));
    else ctx.chats.touch(chat.id);
  }
  return ctx.chats.get(chat.id);
}
