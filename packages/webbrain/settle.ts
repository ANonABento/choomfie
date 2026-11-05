/**
 * For sites without a JSON endpoint to poll: the answer is done when its text
 * has stopped changing for a while and the site no longer looks busy (its
 * "stop generating" button is gone, say).
 */

export interface SettleOptions {
  /** Unchanged for this long → done. Default 2s. */
  quietMs?: number;
  pollMs?: number;
  timeoutMs: number;
  /** Still generating? (e.g. a visible stop button). */
  isBusy?: () => Promise<boolean>;
  stopRequested?: () => boolean;
  /** Each poll, with elapsed ms and the text so far. */
  onTick?: (elapsedMs: number, text: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `read` until the text settles. Returns what's there when stopped. */
export async function waitForSettledText(read: () => Promise<string>, opts: SettleOptions): Promise<string> {
  const quietMs = opts.quietMs ?? 2_000;
  const pollMs = opts.pollMs ?? 500;
  const started = Date.now();
  let last = "";
  let changedAt = started;
  for (;;) {
    const text = (await read().catch(() => last)).trim();
    const now = Date.now();
    if (text !== last) {
      last = text;
      changedAt = now;
    }
    if (opts.stopRequested?.()) return last;
    const busy = opts.isBusy ? await opts.isBusy().catch(() => false) : false;
    if (last && !busy && now - changedAt >= quietMs) return last;
    opts.onTick?.(now - started, last);
    if (now - started > opts.timeoutMs) {
      throw new Error(`no settled answer after ${Math.round((now - started) / 1000)}s`);
    }
    await sleep(pollMs);
  }
}
