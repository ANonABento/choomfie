/**
 * Auto-thread: an @mention in a server text channel opens a thread off that
 * message, and the conversation (and its chat) lives there. Inside a thread
 * Choomfie opened, every message is for it — no mention needed.
 *
 * Opt out per channel with `/brain threads:false` (config `inlineChannels`).
 */

import { ChannelType, type Message, type ThreadChannel } from "discord.js";
import { titleFrom } from "@choomfie/shared";

type ChannelLike = { type?: ChannelType; isThread?: () => boolean; ownerId?: string | null } | null | undefined;

/** A thread this bot started — it answers every message there. */
export function isOwnThread(channel: ChannelLike, botId: string): boolean {
  return !!channel?.isThread?.() && channel.ownerId === botId;
}

/**
 * Should this message open a thread? Only an explicit @mention in a plain text
 * channel — not a reply (Discord counts the replied-to author as mentioned),
 * not an ambient message, never inside a thread.
 */
export function wantsThread(
  message: { guildId?: string | null; content: string; channel: ChannelLike },
  botId: string,
  enabled: boolean
): boolean {
  if (!enabled || !message.guildId) return false;
  if (message.channel?.type !== ChannelType.GuildText) return false;
  return new RegExp(`<@!?${botId}>`).test(message.content);
}

/** Open the thread, or null if the bot can't (missing Create Public Threads). */
export async function openThread(message: Message): Promise<ThreadChannel | null> {
  try {
    return await message.startThread({ name: titleFrom(message.content, 90) });
  } catch (e) {
    console.error(`[auto-thread] couldn't open a thread in ${message.channelId}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}
