/**
 * Conversation mode helpers — channel activation, rate limiting, uptime formatting.
 */

/** Default timeout — actual value comes from config.convoTimeoutMs at runtime */
export const DEFAULT_CONVO_IDLE_TIMEOUT = 5 * 60 * 1000; // 5 min

export function isChannelActive(
  activeChannels: Map<string, number>,
  channelId: string,
  timeoutMs: number = DEFAULT_CONVO_IDLE_TIMEOUT
): boolean {
  const lastActivity = activeChannels.get(channelId);
  if (!lastActivity) return false;
  if (Date.now() - lastActivity > timeoutMs) {
    activeChannels.delete(channelId);
    return false;
  }
  return true;
}

export function activateChannel(
  activeChannels: Map<string, number>,
  channelId: string
) {
  activeChannels.set(channelId, Date.now());
}

export function refreshChannel(
  activeChannels: Map<string, number>,
  channelId: string
) {
  if (activeChannels.has(channelId)) {
    activeChannels.set(channelId, Date.now());
  }
}

export function isRateLimited(
  lastMessageTime: Map<string, number>,
  userId: string,
  rateLimitMs: number
): boolean {
  const now = Date.now();
  const last = lastMessageTime.get(userId) || 0;
  if (now - last < rateLimitMs) return true;
  lastMessageTime.set(userId, now);
  return false;
}

// Re-export formatDuration as formatUptime for backwards compat
export { formatDuration as formatUptime } from "./time.ts";
