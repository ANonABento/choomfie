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
export const stopUrl = (conversationId: string) =>
  `${API_ORIGIN}/api/waymond/conversations/${conversationId}/stop`;
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
  /** Quick-reply choices Waymond offered (`offer_replies` tool call); clicking one sends its text. */
  options: string[];
  /** Handed work to a background job (`start_task`); its results arrive as later messages. */
  startsTask: boolean;
  /** Approval cards (`offer_post`, `offer_message`, …) attached to this message. */
  offers: Offer[];
  /**
   * Tool calls have been attached. Waymond writes the text first and adds
   * `tool_calls` (quick replies, cards) ~2s later; until then it is null.
   */
  settled: boolean;
}

export interface Offer {
  id: string;
  kind: string;
  title: string;
  subtitle: string;
  detail: string;
  primary: string;
  secondary: string;
  /** "open" until sent or declined. */
  status: string;
}

/** An app action's offer id carries this prefix: it is approved through `app-actions`, not `cards`. */
export const APP_ACTION_PREFIX = "app:";

/**
 * Observed: `{tool: "offer_post", data: {offer: {offer_id, kind, title, subtitle, detail, primary, secondary, status}}}`,
 * and for a connected app's write (GitHub commit, …) `{tool: "propose_app_action",
 * data: {action_id, app, tool_name, tier, summary}}` (2026-11-08) — its live
 * status and arguments come from `app-actions/<id>`.
 */
function offersIn(toolCalls: unknown): Offer[] {
  if (!Array.isArray(toolCalls)) return [];
  const out: Offer[] = [];
  for (const call of toolCalls) {
    const a = call as { tool?: unknown; status?: unknown; data?: Record<string, unknown> } | null;
    if (a?.tool === "propose_app_action" && typeof a.data?.action_id === "string") {
      const d = a.data;
      const str = (v: unknown) => (typeof v === "string" ? v : "");
      out.push({
        id: APP_ACTION_PREFIX + d.action_id,
        kind: "app_action",
        title: str(d.summary) || str(d.tool_name) || "App action",
        subtitle: [str(d.app), str(d.tool_name)].filter(Boolean).join(" · "),
        detail: "",
        primary: d.tier === "ask_twice" ? "Approve (can't be undone)" : "Approve",
        secondary: "Cancel",
        status: "open",
      });
      continue;
    }
    const c = call as { tool?: unknown; data?: { offer?: Record<string, unknown> } } | null;
    const o = c?.data?.offer;
    if (typeof c?.tool !== "string" || !c.tool.startsWith("offer_") || !o || typeof o.offer_id !== "string") continue;
    const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
    out.push({
      id: o.offer_id,
      kind: str(o.kind, c.tool.slice(6)),
      title: str(o.title),
      subtitle: str(o.subtitle),
      detail: str(o.detail),
      primary: str(o.primary, "Send"),
      secondary: str(o.secondary, "Not now"),
      status: str(o.status, "open"),
    });
  }
  return out;
}

function offeredReplies(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) return [];
  const out: string[] = [];
  for (const call of toolCalls) {
    const c = call as { tool?: unknown; data?: { options?: unknown } } | null;
    if (c?.tool !== "offer_replies" || !Array.isArray(c.data?.options)) continue;
    for (const o of c.data.options) if (typeof o === "string" && o.trim()) out.push(o.trim());
  }
  return out;
}

export function parseMessages(raw: unknown): ChatMessage[] {
  const list = Array.isArray(raw) ? raw : ((raw as { messages?: unknown })?.messages as unknown[]) ?? [];
  return (Array.isArray(list) ? list : [])
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
    .map((m) => ({
      id: String(m.id ?? ""),
      role: String(m.role ?? ""),
      content: typeof m.content === "string" ? m.content : "",
      options: offeredReplies(m.tool_calls),
      startsTask:
        Array.isArray(m.tool_calls) &&
        m.tool_calls.some((c) => (c as { tool?: unknown } | null)?.tool === "start_task"),
      offers: offersIn(m.tool_calls),
      settled: Array.isArray(m.tool_calls),
    }));
}

