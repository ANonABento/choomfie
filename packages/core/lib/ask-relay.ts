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
 * `/choomfie` hands Claude a synthetic `ask:<interaction id>` chat id, and `reply`
 * looks it up here instead of fetching a channel.
 */

import {
  ActionRowBuilder,
  ApplicationIntegrationType,
  ButtonBuilder,
  ButtonStyle,
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
  /** Replace the "thinking…" placeholder with a status line; no-op once answered. */
  progress(line: string): Promise<void>;
  /** Replace a still-unanswered placeholder with a final line; no-op once answered. */
  settle(content: string): Promise<void>;
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

/** Custom id of the 💬 Reply button; stateless, so it outlives restarts. */
export const REPLY_BUTTON_ID = "ask:reply";

export function replyRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(REPLY_BUTTON_ID).setLabel("Reply").setEmoji("💬").setStyle(ButtonStyle.Secondary)
  );
}

/**
 * The answer being replied to, minus our own question header, cut to a size
 * worth resending. It rides along so a follow-up makes sense even if the
 * Claude session cycled, or the reply is to an older answer. Used by the 💬
 * Reply button and by a plain Discord reply to one of the bot's messages, so
 * both ways of replying hand the brain the same prompt.
 */
export function replyExcerpt(answer: string, limit = 500): string {
  const body = answer
    .split("\n")
    .filter((l) => !/^> \*\*[^*]+:\*\* /.test(l))
    .join("\n")
    .trim();
  return body.length > limit ? `${body.slice(0, limit - 1)}…` : body;
}

export function replyPrompt(excerpt: string, text: string): string {
  return excerpt ? `[Replying to your earlier answer: "${excerpt}"]\n${text.trim()}` : text.trim();
}

const DISCORD_LIMIT = 2000;

export const NO_ANSWER = "⌛ No answer this time — try again.";

/** `> **alice:** what's 2+2` — the question, which nobody else in the chat can see. */
export function questionHeader(user: string, question: string): string {
  const oneLine = question.replace(/\s+/g, " ").trim();
  const short = oneLine.length > 200 ? `${oneLine.slice(0, 197)}…` : oneLine;
  return `> **${user}:** ${short || "…"}`;
}

/**
 * A channel that posts through `interaction`. The first send replaces the
 * deferred "thinking…" reply (`first: "edit"`), unless the interaction's one
 * response is already spent (a button `update`), in which case every send is
 * a follow-up. Message references aren't possible on a webhook, so `reply` is
 * dropped.
 *
 * `header` is put above the first message (the question, since a modal's text
 * and a menu's target aren't visible to the chat). `replyButton` adds 💬 Reply
 * to every message that has no buttons of its own. `progress` shows a status
 * line in the "thinking…" reply until the answer replaces it. Sends and
 * progress run in order, so a late status line can never overwrite an answer.
 */
