/**
 * Which listed models actually answer on this key — remembered on disk.
 *
 * A provider's `/models` lists everything it has, not what a free key may
 * use: Gemini lists Pro models whose free quota is zero. Ranking by name
 * alone would put those first. So each listed model is tried once with a
 * tiny request (`ApiMember.probe`), and every real call updates the record:
 * a model that answered is known good; one refused as not free, or gone, is
 * skipped until it's due a re-check. A probe that came back busy,
 * rate-limited or timed out is a verdict-less `pending` record: the model
 * isn't refused, but it isn't probed again for `PENDING_RECHECK_MS` — so a
 * restart doesn't spend another call on a model that said "high demand" an
 * hour ago.
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
  /** Times someone asked for a bigger model to redo its answer (Try a bigger model), and the last time. */
  redone?: number;
  redoneAt?: number;
  /** Tried, but the answer said nothing about the model (busy, rate-limited, timed out). Not a refusal. */
  pending?: boolean;
  /** A benched key (`key:<provider>:<fingerprint>`): out until then, across restarts. */
  until?: number;
}

/** A refused model is tried again after this long (plans and free tiers change). */
export const RECHECK_MS = 7 * 24 * 3_600_000;
/** A redo counts against a model for this long after the last one. */
export const REDO_MEMORY_MS = 7 * 24 * 3_600_000;
/** A probe that got no verdict is tried again after this long. */
export const PENDING_RECHECK_MS = 6 * 3_600_000;

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
    return !!c && !c.ok && !c.pending && this.now() - c.at < RECHECK_MS;
  }

  /** Never tried, or a refusal that's due a re-check. */
  untested(unit: string): boolean {
    const c = this.checks.get(unit);
    if (!c) return true;
    if (c.pending) return this.now() - c.at >= PENDING_RECHECK_MS;
    return !c.ok && this.now() - c.at >= RECHECK_MS;
  }

  /** Never answered yet (no record, or only a verdict-less probe): ranked as untested. */
  unproven(unit: string): boolean {
    const c = this.checks.get(unit);
    return !c || !!c.pending;
  }

  /** A probe got no verdict: don't probe again for a while, and don't count it against the model. A real verdict is kept. */
  tried(unit: string, reason: string): void {
    const prev = this.checks.get(unit);
    if (prev && !prev.pending) return;
    this.checks.set(unit, { ok: false, pending: true, reason, at: this.now() });
    this.scheduleSave();
  }

  mark(unit: string, ok: boolean, reason?: string): void {
    const prev = this.checks.get(unit);
    if (ok && prev?.ok) return void (prev.at = this.now()); // nothing worth a write
    const traits = {
      ...(prev?.reasons !== undefined ? { reasons: prev.reasons } : {}),
      ...(prev?.noEffort ? { noEffort: true } : {}),
      ...(prev?.redone ? { redone: prev.redone, redoneAt: prev.redoneAt } : {}),
    };
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

  /** Its answer was redone by a bigger model: evidence it wasn't good enough. Counted for `REDO_MEMORY_MS`. */
  redo(unit: string): void {
    const prev = this.checks.get(unit) ?? { ok: true, at: this.now() };
    const fresh = prev.redoneAt !== undefined && this.now() - prev.redoneAt < REDO_MEMORY_MS;
    this.checks.set(unit, { ...prev, redone: (fresh ? (prev.redone ?? 0) : 0) + 1, redoneAt: this.now() });
    this.scheduleSave();
  }

  /** Redos still counted against this model (0 once a week has passed since the last). */
  redos(unit: string): number {
    const c = this.checks.get(unit);
    return c?.redone && c.redoneAt !== undefined && this.now() - c.redoneAt < REDO_MEMORY_MS ? c.redone : 0;
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
