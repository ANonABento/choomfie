/**
 * Answering through an interaction instead of a channel.
 *
 * A user-installed app can be used in chats the bot isn't in — group DMs, other
 * people's DMs, servers without the bot. There, `channel.send` fails: the only
 * way to speak is the interaction's own webhook, which Discord keeps open for
 * 15 minutes. `interactionChannel` wraps that webhook in the same
 * `SendableChannel` shape the brain router already posts through, so brain
 * replies, quick-reply buttons and approval cards work unchanged.
 *
 * Claude replies through the `reply` tool, which addresses a `chat_id`. An
 * `/ask` hands Claude a synthetic `ask:<interaction id>` chat id, and `reply`
 * looks it up here instead of fetching a channel.
 */

import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
} from "discord.js";
import type { SendableChannel } from "./brain-router.ts";

/** Discord's interaction-token lifetime, less a margin for a slow last send. */
export const RELAY_WINDOW_MS = 15 * 60_000 - 30_000;

export const ASK_CHAT_PREFIX = "ask:";

export interface WebhookInteraction {
  editReply(options: never): Promise<unknown>;
  followUp(options: never): Promise<unknown>;
}

export interface RelayChannel extends SendableChannel {
  alive(): boolean;
}

/**
 * True when the bot itself isn't in the chat this interaction came from, so
 * only the interaction webhook can answer. A guild that installed the bot, or
 * the bot's own DM, can be posted to normally.
 */
export function botIsAbsent(interaction: {
  authorizingIntegrationOwners?: Partial<Record<ApplicationIntegrationType, string>> | null;
  context?: InteractionContextType | null;
}): boolean {
  const owners = interaction.authorizingIntegrationOwners ?? {};
  if (owners[ApplicationIntegrationType.GuildInstall] !== undefined) return false;
  return interaction.context !== InteractionContextType.BotDM;
}

/**
 * A channel that posts through `interaction`. The first send replaces the
 * deferred "thinking…" reply (`first: "edit"`), unless the interaction's one
 * response is already spent (a button `update`), in which case every send is
 * a follow-up. Message references aren't possible on a webhook, so `reply` is
 * dropped.
 */
export function interactionChannel(
  interaction: WebhookInteraction,
  opts: { first?: "edit" | "followUp"; ephemeral?: boolean; now?: () => number } = {}
): RelayChannel {
  const now = opts.now ?? Date.now;
  const started = now();
  let edited = opts.first === "followUp";
  const alive = () => now() - started < RELAY_WINDOW_MS;
  return {
    alive,
    async send(options) {
      if (!alive()) throw new Error("Discord's 15-minute window to answer this has closed");
      const { reply: _reference, ...body } = options;
      if (!edited) {
        edited = true;
        return interaction.editReply(body as never);
      }
      return interaction.followUp(
        (opts.ephemeral ? { ...body, flags: MessageFlags.Ephemeral } : body) as never
      );
    },
  };
}

/** `ask:<id>` chat ids handed to Claude → the interaction to answer through. */
const askRelays = new Map<string, RelayChannel>();

/** Brain chat key (the real channel id) → its latest live relay, for late results. */
const brainRelays = new Map<string, RelayChannel>();

function sweep(map: Map<string, RelayChannel>) {
  for (const [key, relay] of map) if (!relay.alive()) map.delete(key);
}

export function isAskChatId(chatId: unknown): boolean {
  return typeof chatId === "string" && chatId.startsWith(ASK_CHAT_PREFIX);
}

/** Register an `/ask` for Claude to answer; returns the chat id to give it. */
export function openAskRelay(interactionId: string, relay: RelayChannel): string {
  sweep(askRelays);
  const chatId = `${ASK_CHAT_PREFIX}${interactionId}`;
  askRelays.set(chatId, relay);
  return chatId;
}

/** The live relay for an `ask:` chat id, or undefined once its window closed. */
export function getAskRelay(chatId: string): RelayChannel | undefined {
  const relay = askRelays.get(chatId);
  if (relay && !relay.alive()) askRelays.delete(chatId);
  return relay?.alive() ? relay : undefined;
}

export function rememberBrainRelay(chatKey: string, relay: RelayChannel): void {
  sweep(brainRelays);
  brainRelays.set(chatKey, relay);
}

export function getBrainRelay(chatKey: string): RelayChannel | undefined {
  const relay = brainRelays.get(chatKey);
  return relay?.alive() ? relay : undefined;
}

/** What Claude sees in front of an `/ask` prompt, so it doesn't reach for tools that can't work there. */
export const ASK_NOTE =
  "[Sent with /ask from a chat Choomfie isn't in. Answer with `reply` to this chat_id " +
  "(follow-ups are fine for 15 minutes). react, edit, fetch/search, threads, polls and pins don't work here.]";

export const ASK_ONLY_REPLY =
  "This chat came from /ask — Choomfie isn't in it, so only `reply` works here.";
