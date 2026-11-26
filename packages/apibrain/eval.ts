/**
 * `bun run apibrain eval <plugin>`: run each classifier over the plugin's
 * labelled messages and say how good it is — accuracy, what it got wrong,
 * how long it took, and whether its confidence means anything (accuracy of
 * the answers it was sure about vs the ones it wasn't).
 */

import type { Classification, Classifier } from "./classifier.ts";

export interface LabelledCase {
  text: string;
  bucket: string;
  /** A second answer that's also fine. */
  alt?: string;
  recent?: { role: "user" | "assistant"; content: string }[];
}

export interface CaseResult {
  case: LabelledCase;
  got?: Classification;
  error?: string;
  ms: number;
}

export interface EvalReport {
  name: string;
  results: CaseResult[];
  /** Exactly the label. */
  exact: number;
  /** The label or its `alt`. */
  ok: number;
  errors: number;
  medianMs: number;
  p90Ms: number;
  /** Per threshold: how many answers were at least that sure, and how many of those were ok. */
  calibration: { at: number; n: number; ok: number }[];
  /** Which stage answered (pipeline): by → count. */
  by: Record<string, number>;
}

export const isOk = (r: CaseResult) => !!r.got && (r.got.bucket === r.case.bucket || r.got.bucket === r.case.alt);

function percentile(sorted: number[], p: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
}

/** `paceMs`: wait between messages, so a rate-limited model isn't measured on its 429s. */
export async function evaluate(name: string, classifier: Classifier, cases: LabelledCase[], paceMs = 0): Promise<EvalReport> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    if (paceMs && results.length) await Bun.sleep(paceMs);
    const started = performance.now();
    try {
      const got = await classifier.classify({ text: c.text, hasImages: false, tokens: Math.ceil(c.text.length / 4), recent: c.recent ?? [] });
      results.push({ case: c, got, ms: performance.now() - started });
    } catch (e) {
      results.push({ case: c, error: e instanceof Error ? e.message : String(e), ms: performance.now() - started });
    }
  }
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const by: Record<string, number> = {};
  for (const r of results) if (r.got) by[r.got.by] = (by[r.got.by] ?? 0) + 1;
  return {
    name,
    results,
    exact: results.filter((r) => r.got?.bucket === r.case.bucket).length,
    ok: results.filter(isOk).length,
    errors: results.filter((r) => r.error).length,
    medianMs: percentile(ms, 0.5),
    p90Ms: percentile(ms, 0.9),
    calibration: [0.5, 0.6, 0.7, 0.8, 0.9].map((at) => {
      const sure = results.filter((r) => r.got && r.got.confidence >= at);
      return { at, n: sure.length, ok: sure.filter(isOk).length };
    }),
    by,
  };
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "-");

export function formatReport(r: EvalReport, verbose = false): string[] {
  const n = r.results.length;
  const lines = [
    `${r.name}: ${r.ok}/${n} ok (${pct(r.ok, n)}), ${r.exact} exact${r.errors ? `, ${r.errors} errors` : ""} · median ${r.medianMs.toFixed(0)} ms, p90 ${r.p90Ms.toFixed(0)} ms`,
    `  sure ≥   ${r.calibration.map((c) => `${c.at.toFixed(1)}: ${c.ok}/${c.n} ${pct(c.ok, c.n)}`.padEnd(18)).join("")}`,
  ];
  if (Object.keys(r.by).length > 1) lines.push(`  answered by ${Object.entries(r.by).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  for (const x of r.results) {
    if (isOk(x) && !verbose) continue;
    const mark = isOk(x) ? "✓" : "✗";
    const got = x.got ? `${x.got.bucket} ${x.got.confidence.toFixed(2)} (${x.got.by}${verbose ? `: ${x.got.reason}` : ""})` : `error: ${x.error}`;
    lines.push(`  ${mark} want ${x.case.bucket}${x.case.alt ? `/${x.case.alt}` : ""}, got ${got} — “${x.case.text.slice(0, 70)}”`);
  }
  return lines;
}
