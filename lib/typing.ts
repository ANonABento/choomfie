/**
 * Typing indicator state machine.
 *
 * States per channel:
 *   IDLE     → no typing indicator
 *   TYPING   → typing indicator active (refreshing every 8s)
 *   COOLDOWN → typing stopped, waiting to see if more tool calls come
 *
 * Transitions:
 *   IDLE     → message received       → TYPING
 *   TYPING   → reply/poll sent        → COOLDOWN
 *   COOLDOWN → any tool call          → TYPING
 *   COOLDOWN → timer expires (10s)    → IDLE
 *   TYPING   → safety timeout (2min)  → IDLE
 */

import type { AppContext } from "./types.ts";
import type { TextChannel, DMChannel, NewsChannel } from "discord.js";

type TypingState = "idle" | "typing" | "cooldown";

interface ChannelTypingState {
  state: TypingState;
  /** Interval that refreshes sendTyping every 8s */
  typingInterval?: ReturnType<typeof setInterval>;
  /** Safety timeout (2min) or cooldown timeout (10s) */
  timeout?: ReturnType<typeof setTimeout>;
  /** The channel object for sending typing */
  channel?: TextChannel | DMChannel | NewsChannel;
}

const COOLDOWN_MS = 10_000;
const SAFETY_TIMEOUT_MS = 120_000;
const TYPING_REFRESH_MS = 8_000;

const states = new Map<string, ChannelTypingState>();

function getState(channelId: string): ChannelTypingState {
  let s = states.get(channelId);
  if (!s) {
    s = { state: "idle" };
    states.set(channelId, s);
  }
  return s;
}

function clearTimers(s: ChannelTypingState) {
  if (s.typingInterval) {
    clearInterval(s.typingInterval);
    s.typingInterval = undefined;
  }
  if (s.timeout) {
    clearTimeout(s.timeout);
    s.timeout = undefined;
  }
}

function transitionToIdle(channelId: string) {
  const s = getState(channelId);
  clearTimers(s);
  s.state = "idle";
  s.channel = undefined;
}

function startTyping(channelId: string, channel: TextChannel | DMChannel | NewsChannel) {
  const s = getState(channelId);
  clearTimers(s);
  s.state = "typing";
  s.channel = channel;

  // Send initial typing
  if (channel.isTextBased() && "sendTyping" in channel) {
    channel.sendTyping().catch(() => {});
  }

  // Refresh every 8s
  s.typingInterval = setInterval(() => {
    if (channel.isTextBased() && "sendTyping" in channel) {
      channel.sendTyping().catch(() => {
        transitionToIdle(channelId);
      });
    }
  }, TYPING_REFRESH_MS);

  // Safety timeout: 2min max
  s.timeout = setTimeout(() => {
    transitionToIdle(channelId);
  }, SAFETY_TIMEOUT_MS);
}

/**
 * Called when a Discord message is received — start showing typing.
 * Skip for conversation_mode (Claude may not reply).
 */
export function onMessageReceived(
  channelId: string,
  channel: TextChannel | DMChannel | NewsChannel,
  isConversationMode: boolean
) {
  if (isConversationMode) return;
  startTyping(channelId, channel);
}

/**
 * Called when a reply or poll is sent — transition to cooldown.
 */
export function onReplySent(channelId: string) {
  const s = getState(channelId);
  if (s.state === "idle") return;

  clearTimers(s);
  s.state = "cooldown";

  // If no tool call within 10s, go idle
  s.timeout = setTimeout(() => {
    transitionToIdle(channelId);
  }, COOLDOWN_MS);
}

/**
 * Called when any tool is invoked — if in cooldown, resume typing.
 * Needs the channelId from the tool args (chat_id).
 */
export function onToolCall(channelId: string) {
  const s = getState(channelId);
  if (s.state === "cooldown" && s.channel) {
    startTyping(channelId, s.channel);
  }
}

/**
 * Clean up all typing state (for shutdown).
 */
export function destroyAll() {
  for (const [, s] of states) {
    clearTimers(s);
  }
  states.clear();
}
