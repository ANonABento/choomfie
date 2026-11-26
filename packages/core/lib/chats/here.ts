/**
 * "Which chat is this?" — shared by `/resume`, `/clear` and `/status`, with no command
 * registration side effects so either can import it.
 */

import { realpathSync } from "node:fs";
import { sep } from "node:path";
import type { AutocompleteInteraction, ButtonInteraction, ChatInputCommandInteraction } from "discord.js";
import { chatHomeDir, CLAUDE_BRAIN, getBrain, relativeTime, type ChatRecord } from "@choomfie/shared";
import { parentChannelId, resolveBrainId } from "../brain-router.ts";
import { isDaemonMode } from "../daemon-status.ts";
import type { AppContext } from "../types.ts";

export type AnyInteraction = ChatInputCommandInteraction | ButtonInteraction;

/** The brain answering here (thread → parent channel → claude). */
export function brainAt(interaction: AnyInteraction | AutocompleteInteraction, ctx: AppContext): string {
  return resolveBrainId(interaction.channelId!, parentChannelId(interaction.channel), (c) => ctx.config.getChannelBrain(c), ctx.config.getDefaultBrain());
}

/**
 * The chat live here for the brain answering here. Claude in foreground mode
 * has none: the terminal's session isn't a Choomfie chat.
 */
export async function liveChat(
  interaction: AnyInteraction,
  ctx: AppContext
): Promise<{ brain: string; chat: ChatRecord | null }> {
  const brain = brainAt(interaction, ctx);
  if (brain === CLAUDE_BRAIN && !(await isDaemonMode(ctx.DATA_DIR))) return { brain, chat: null };
  return { brain, chat: ctx.chats.bound(interaction.channelId!, brain) };
}

/**
 * A chat's state in a few lines: title, cwd, model, mode. A model that is
 * another brain (free's chat after Waymond answered) means that brain holds
 * the chat and gets every message until released — said in so many words,
 * with how to release it.
 */
export function chatStateLines(ctx: Pick<AppContext, "DATA_DIR">, brain: string, chat: ChatRecord): string[] {
  const lines = [`Chat: **${chat.title}** · since ${relativeTime(chat.createdAt)}`];
  const cwd = cwdLabel(ctx, chat.cwd);
  if (cwd) lines.push(`cwd: \`${cwd}\``);
  if (chat.model) {
    const member = chat.model.split(":")[0];
    const holder = member !== brain ? getBrain(member) : undefined;
    lines.push(
      holder
        ? `Held by **${holder.label}** — it answered here, so every message goes to it. **Back to auto** under its reply or \`/model auto\` to release; \`/clear\` for a fresh chat.`
        : `Model: **${chat.model}** (\`/model auto\` to let it choose)`
    );
  }
  if (chat.mode) lines.push(`Mode: **${chat.mode}**`);
  return lines;
}

export const home = () => process.env.HOME ?? "";

/** A chat's cwd for display, or "" for the default chat home (nothing to say). */
export function cwdLabel(ctx: Pick<AppContext, "DATA_DIR">, cwd: string | null): string {
  return !cwd || cwd === chatHomeDir(ctx.DATA_DIR) ? "" : shortPath(cwd);
}

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
