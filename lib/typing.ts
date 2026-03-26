/**
 * Typing indicator state machine.
 *
 * States per channel:
 *   IDLE   → no typing indicator
 *   TYPING → typing indicator active (refreshing every 8s)
 *
 * Transitions:
 *   IDLE   → message received               → TYPING
 *   TYPING → reply sent (keep_typing=false)  → IDLE
 *   TYPING → safety timeout (2min)           → IDLE
 *
 * The reply tool controls the transition via `keep_typing`:
 *   - keep_typing: true  → stay in TYPING (for multi-message workflows)
 *   - keep_typing: false → transition to IDLE (default)
 */

import type { TextChannel, DMChannel, NewsChannel } from "discord.js";

interface ChannelTypingState {
  state: "idle" | "typing";
  /** Interval that refreshes sendTyping every 8s */
  typingInterval?: ReturnType<typeof setInterval>;
  /** Safety timeout (2min) */
  timeout?: ReturnType<typeof setTimeout>;
}

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
}

function startTyping(channelId: string, channel: TextChannel | DMChannel | NewsChannel) {
  const s = getState(channelId);
  clearTimers(s);
  s.state = "typing";

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
 * Called when a reply or poll is sent — stop typing.
 * The reply tool skips this call when keep_typing is true.
 */
export function onReplySent(channelId: string) {
  transitionToIdle(channelId);
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
