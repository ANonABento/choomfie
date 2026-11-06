/**
 * Shared steps for anything that hands a Discord prompt to a responder:
 * downloading attachments and forwarding to the Claude session. Used by the
 * MessageCreate handler and by `/choomfie`.
 */

import { mkdir } from "node:fs/promises";
import { basename } from "node:path";
import {
  CLAUDE_BRAIN,
  errorMessage,
  INBOUND_LOCATION_KEY,
  isDaemonOwnedProcess,
  type McpTransport,
} from "@choomfie/shared";
import { deliverInboundMessage } from "./daemon-status.ts";
import type { AppContext } from "./types.ts";

export function sanitizeAttachmentName(name?: string | null): string {
  const safeBase = basename(name || "attachment");
  const sanitized = safeBase.replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized || "attachment";
}

export interface AttachmentLike {
  name?: string | null;
  contentType?: string | null;
  size?: number | null;
  url: string;
}

/**
 * Download attachments into the inbox and record them on `meta` the way Claude
 * expects (`attachments`, `file_path`, `file_paths`). Returns the local paths.
 * A failed download is skipped; Claude still sees its description.
 */
export async function downloadAttachments(
  ctx: AppContext,
  attachments: Iterable<AttachmentLike>,
  meta: Record<string, string>
): Promise<string[]> {
  const list = [...attachments];
  if (!list.length) return [];
  meta.attachment_count = String(list.length);
  const descriptions: string[] = [];
  const filePaths: string[] = [];
  const downloadDir = `${ctx.DATA_DIR}/inbox`;
  await mkdir(downloadDir, { recursive: true });

  for (const attachment of list) {
    descriptions.push(
      `${attachment.name} (${attachment.contentType || "unknown"}, ${Math.round((attachment.size || 0) / 1024)}KB)`
    );
    try {
      const response = await fetch(attachment.url);
      if (!response.ok) throw new Error(`download failed: ${response.status}`);
      const buffer = await response.arrayBuffer();
      const safeName = sanitizeAttachmentName(attachment.name);
      const filePath = `${downloadDir}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeName}`;
      await Bun.write(filePath, buffer);
      filePaths.push(filePath);
    } catch {
      // Download failed, Claude will just see the description
    }
  }
  meta.attachments = descriptions.join("; ");
  // First path as file_path for backwards compat, all paths as file_paths
  if (filePaths.length > 0) meta.file_path = filePaths[0];
  if (filePaths.length > 1) meta.file_paths = filePaths.join(";");
  return filePaths;
}

/**
 * Forward a prompt to Claude Code — by whichever route this process has.
 *
 * Foreground sessions register the `claude/channel` capability and get the
 * message as an MCP notification. Daemon sessions cannot register it (the
 * SDK's `enableChannel` requires a marketplace-sourced plugin), so the
 * notification would be dropped on the floor and the bot would type forever
 * without answering. There, the message goes up the file channel and the
 * daemon injects it into the session itself.
 *
 * Exactly one route per process, chosen by who launched it: if the capability
 * ever starts registering under the daemon, no notification is waiting for it
 * and nothing double-delivers.
 */
export async function forwardToClaude(
  ctx: AppContext,
  content: string,
  meta: Record<string, string>,
  /** What the user actually typed, for the chat's title (content may carry a preamble). */
  titleHint: string = content,
  /** Thread, channel, DM or group DM — differs from `chat_id` for an `ask:` relay. */
  location: string = meta.chat_id
): Promise<void> {
  if (isDaemonOwnedProcess()) {
    // The daemon opens whichever chat is bound at the location, so bind one
    // (titled from this message) before the message reaches it.
    try {
      ctx.chats.current(location, CLAUDE_BRAIN, titleHint);
    } catch (error: unknown) {
      console.error(`[choomfie] chat binding failed: ${errorMessage(error)}`);
    }
    meta = { ...meta, [INBOUND_LOCATION_KEY]: location };
    try {
      await deliverInboundMessage(ctx.DATA_DIR, content, meta);
    } catch (error: unknown) {
      // Nothing else can carry this message; the user is owed the reason.
      console.error(
        `[choomfie] failed to hand message ${meta.message_id} to the daemon: ${errorMessage(error)}`
      );
    }
  } else {
    (ctx.mcp as McpTransport).notification?.({
      method: "notifications/claude/channel",
      params: { content, meta },
    });
  }
}
