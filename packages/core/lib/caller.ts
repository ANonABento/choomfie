/**
 * Who is behind a tool call, for tools that act with the owner's authority
 * (asking another brain, running a pipeline on the owner's machine).
 *
 * The security rules in the prompt already keep those tools from non-owners;
 * this is the check in code, so a prompt injection in someone else's message
 * can't reach them either. It works from the one thing the worker knows for
 * sure: the role of the latest message it handed to Claude in each chat
 * (`recordTurn`, called by `forwardToClaude`).
 *
 * - A daemon session's calls carry its own location (its endpoint token is
 *   bound to it), so the check is on that chat.
 * - The supervisor's single session serves every chat, so the check falls back
 *   to the chat the tool names (`chat_id`) — and, since Claude picks that
 *   argument, also needs the latest message handed over anywhere to be the
 *   owner's: an injected message can't borrow a chat where the owner spoke.
 * - The remote endpoint is the owner's own token: owner by definition, and its
 *   tool allowlist is the boundary there.
 */

import { INBOUND_LOCATION_KEY } from "@choomfie/shared";
import type { ToolCaller } from "./ipc-types.ts";

/** Enough for every chat that's active at once; the oldest are forgotten first. */
const MAX_CHATS = 1000;

/** Chat (location or chat id) → role of the latest message handed to Claude there. */
const lastRole = new Map<string, string>();
/** Role of the latest message handed to Claude in any chat. */
let latestRole = "";

function remember(key: string, role: string): void {
  lastRole.delete(key); // re-insert, so the map stays oldest-first
  lastRole.set(key, role);
  if (lastRole.size > MAX_CHATS) lastRole.delete(lastRole.keys().next().value!);
}

/** Record who sent the message being handed to Claude, under its location and its chat id. */
export function recordTurn(meta: Record<string, string>, location?: string): void {
  const role = meta.role === "owner" ? "owner" : "user";
  latestRole = role;
  const keys = new Set([location, meta[INBOUND_LOCATION_KEY], meta.chat_id].filter((k): k is string => !!k));
  for (const key of keys) remember(key, role);
}

/** True when the owner is behind this call. Unknown chats are not the owner. */
export function callerIsOwner(caller: ToolCaller, args: Record<string, unknown>): boolean {
  if (caller.via === "remote") return true;
  if (caller.via === "session") return lastRole.get(caller.location) === "owner";
  const chat = typeof args.chat_id === "string" ? args.chat_id : "";
  return !!chat && lastRole.get(chat) === "owner" && latestRole === "owner";
}

/** Tests only. */
export function _resetTurns(): void {
  lastRole.clear();
  latestRole = "";
}
