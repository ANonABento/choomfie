/**
 * What an API model is sent for one turn, built to a token budget:
 *
 *   system (persona + Discord rules + mode frame)
 *   → summary of older turns → recent turns (newest that fit) → this message
 *
 * Free tiers are small (Groq's TPM, OpenRouter's 50 a day), so the full
 * transcript never goes out: the oldest turns are dropped first, and
 * `compact.ts` folds them into the summary in the background.
 */

import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { ChatMessage, ContentPart } from "./client.ts";
import type { Summary, Turn } from "./transcript.ts";

/** Rough tokens for a text (4 characters a token). Good enough for budgets, never for billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const TEXT_EXT = /\.(txt|md|csv|tsv|json|ya?ml|toml|ini|log|xml|html?|css|js|jsx|ts|tsx|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|cs|sh|sql|scad)$/i;
/** Inline a text attachment up to this many characters. */
const MAX_TEXT_CHARS = 24_000;
/** Images bigger than this aren't sent (most providers cap data URLs around 4–5 MB). */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** Tokens an image costs in the budget (providers vary; this is a middling guess). */
export const IMAGE_TOKENS = 1_000;

export function isImage(path: string): boolean {
  return extname(path).toLowerCase() in IMAGE_TYPES;
}

/** Discord inbox files are named `<ts>_<rand>_<name>`. */
const shownName = (path: string) => (path.split("/").pop() ?? path).replace(/^\d+_[a-z0-9]+_/, "");

export interface UserContent {
  /** What the model gets. */
  content: string | ContentPart[];
  /** What the transcript keeps (attachments as short notes, never their bytes). */
  record: string;
  tokens: number;
}

/** The message plus its attachments: images as data URLs when the model can see, text files inline, the rest named. */
export function userContent(text: string, filePaths: string[], vision: boolean): UserContent {
  const notes: string[] = [];
  const inline: string[] = [];
  const images: ContentPart[] = [];
  for (const path of filePaths) {
    const name = shownName(path);
    try {
      if (isImage(path)) {
        if (vision && statSync(path).size <= MAX_IMAGE_BYTES) {
          const data = readFileSync(path).toString("base64");
          images.push({ type: "image_url", image_url: { url: `data:${IMAGE_TYPES[extname(path).toLowerCase()]};base64,${data}` } });
          notes.push(`[image: ${name}]`);
        } else notes.push(`[image ${name} attached — this model can't see images]`);
      } else if (TEXT_EXT.test(path)) {
        const body = readFileSync(path, "utf8");
        const clipped = body.length > MAX_TEXT_CHARS ? `${body.slice(0, MAX_TEXT_CHARS)}\n… (clipped)` : body;
        inline.push(`File ${name}:\n\`\`\`\n${clipped}\n\`\`\``);
        notes.push(`[file: ${name}]`);
      } else notes.push(`[attachment ${name} — not readable here]`);
    } catch {
      notes.push(`[attachment ${name} — couldn't be read]`);
    }
  }
  const full = [text, ...inline, ...notes.filter((n) => !n.startsWith("[file:") && !n.startsWith("[image:"))].filter(Boolean).join("\n\n");
  const record = [text, ...notes].filter(Boolean).join("\n");
  const tokens = estimateTokens(full) + images.length * IMAGE_TOKENS;
  return { content: images.length ? [{ type: "text", text: full }, ...images] : full, record, tokens };
}

export interface Persona {
  name: string;
  personality: string;
}

/** The system prompt: who to be, where you are, and the chat's mode frame. */
/** Core memories past this many characters are cut (they ride on every answer call). */
const MEMORY_CHARS = 2_000;

export function systemPrompt(persona: Persona | undefined, modeFrame?: string, memories?: string): string {
  const who = persona ? `You are ${persona.name}. ${persona.personality.trim()}` : "You are a helpful assistant.";
  const remembered = memories?.trim();
  return [
    who,
    "You're replying in a Discord chat. Use Discord markdown, keep replies concise unless asked for depth, and stay under about 1800 characters when you can.",
    remembered && remembered.length > MEMORY_CHARS ? `${remembered.slice(0, MEMORY_CHARS)}\n…` : remembered,
    modeFrame?.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * A reply that opens with a speaker label (`**Mahiro**:`, `Mahiro Oyama —`,
 * a `### Mahiro` heading): some models write a script when given a
 * character. Cut here rather than forbidden in the prompt, so it never
 * reaches Discord or the transcript (where the next turn would copy it).
 */
export function stripSpeakerLabel(text: string, persona?: Persona): string {
  const names = new Set(["assistant", "ai"]);
  if (persona?.name) {
    names.add(persona.name.toLowerCase());
    names.add(persona.name.split(/\s+/)[0].toLowerCase());
  }
  const m = /^\s*(?:#{1,6}\s*)?(?:\*\*|__|\*)?([^\n*_:：—–-]{1,40}?)(?:\s*[:：]\s*(?:\*\*|__|\*)?|(?:\*\*|__|\*)?\s*(?:[:：—–-]|\n))\s*/.exec(text);
  if (!m || !names.has(m[1].trim().toLowerCase())) return text;
  const rest = text.slice(m[0].length);
  return rest.trim() ? rest.trimStart() : text;
}

export interface BuildInput {
  system: string;
  summary: Summary | null;
  history: Turn[];
  current: UserContent;
  /** Input tokens to stay under. */
  budget: number;
}

export interface Built {
  messages: ChatMessage[];
  tokens: number;
  /** History turns that didn't fit (left for compaction). */
  dropped: number;
}

/** Fill the budget newest-first; the system prompt and this message always go. */
export function buildMessages(input: BuildInput): Built {
  const head: ChatMessage[] = [{ role: "system", content: input.system }];
  if (input.summary) head.push({ role: "system", content: `Summary of the conversation so far:\n${input.summary.text}` });
  let tokens = head.reduce((n, m) => n + estimateTokens(m.content as string), 0) + input.current.tokens;
  const kept: ChatMessage[] = [];
  let i = input.history.length - 1;
  for (; i >= 0; i--) {
    const t = input.history[i];
    const cost = estimateTokens(t.content);
    if (tokens + cost > input.budget) break;
    tokens += cost;
    kept.unshift({ role: t.role, content: t.content });
  }
  // A model expects the conversation to start with a user turn.
  while (kept[0]?.role === "assistant") tokens -= estimateTokens(kept.shift()!.content as string);
  return { messages: [...head, ...kept, { role: "user", content: input.current.content }], tokens, dropped: i + 1 };
}

/**
 * For a brain that keeps its own conversation (a web brain): what happened
 * in this chat since it last answered, so a switch to it doesn't lose the thread.
 */
export function recap(summary: Summary | null, missed: Turn[], maxChars = 4_000): string {
  if (!missed.length && !summary) return "";
  const lines = missed.map((t) => `${t.role === "user" ? "User" : `Assistant${t.member ? ` (${t.member})` : ""}`}: ${t.content}`);
  let body = lines.join("\n");
  if (body.length > maxChars) body = `…${body.slice(body.length - maxChars)}`;
  const parts = [summary && (!missed.length || missed[0].id > summary.uptoId) ? `Earlier: ${summary.text}` : "", body].filter(Boolean);
  return `[Context from this Discord chat, answered by other models before you — for reference, don't reply to it:\n${parts.join("\n")}\n]`;
}
