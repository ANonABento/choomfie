/**
 * "Which chat is this?" — shared by `/chat` and `/status`, with no command
 * registration side effects so either can import it.
 */

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
