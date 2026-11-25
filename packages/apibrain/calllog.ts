/**
 * What was actually sent to each API, and why. A web brain shows you its
 * conversation; an API call is invisible unless it's written down. Two kinds
 * of line in `<data>/apibrain/calls.jsonl`:
 *
 *   - `route`: one per Discord message — the bucket, how it was classified,
 *     what was skipped or failed, who answered;
 *   - `call`: one per HTTP attempt — provider, key number (never the key),
 *     model, the full messages (images as a size note), the reply or error.
 *
 * `bun run apibrain log` reads it. The file rolls over at `maxBytes` (one
 * `.1` kept), so it never grows without bound.
 */

import { JsonlLog, nowIso } from "@choomfie/shared";
import type { ChatMessage } from "./client.ts";

export interface CallEntry {
  type: "call";
  at: string;
  /** What the call was for. */
  purpose: "answer" | "classify" | "summary" | "probe" | "other";
  chat?: string;
  provider: string;
  key: number;
  model: string;
  ms: number;
  ok: boolean;
  error?: string;
  messages: ChatMessage[];
  reply?: string;
  usage?: { prompt: number; completion: number };
}

export interface RouteEntry {
  type: "route";
  at: string;
  chat: string;
  brain: string;
  /** The user's message, clipped. */
  text: string;
  bucket: string;
  by: string;
  confidence?: number;
  reason?: string;
  /** Targets in the order they'd be tried. */
  plan: string[];
  /** What was skipped or failed first. */
  passed: string[];
  answered?: string;
  /** A web brain offered with a button instead of called (mid-chat). */
  offered?: string;
  ms?: number;
  error?: string;
}

export type LogEntry = CallEntry | RouteEntry;

/** Messages as they went out, minus image bytes. */
export function redact(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    typeof m.content === "string"
      ? m
      : {
          ...m,
          content: m.content.map((p) =>
            p.type === "image_url" ? { type: "image_url" as const, image_url: { url: `[image, ${Math.round((p.image_url.url.length * 3) / 4 / 1024)} KB]` } } : p
          ),
        }
  );
}

/** `<data>/apibrain/calls.jsonl` (the shared rolling JSONL log). */
export class CallLog extends JsonlLog<LogEntry> {
  constructor(file: string | null, maxBytes?: number) {
    super(file, maxBytes, "apibrain");
  }
}

export { nowIso };
