/**
 * Waymond plugin — Ambition's Waymond as a Choomfie brain, built on the
 * web-brain kit (@choomfie/webbrain). Everything Ambition-specific is in
 * adapter.ts and api.ts.
 *
 * Enable with `/plugins`, log in once with `bun run webbrain login waymond`,
 * then `/brain waymond` in a channel. No tools and no instructions: it costs
 * the Claude session nothing.
 */

import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { ChatsApi } from "@choomfie/shared";
import { defineWebBrain, siteDir } from "@choomfie/webbrain";
import { waymondAdapter } from "./adapter.ts";

export { waymondAdapter as adapter, toApproval } from "./adapter.ts";
export { framePrompt, originalName } from "@choomfie/webbrain";

const BRAIN_ID = "waymond";

/**
 * Before chats lived in core, Waymond kept its own `chats.json` (channel →
 * conversation id). Import it once so existing conversations carry on, then
 * set the file aside — never deleted, in case the import needs redoing.
 */
export function importLegacyChatMap(path: string, chats: ChatsApi): number {
  if (!existsSync(path)) return 0;
  let map: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (raw && typeof raw === "object") map = raw;
  } catch {
    // Unreadable: nothing to carry over.
  }
  let imported = 0;
  for (const [chatKey, convId] of Object.entries(map)) {
    if (typeof convId !== "string" || chats.bound(chatKey, BRAIN_ID)) continue;
    const chat = chats.start(chatKey, BRAIN_ID, "Waymond chat");
    chats.setBackendRef(chat.id, convId);
    imported++;
  }
  renameSync(path, `${path}.migrated`);
  return imported;
}

export default defineWebBrain(waymondAdapter, {
  onInit(ctx, chats) {
    const imported = importLegacyChatMap(join(siteDir(ctx.DATA_DIR, BRAIN_ID), "chats.json"), chats);
    if (imported) console.error(`[waymond] imported ${imported} conversation(s) from chats.json`);
  },
});
