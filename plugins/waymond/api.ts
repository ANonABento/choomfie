/**
 * Ambition's undocumented Waymond endpoints, as observed 2026-11-04.
 * See docs/_research/ambition-waymond.md (local-only). Every shape here can
 * change without notice — parse defensively and fail with a clear message.
 */

export const APP_ORIGIN = "https://app.ambition.inc";
export const API_ORIGIN = "https://api-production.ambition.inc";

export const chatUrl = (conversationId?: string) =>
  conversationId ? `${APP_ORIGIN}/chat/${conversationId}` : `${APP_ORIGIN}/chat?new=1`;
export const turnUrl = (conversationId: string) =>
  `${API_ORIGIN}/api/waymond/conversations/${conversationId}/turn`;
export const messagesUrl = (conversationId: string) =>
  `${API_ORIGIN}/api/conversations/${conversationId}/messages?limit=60`;
export const waitingCardsUrl = () => `${API_ORIGIN}/api/waymond/cards/waiting`;

export interface TurnState {
  active: boolean;
  phase?: string;
  sourceUserMessageId?: string;
  intent?: string;
  /** Labels of tools currently running. */
  running: string[];
}

export function parseTurn(raw: unknown): TurnState {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const progress = (r.progress && typeof r.progress === "object" ? r.progress : {}) as Record<string, unknown>;
  const tools = Array.isArray(progress.tools) ? progress.tools : [];
  return {
    active: r.active === true,
    phase: typeof r.phase === "string" ? r.phase : undefined,
    sourceUserMessageId:
      typeof r.source_user_message_id === "string" ? r.source_user_message_id : undefined,
    intent: typeof progress.intent === "string" ? progress.intent : undefined,
    running: tools
      .filter((t) => t && typeof t === "object" && (t as { status?: unknown }).status !== "done")
      .map((t) => String((t as { label?: unknown }).label ?? (t as { tool?: unknown }).tool ?? ""))
      .filter(Boolean),
  };
}

export interface ChatMessage {
  id: string;
  role: string;
  content: string;
}

export function parseMessages(raw: unknown): ChatMessage[] {
  const list = Array.isArray(raw) ? raw : ((raw as { messages?: unknown })?.messages as unknown[]) ?? [];
  return (Array.isArray(list) ? list : [])
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
    .map((m) => ({
      id: String(m.id ?? ""),
      role: String(m.role ?? ""),
      content: typeof m.content === "string" ? m.content : "",
    }));
}

/**
 * Waymond's answer to one user message: every non-user message after it,
 * up to the next user message. Falls back to the trailing non-user run when
 * the source id isn't in the window.
 */
export function replyFor(messages: ChatMessage[], sourceUserMessageId: string | undefined): string {
  let start = sourceUserMessageId ? messages.findIndex((m) => m.id === sourceUserMessageId) : -1;
  if (start < 0) {
    start = messages.length - 1;
    while (start >= 0 && messages[start].role !== "user") start--;
  }
  const out: string[] = [];
  for (let i = start + 1; i < messages.length; i++) {
    if (messages[i].role === "user") break;
    if (messages[i].content.trim()) out.push(messages[i].content.trim());
  }
  return out.join("\n\n");
}

/**
 * Has Waymond finished answering the message we just sent?
 *
 * `/turn` can't say on its own: once idle it is just `{active:false}` with no
 * `source_user_message_id`, and right after sending it is *also* idle because
 * the job hasn't started. So: find our message (the first user message that
 * wasn't there before we sent), and call it done once the turn is idle and we
 * either saw it working or an answer already sits after our message.
 */
export function answerState(
  messages: ChatMessage[],
  baselineIds: Set<string>,
  turnActive: boolean,
  sawActive: boolean
): { done: boolean; reply: string; ourMessageId?: string } {
  const ours = messages.find((m) => m.role === "user" && !baselineIds.has(m.id));
  if (!ours) return { done: false, reply: "" };
  const reply = replyFor(messages, ours.id);
  return { done: !turnActive && (sawActive || reply.length > 0), reply, ourMessageId: ours.id };
}

/** `cards/waiting` → whether this conversation has an approval parked. */
export function hasWaitingCard(raw: unknown, conversationId: string): boolean {
  const convs = (raw as { conversations?: Record<string, unknown> })?.conversations;
  if (!convs || typeof convs !== "object") return false;
  const v = convs[conversationId];
  return Array.isArray(v) ? v.length > 0 : typeof v === "number" ? v > 0 : !!v;
}

export const CONVERSATION_PATH_RE = /\/chat\/([0-9a-f-]{36})(?:[/?#]|$)/;
