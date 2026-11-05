/**
 * Human-paced input.
 *
 * Instant `fill()` + Enter on every message, at machine-regular intervals, is
 * one of the easier automation tells. Short messages are typed with jittered
 * key timing; long or multi-line ones are pasted (people paste those too, and
 * Enter in most chat composers sends). Submits across all of a site's tabs are
 * spaced out, since it is one account sending them.
 */

import type { Human, Locator } from "../adapter.ts";

/** Typed key by key up to this length; pasted beyond it. */
export const TYPE_MAX_CHARS = 120;
/** Minimum gap between two submits to the same site, plus jitter. */
export const SUBMIT_SPACING_MS = 1_500;

export const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One per site: spaces out submits from every tab. */
export class Pacer {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private spacingMs = SUBMIT_SPACING_MS) {}

  /** Resolves when this caller may submit. Callers are served in order. */
  turn(): Promise<void> {
    const next = this.chain.then(async () => {
      const due = this.last + this.spacingMs + randomBetween(0, 800);
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
    });
    this.chain = next.catch(() => {});
    return next;
  }
}

export function shouldPaste(text: string): boolean {
  return text.length > TYPE_MAX_CHARS || /[\r\n]/.test(text);
}

export function createHuman(pacer: Pacer): Human {
  return {
    async type(target: Locator, text: string) {
      await target.click();
      await sleep(randomBetween(120, 350));
      if (shouldPaste(text)) await target.fill(text);
      else await target.pressSequentially(text, { delay: randomBetween(25, 70) });
    },
    async submit(submit) {
      await pacer.turn();
      await sleep(randomBetween(150, 450));
      await submit();
    },
    pause: async (minMs = 200, maxMs = 600) => {
      await sleep(randomBetween(minMs, maxMs));
    },
  };
}
