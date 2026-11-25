/**
 * An append-only JSONL log that rolls over at `maxBytes` (one `.1` kept), so
 * it never grows without bound. The brain kits write what they did here: the
 * daemon's stderr goes to a terminal (or nowhere), and a Discord reply alone
 * doesn't say what went wrong. Writing never throws.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export const nowIso = () => new Date().toISOString();

export class JsonlLog<T extends object = Record<string, unknown>> {
  constructor(
    readonly file: string | null,
    private maxBytes = DEFAULT_MAX_BYTES,
    private label = "log"
  ) {
    if (file) mkdirSync(dirname(file), { recursive: true });
  }

  write(entry: T): void {
    if (!this.file) return;
    try {
      if (existsSync(this.file) && statSync(this.file).size > this.maxBytes) renameSync(this.file, `${this.file}.1`);
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    } catch (e) {
      console.error(`[${this.label}] couldn't write ${this.file}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

/** The last `n` entries of a JSONL log (the rolled-over `.1` first, when needed). Bad lines are skipped. */
export function readJsonl<T = Record<string, unknown>>(file: string, n = 50): T[] {
  const lines: string[] = [];
  for (const f of [`${file}.1`, file]) {
    if (existsSync(f)) lines.push(...readFileSync(f, "utf8").split("\n").filter(Boolean));
  }
  const out: T[] = [];
  for (const line of lines.slice(-n)) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A line cut by a crash.
    }
  }
  return out;
}
