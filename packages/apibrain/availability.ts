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
  /** Seen thinking before it answers (hidden tokens on every call). */
  reasons?: boolean;
  /** Refused a `reasoning_effort` field. */
  noEffort?: boolean;
  /** A benched key (`key:<provider>:<fingerprint>`): out until then, across restarts. */
  until?: number;
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
    const traits = { ...(prev?.reasons !== undefined ? { reasons: prev.reasons } : {}), ...(prev?.noEffort ? { noEffort: true } : {}) };
    this.checks.set(unit, { ok, ...(reason ? { reason } : {}), at: this.now(), ...traits });
    this.scheduleSave();
  }

  /** Record how a model behaves (thinks first, refuses `reasoning_effort`), kept across restarts. */
  note(unit: string, traits: Pick<ModelCheck, "reasons" | "noEffort">): void {
    const prev = this.checks.get(unit) ?? { ok: true, at: this.now() };
    if (Object.entries(traits).every(([k, v]) => prev[k as keyof ModelCheck] === v)) return;
    this.checks.set(unit, { ...prev, ...traits });
    this.scheduleSave();
  }

  /**
   * Bench a key until a time, kept on disk so a restart doesn't spend a call
   * rediscovering a key that wants a card or was rejected. The unit is a
   * fingerprint of the key, never the key.
   */
  bench(unit: string, until: number, reason: string): void {
    this.checks.set(unit, { ok: false, reason, at: this.now(), until });
    this.scheduleSave();
  }

  /** How long a benched key has left, and why; undefined once it's due back. */
  benched(unit: string): { ms: number; reason: string } | undefined {
    const c = this.checks.get(unit);
    if (!c?.until || c.until <= this.now()) return undefined;
    return { ms: c.until - this.now(), reason: c.reason ?? "benched" };
  }

  /** The key answered: forget its bench. */
  unbench(unit: string): void {
    if (this.checks.get(unit)?.until === undefined) return;
    this.checks.delete(unit);
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