/**
 * Waymond's answer to one user message: every non-user message after it,
 * up to the next user message. Falls back to the trailing non-user run when
 * the source id isn't in the window.
 */
function answerRun(messages: ChatMessage[], sourceUserMessageId: string | undefined): ChatMessage[] {
  let start = sourceUserMessageId ? messages.findIndex((m) => m.id === sourceUserMessageId) : -1;
  if (start < 0) {
    start = messages.length - 1;
    while (start >= 0 && messages[start].role !== "user") start--;
  }
  const out: ChatMessage[] = [];
  for (let i = start + 1; i < messages.length; i++) {
    if (messages[i].role === "user") break;
    out.push(messages[i]);
  }
  return out;
}

export function replyFor(messages: ChatMessage[], sourceUserMessageId: string | undefined): string {
  return answerRun(messages, sourceUserMessageId)
    .map((m) => m.content.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** The quick replies offered in the answer to this message (the latest offer wins). */
export function optionsFor(messages: ChatMessage[], sourceUserMessageId: string | undefined): string[] {
  const offers = answerRun(messages, sourceUserMessageId).filter((m) => m.options.length);
  return offers.length ? offers[offers.length - 1].options : [];
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
export interface AnswerState {
  done: boolean;
  reply: string;
  options: string[];
  /** The answer started a background job; more messages will follow later. */
  background: boolean;
  /** Newest message belonging to this exchange — the watermark for late results. */
  lastMessageId?: string;
  /** Waymond messages this answer delivered. */
  messageIds: string[];
  /** Approval cards still open in this answer. */
  offers: Offer[];
  /** Every message in the answer has its tool calls attached (quick replies, cards). */
  settled: boolean;
}

/**
 * Waymond messages after `afterId` that nobody has posted yet (background
 * results). A result can land after a newer user message, so this doesn't
 * stop at one; `posted` holds what sends already delivered. Unknown
 * watermark → nothing, rather than re-posting the whole window.
 */
export function lateMessages(messages: ChatMessage[], afterId: string, posted: Set<string> = new Set()): ChatMessage[] {
  const at = messages.findIndex((m) => m.id === afterId);
  if (at < 0) return [];
  return messages.slice(at + 1).filter((m) => m.role !== "user" && !posted.has(m.id));
}

export function answerState(
  messages: ChatMessage[],
  baselineIds: Set<string>,
  turnActive: boolean,
  sawActive: boolean
): AnswerState {
  const ours = messages.find((m) => m.role === "user" && !baselineIds.has(m.id));
  if (!ours) return { done: false, reply: "", options: [], background: false, messageIds: [], offers: [], settled: false };
  const run = answerRun(messages, ours.id);
  const reply = replyFor(messages, ours.id);
  return {
    done: !turnActive && (sawActive || reply.length > 0),
    reply,
    options: optionsFor(messages, ours.id),
    background: run.some((m) => m.startsTask),
    lastMessageId: (run[run.length - 1] ?? ours).id,
    messageIds: run.map((m) => m.id),
    offers: openOffers(run),
    settled: run.length > 0 && run.every((m) => m.settled),
  };
}

export function openOffers(messages: ChatMessage[]): Offer[] {
  return messages.flatMap((m) => m.offers).filter((o) => o.status === "open");
}

export const offerActionUrl = (offerId: string, action: "send" | "decline") =>
  `${API_ORIGIN}/api/waymond/cards/${encodeURIComponent(offerId)}/${action}`;

export const appActionUrl = (actionId: string, action?: "approve" | "decline") =>
  `${API_ORIGIN}/api/waymond/app-actions/${encodeURIComponent(actionId)}${action ? `/${action}` : ""}`;

export interface AppAction {
  /** "pending" until approved or declined; then running / done / declined / failed. */
  status: string;
  tier: string;
  toolkit: string;
  toolName: string;
  summary: string;
  /** What the app will be called with, for the approval preview. */
  args: Record<string, unknown>;
}

export function parseAppAction(raw: unknown): AppAction | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || typeof r.status !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    status: r.status,
    tier: str(r.tier),
    toolkit: str(r.toolkit),
    toolName: str(r.tool_name),
    summary: str(r.summary),
    args: r.arguments && typeof r.arguments === "object" ? (r.arguments as Record<string, unknown>) : {},
  };
}

/** The approval preview: each argument on its own line, long values (a whole file) cut. */
export function appActionDetail(a: AppAction): string {
  const lines = Object.entries(a.args).map(([k, v]) => {
    const text = typeof v === "string" ? v : JSON.stringify(v);
    const short = text.length > 600 ? `${text.slice(0, 600)}… (${text.length} chars)` : text;
    return short.includes("\n") ? `**${k}**\n\`\`\`\n${short.replace(/```/g, "ʼʼʼ")}\n\`\`\`` : `**${k}:** ${short}`;
  });
  return [a.tier === "ask_twice" ? "⚠️ Can't be undone." : "", ...lines].filter(Boolean).join("\n").slice(0, 3900);
}

