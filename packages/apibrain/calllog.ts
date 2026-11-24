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

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
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
  ms?: number;
  error?: string;
}

export type LogEntry = CallEntry | RouteEntry;

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

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

export class CallLog {
  constructor(
    readonly file: string | null,
    private maxBytes = DEFAULT_MAX_BYTES
  ) {
    if (file) mkdirSync(dirname(file), { recursive: true });
  }

  write(entry: LogEntry): void {
    if (!this.file) return;
    try {
      if (existsSync(this.file) && statSync(this.file).size > this.maxBytes) renameSync(this.file, `${this.file}.1`);
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    } catch (e) {
      console.error(`[apibrain] couldn't write the call log: ${e instanceof Error ? e.message : e}`);
    }
  }
}

export const nowIso = () => new Date().toISOString();
