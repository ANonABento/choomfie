/**
 * Late results — after an answer that started a background job, poll for the
 * results and post them when they land. In memory: a worker restart drops the
 * watch (the results are still in the site's own chat).
 */

import { errorMessage } from "@choomfie/shared";
import type { LateResult } from "./adapter.ts";

export const WATCH_EVERY_MS = 60_000;
export const WATCH_FOR_MS = 3 * 60 * 60_000;

type Poll = (chatKey: string, ref: string, afterId: string, posted: Set<string>) => Promise<LateResult | null>;
type Post = (chatKey: string, result: LateResult) => Promise<void>;

interface Watch {
  ref: string;
  afterId: string;
  posted: Set<string>;
  until: number;
  timer: ReturnType<typeof setInterval>;
}

export class LateWatch {
  private watches = new Map<string, Watch>();

  constructor(
    private poll: Poll,
    private post: Post,
    private everyMs = WATCH_EVERY_MS,
    private forMs = WATCH_FOR_MS
  ) {}

  start(chatKey: string, ref: string, afterId: string) {
    const existing = this.watches.get(chatKey);
    if (existing && existing.ref === ref) {
      // Another job in the same chat: keep the older watermark so neither result is skipped.
      existing.until = Date.now() + this.forMs;
      return;
    }
    if (existing) this.stop(chatKey);
    const timer = setInterval(() => void this.tick(chatKey), this.everyMs);
    this.watches.set(chatKey, { ref, afterId, posted: new Set(), until: Date.now() + this.forMs, timer });
  }

  /** Messages a normal answer already delivered — never post them again. */
  delivered(chatKey: string, ids: string[]) {
    const w = this.watches.get(chatKey);
    if (w) for (const id of ids) w.posted.add(id);
  }

  watching(chatKey: string): boolean {
    return this.watches.has(chatKey);
  }

  stop(chatKey: string) {
    const w = this.watches.get(chatKey);
    if (w) clearInterval(w.timer);
    this.watches.delete(chatKey);
  }

  stopAll() {
    for (const key of [...this.watches.keys()]) this.stop(key);
  }

  /** One poll. Public so tests don't wait a minute. */
  async tick(chatKey: string) {
    const w = this.watches.get(chatKey);
    if (!w) return;
    if (Date.now() > w.until) {
      this.stop(chatKey);
      return;
    }
    try {
      const late = await this.poll(chatKey, w.ref, w.afterId, w.posted);
      if (!late || !late.ids.length) return;
      for (const id of late.ids) w.posted.add(id);
      if (late.text || late.choices?.length || late.approvals?.length) await this.post(chatKey, late);
      // Keep watching only if the results themselves kicked off more work.
      if (!late.more) this.stop(chatKey);
    } catch (e) {
      console.error(`[webbrain] late-result watch for ${chatKey}: ${errorMessage(e)}`);
    }
  }
}
