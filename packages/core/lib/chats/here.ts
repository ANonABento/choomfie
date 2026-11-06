/**
 * "Which chat is this?" — shared by `/resume`, `/clear` and `/status`, with no command
 * registration side effects so either can import it.
 */

import { realpathSync } from "node:fs";
import { sep } from "node:path";
import type { ButtonInteraction, ChatInputCommandInteraction } from "discord.js";
import { CLAUDE_BRAIN, type ChatRecord } from "@choomfie/shared";
import { parentChannelId, resolveBrainId } from "../brain-router.ts";
import type { AppContext } from "../types.ts";
import { CLAUDE_GLOBAL, syncClaudeChat } from "./claude.ts";

export type AnyInteraction = ChatInputCommandInteraction | ButtonInteraction;

/** The brain answering here (thread → parent channel → claude). */
export function brainAt(interaction: AnyInteraction, ctx: AppContext): string {
  return resolveBrainId(interaction.channelId!, parentChannelId(interaction.channel), (c) => ctx.config.getChannelBrain(c));
}

/** Where a chat for this brain is bound: the channel itself, or the shared Claude slot. */
export function locationFor(brain: string, channelId: string): string {
  return brain === CLAUDE_BRAIN ? CLAUDE_GLOBAL : channelId;
}

/** The chat live here for the brain answering here (Claude: the one the daemon holds). */
export async function liveChat(
  interaction: AnyInteraction,
  ctx: AppContext
): Promise<{ brain: string; chat: ChatRecord | null }> {
  const brain = brainAt(interaction, ctx);
  if (brain === CLAUDE_BRAIN) return { brain, chat: await syncClaudeChat(ctx) };
  return { brain, chat: ctx.chats.bound(interaction.channelId!, brain) };
}

export const home = () => process.env.HOME ?? "";

/** `/Users/me/x` → `~/x`, for display. */
export function shortPath(p: string | null): string {
  if (!p) return "";
  const h = home();
  return h && (p === h || p.startsWith(`${h}/`)) ? `~${p.slice(h.length)}` : p;
}

/**
 * Resolve a requested cwd against the allowed roots (`chatRoots`). Returns the
 * real path, or an error to show. Symlinks are resolved first, so a link
 * inside a root can't point a session somewhere outside it.
 */
export function resolveChatCwd(requested: string, roots: string[]): { cwd: string } | { error: string } {
  if (!roots.length) {
    return { error: 'No working directories are allowed yet. Add them to `chatRoots` in config.json, e.g. `["~/projects"]`.' };
  }
  const expanded = requested.startsWith("~") ? home() + requested.slice(1) : requested;
  let real: string;
  try {
    real = realpathSync(expanded);
  } catch {
    return { error: `\`${requested}\` doesn't exist.` };
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      continue;
    }
    if (real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) return { cwd: real };
  }
  return { error: `\`${requested}\` isn't under an allowed root (${roots.map((r) => `\`${shortPath(r)}\``).join(", ")}).` };
}
