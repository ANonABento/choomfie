/**
 * Which listed models actually answer on this key — remembered on disk.
 *
 * A provider's `/models` lists everything it has, not what a free key may
 * use: Gemini lists Pro models whose free quota is zero. Ranking by name
 * alone would put those first. So each listed model is tried once with a
 * tiny request (`ApiMember.probe`), and every real call updates the record:
 * a model that answered is known good; one refused as not free, or gone, is
 * skipped until it's due a re-check. Busy or rate-limited says nothing and
 * isn't recorded.
 */

import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomicSync } from "@choomfie/shared";

export interface ModelCheck {
  ok: boolean;
  /** Why it isn't usable. */
  reason?: string;
  at: number;
}

/** A refused model is tried again after this long (plans and free tiers change). */
export const RECHECK_MS = 7 * 24 * 3_600_000;

export class Availability {
  private checks = new Map<string, ModelCheck>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private file: string | null = null,
    private now: () => number = Date.now
  ) {
    if (file && existsSync(file)) {
      try {
        for (const [unit, c] of Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, ModelCheck>)) {
          if (c && typeof c.ok === "boolean" && typeof c.at === "number") this.checks.set(unit, c);
        }
      } catch (e) {
        console.error(`[apibrain] couldn't read ${file}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  get(unit: string): ModelCheck | undefined {
    return this.checks.get(unit);
  }

  /** Known refused, and not yet due a re-check. */
  refused(unit: string): boolean {
    const c = this.checks.get(unit);
    return !!c && !c.ok && this.now() - c.at < RECHECK_MS;
  }

  /** Never tried, or a refusal that's due a re-check. */
  untested(unit: string): boolean {
    const c = this.checks.get(unit);
    return !c || (!c.ok && this.now() - c.at >= RECHECK_MS);
  }

  mark(unit: string, ok: boolean, reason?: string): void {
    const prev = this.checks.get(unit);
    if (ok && prev?.ok) return void (prev.at = this.now()); // nothing worth a write
    this.checks.set(unit, { ok, ...(reason ? { reason } : {}), at: this.now() });
    this.scheduleSave();
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.file) return;
    try {
      writeJsonAtomicSync(this.file, Object.fromEntries(this.checks));
    } catch (e) {
      console.error(`[apibrain] couldn't save model checks: ${e instanceof Error ? e.message : e}`);
    }
  }

  private scheduleSave(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 2_000);
    this.saveTimer.unref?.();
  }
}