export function interactionChannel(
  interaction: WebhookInteraction,
  opts: {
    first?: "edit" | "followUp";
    ephemeral?: boolean;
    header?: string;
    replyButton?: boolean;
    now?: () => number;
  } = {}
): RelayChannel {
  const now = opts.now ?? Date.now;
  const started = now();
  let edited = opts.first === "followUp";
  let header = opts.header;
  let chain: Promise<unknown> = Promise.resolve();
  const alive = () => now() - started < RELAY_WINDOW_MS;
  const inOrder = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };

  /** Replace a still-unanswered "thinking…" with a final line. */
  const settle = (content: string) =>
    inOrder(async () => {
      unanswered.delete(relay);
      if (edited) return;
      edited = true;
      await interaction.editReply({ content, allowedMentions: { parse: [] } } as never);
    });

  // If nothing answers before the window closes, say so instead of leaving
  // "thinking…" to turn into Discord's "The application did not respond".
  if (!edited) {
    const timer = setTimeout(() => void settle(NO_ANSWER).catch(() => {}), RELAY_WINDOW_MS - 10_000);
    (timer as { unref?: () => void }).unref?.();
  }

  const post = async (body: Record<string, unknown>) => {
    if (opts.replyButton && !(body.components as unknown[] | undefined)?.length) {
      body = { ...body, components: [replyRow()] };
    }
    if (!edited) {
      edited = true;
      unanswered.delete(relay);
      return interaction.editReply(body as never);
    }
    return interaction.followUp(
      (opts.ephemeral ? { ...body, flags: MessageFlags.Ephemeral } : body) as never
    );
  };

  const relay: RelayChannel = {
    alive,
    settle,
    send(options) {
      return inOrder(async () => {
        if (!alive()) throw new Error("Discord's 15-minute window to answer this has closed");
        const { reply: _reference, ...body } = options as Record<string, unknown>;
        if (header) {
          const top = header;
          header = undefined;
          // The header quotes the asker's own words: never let it ping anyone.
          const quiet = { parse: [] as never[] };
          const content = typeof body.content === "string" ? body.content : "";
          if (top.length + 1 + content.length <= DISCORD_LIMIT) {
            return post({ ...body, content: content ? `${top}\n${content}` : top, allowedMentions: quiet });
          }
          await post({ content: top, allowedMentions: quiet, components: [] });
        }
        return post(body);
      });
    },
    progress(line) {
      return inOrder(async () => {
        // Only while the "thinking…" reply is still a placeholder.
        if (edited || !alive()) return;
        await interaction.editReply({ content: line, allowedMentions: { parse: [] } } as never);
      });
    },
  };
  if (!edited) unanswered.add(relay);
  return relay;
}

/** Relays still showing "thinking…". In memory, so the worker settles them before it exits. */
const unanswered = new Set<RelayChannel>();

export const RESTARTED =
  "♻️ Choomfie restarted before answering — try again.";

/**
 * Close every unanswered placeholder (worker shutdown). Their timers and any
 * reply in flight die with this process, so without this they stay on
 * "thinking…" until Discord gives up.
 */
export async function settleAllRelays(content = RESTARTED, timeoutMs = 3_000): Promise<number> {
  const pending = [...unanswered];
  await Promise.race([
    Promise.all(pending.map((r) => r.settle(content).catch(() => {}))),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
  return pending.length;
}

/** `ask:<id>` chat ids handed to Claude → the interaction to answer through, and the chat it came from. */
const askRelays = new Map<string, RelayChannel & { channelId?: string }>();

/** Brain chat key (the real channel id) → its latest live relay, for late results. */
const brainRelays = new Map<string, RelayChannel>();

function sweep(map: Map<string, RelayChannel>) {
  for (const [key, relay] of map) if (!relay.alive()) map.delete(key);
}

export function isAskChatId(chatId: unknown): boolean {
  return typeof chatId === "string" && chatId.startsWith(ASK_CHAT_PREFIX);
}

/** Register an `/choomfie` for Claude to answer; returns the chat id to give it. */
export function openAskRelay(interactionId: string, relay: RelayChannel, channelId?: string): string {
  sweep(askRelays);
  const chatId = `${ASK_CHAT_PREFIX}${interactionId}`;
  askRelays.set(chatId, Object.assign(relay, { channelId }));
  return chatId;
}

/**
 * After `/stop` interrupts Claude, close every unanswered ask from that chat
 * now, rather than leaving "thinking…" up until the window runs out.
 */
export async function settleAskRelays(channelId: string, content: string): Promise<number> {
  sweep(askRelays);
  const mine = [...askRelays.values()].filter((r) => r.channelId === channelId);
  await Promise.all(mine.map((r) => r.settle(content).catch(() => {})));
  return mine.length;
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

/** What Claude sees in front of an `/choomfie` prompt, so it doesn't reach for tools that can't work there. */
export const ASK_NOTE =
  "[Sent with /choomfie from a chat Choomfie isn't in. Answer with `reply` to this chat_id " +
  "(follow-ups are fine for 15 minutes). react, edit, fetch/search, threads, polls and pins don't work here.]";

/** Shown to someone in the chat who isn't allowed to talk to Choomfie. */
export const NOT_ALLOWED = "Only people Choomfie's owner has allowed can chat with it here — you can still read along.";

export const ASK_ONLY_REPLY =
  "This chat came from /choomfie — Choomfie isn't in it, so only `reply` works here.";