/** `cards/waiting` → whether this conversation has an approval parked. */
export function hasWaitingCard(raw: unknown, conversationId: string): boolean {
  const convs = (raw as { conversations?: Record<string, unknown> })?.conversations;
  if (!convs || typeof convs !== "object") return false;
  const v = convs[conversationId];
  return Array.isArray(v) ? v.length > 0 : typeof v === "number" ? v > 0 : !!v;
}

export const CONVERSATION_PATH_RE = /\/chat\/([0-9a-f-]{36})(?:[/?#]|$)/;

/** Waymond's per-chat memory switch (the eye-slash button): `PUT {private: true}`. */
export const memoryPrivateUrl = (conversationId: string) =>
  `${API_ORIGIN}/api/conversations/${encodeURIComponent(conversationId)}/memory-private`;

/** The app's send request; its body names the conversation before any answer streams. */
export const CHAT_SEND_URL = `${API_ORIGIN}/api/waymond/chat`;

/** `conversation_id` from a `POST /api/waymond/chat` body, or null. */
export function conversationIdFromSend(body: string | null | undefined): string | null {
  try {
    const id = (JSON.parse(body ?? "") as { conversation_id?: unknown }).conversation_id;
    return typeof id === "string" && /^[0-9a-f-]{36}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Files Waymond made in its workspace (images, PDFs, scripts) are linked as
 * `[label](/chat?workspace=<path>&owner=<id>)` — a path inside its own app,
 * which is a dead link anywhere else. The app reads them through
 * `workspace/file`: JSON with the text inline, or a `download_url` for bytes.
 */
export interface WorkspaceLink {
  path: string;
  owner: string | null;
}

const APP_LINK_RE = /\]\((\/[^)\s]*)\)/g;

/** Every distinct workspace file the text links to, in order. */
export function workspaceLinks(text: string): WorkspaceLink[] {
  const seen = new Map<string, WorkspaceLink>();
  for (const [, href] of text.matchAll(APP_LINK_RE)) {
    if (!href.startsWith("/chat?workspace=")) continue;
    const q = new URLSearchParams(href.slice(href.indexOf("?")));
    const path = q.get("workspace");
    if (path) seen.set(`${path}\n${q.get("owner")}`, { path, owner: q.get("owner") });
  }
  return [...seen.values()];
}

/** App-relative links (`](/chat?…)`) made absolute, so they open Ambition from Discord. */
export const absoluteLinks = (text: string) => text.replace(APP_LINK_RE, (_, href: string) => `](${APP_ORIGIN}${href})`);

export const workspaceFileUrl = ({ path, owner }: WorkspaceLink) =>
  `${API_ORIGIN}/api/waymond/workspace/file?path=${encodeURIComponent(path)}${owner ? `&owner=${encodeURIComponent(owner)}` : ""}`;

/** `workspace/file` → where its bytes are. Only the app's own download route is followed. */
export function parseWorkspaceFile(raw: unknown): { downloadUrl: string } | { content: string } | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (typeof r.download_url === "string") {
    return r.download_url.startsWith("/api/waymond/workspace/download?") ? { downloadUrl: `${API_ORIGIN}${r.download_url}` } : null;
  }
  return typeof r.content === "string" ? { content: r.content } : null;
}

/**
 * Artifacts: a page Waymond builds (a web sim, a chart) shows in its chat as
 * `[[ref:artifact:<id>|<title>]]`. The record (`artifacts/<id>`, observed
 * 2026-11-08) is `{kind, title, document, media_url, meta: {libs}}`; Ambition's
 * viewer adds the libraries named in `libs` from its public /vendor folder.
 */
export interface ArtifactRef {
  token: string;
  id: string;
  title: string;
}

const ARTIFACT_REF = /\[\[ref:artifact:([0-9a-f-]{36})(?:\|([^\]]*))?\]\]/g;

