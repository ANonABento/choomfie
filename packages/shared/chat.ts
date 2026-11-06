/**
 * Chats — one conversation with one brain, bound to a Discord location.
 *
 * A *location* is where you talk: a thread, a channel, a DM or a group DM —
 * whatever `channelId` Discord reports, which is already the thread id inside
 * a thread. A *chat* is the conversation held there, with its backend's own
 * id (`backendRef`: a Waymond conversation id, a Claude SDK session id).
 *
 * The indirection is what lets `/resume` put an old conversation back
 * into a location without the brain having to know: the brain asks "which chat
 * is live here?" and gets whichever one is bound.
 *
 * Bindings are keyed by (location, brain), so switching a channel's brain with
 * `/brain` and back again finds the old conversation where it was left.
 *
 * Routing only. Who may talk to Choomfie at all stays in access.json, and
 * which brain answers stays in config `brainChannels`.
 */

export interface ChatRecord {
  id: string;
  brain: string;
  /** The backend's id for this conversation, once it has one. */
  backendRef: string | null;
  title: string;
  /** Working directory (Claude chats only). */
  cwd: string | null;
  /** Model for this chat (Claude chats only); null = the configured default. */
  model: string | null;
  /** Location the chat was started in. */
  locationId: string;
  /** SQLite datetimes (`YYYY-MM-DD HH:MM:SS`, UTC). */
  createdAt: string;
  lastActiveAt: string;
}

/** What plugins need from the chat store. Core passes the real one in `PluginContext.chats`. */
export interface ChatsApi {
  /**
   * The chat live at this location for this brain, created and bound on first
   * use. `message` is what was just said: it titles a new or untitled chat.
   */
  current(locationId: string, brain: string, message?: string): ChatRecord;
  /** The chat bound here, without creating one. */
  bound(locationId: string, brain: string): ChatRecord | null;
  get(chatId: string): ChatRecord | null;
  setBackendRef(chatId: string, ref: string | null): void;
  touch(chatId: string): void;
  /** Start a fresh chat here and bind it; the previous one stays listable. */
  start(locationId: string, brain: string, title?: string): ChatRecord;
}

/** Title of a chat nobody has named and nobody has spoken in yet. */
export const UNTITLED_CHAT = "Untitled chat";

/** Longest auto-generated title. */
export const CHAT_TITLE_MAX = 60;

/** A readable title from a first message: mentions stripped, one line, clipped. */
export function titleFrom(text: string, max = CHAT_TITLE_MAX): string {
  const line = text
    .replace(/<@[!&]?\d+>|<#\d+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return UNTITLED_CHAT;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