export function artifactRefs(text: string): ArtifactRef[] {
  const seen = new Set<string>();
  const out: ArtifactRef[] = [];
  for (const m of text.matchAll(ARTIFACT_REF)) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    out.push({ token: m[0], id: m[1], title: (m[2] ?? "").trim() || "Artifact" });
  }
  return out;
}

export const artifactUrl = (id: string) => `${API_ORIGIN}/api/waymond/artifacts/${encodeURIComponent(id)}`;

export interface Artifact {
  kind: string;
  title: string;
  document?: string;
  mediaUrl?: string;
  libs: string[];
}

export function parseArtifact(raw: unknown): Artifact | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || typeof r.kind !== "string") return null;
  const meta = (r.meta ?? {}) as { libs?: unknown };
  return {
    kind: r.kind,
    title: typeof r.title === "string" ? r.title : "Artifact",
    document: typeof r.document === "string" ? r.document : undefined,
    mediaUrl: typeof r.media_url === "string" && r.media_url ? r.media_url : undefined,
    libs: Array.isArray(meta.libs) ? meta.libs.filter((l): l is string => typeof l === "string") : [],
  };
}

/** The libraries Ambition's viewer injects, by `libs` name. */
const VENDOR: Record<string, string[]> = {
  p5: ["p5/p5.min.js"],
  katex: ["katex/katex.min.css", "katex/katex.min.js", "katex/contrib/auto-render.min.js"],
  three: ["three/three.global.js"],
  d3: ["d3/d3.min.js"],
  figure: ["ambition-figure/figure.js"],
  leaflet: ["leaflet/leaflet.css", "leaflet/leaflet.js"],
};

/** An HTML artifact as a page that opens on its own: the viewer's libraries linked from Ambition's public /vendor. */
export function standaloneHtml(a: Artifact): string {
  const tags = a.libs
    .flatMap((l) => VENDOR[l] ?? [])
    .map((f) =>
      f.endsWith(".css") ? `<link rel="stylesheet" href="${APP_ORIGIN}/vendor/${f}">` : `<script src="${APP_ORIGIN}/vendor/${f}"></script>`
    )
    .join("");
  const doc = a.document ?? "";
  if (!tags) return doc;
  return /<head[^>]*>/i.test(doc) ? doc.replace(/<head[^>]*>/i, (h) => h + tags) : tags + doc;
}

/** A file name for an artifact: its title, made safe. */
export function artifactFileName(title: string, ext: string): string {
  const base = title.normalize("NFKD").replace(/[^\w .-]+/g, " ").replace(/\s+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${base || "artifact"}.${ext}`;
}
