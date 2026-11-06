/**
 * `webbrain doctor <id> --detect` — how botty does this engine look?
 *
 * Launches the site's engine (or `--engine`) on a throwaway profile — never the
 * logged-in one — and reports two things:
 *
 * - our own probes for the usual tells: `navigator.webdriver`, "Headless" in the
 *   user agent, a software (SwiftShader) GPU, no plugins, a zero-size outer
 *   window, user agent vs client hints disagreeing, permissions that
 *   contradict each other, a missing `window.chrome`;
 * - bot.sannysoft.com's own check table (rows it marks failed).
 *
 * Nothing is sent anywhere but that one public test page.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchContext, type EngineName } from "./engine/launch.ts";

export const SANNYSOFT = "https://bot.sannysoft.com/";

export interface DetectRow {
  check: string;
  value: string;
  ok: boolean;
}

export interface DetectReport {
  engine: EngineName;
  headless: boolean;
  rows: DetectRow[];
  /** Rows bot.sannysoft.com marked failed (null if the page didn't load). */
  sannysoftFailed: string[] | null;
}

/** Runs in the page. Plain values only — no closures over Node. */
async function probe() {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string; brands?: { brand: string }[] } };
  let gpu = "";
  try {
    const gl = document.createElement("canvas").getContext("webgl") as WebGLRenderingContext | null;
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    gpu = gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "";
  } catch {}
  let permissionsConsistent = true;
  try {
    const q = await navigator.permissions.query({ name: "notifications" as PermissionName });
    // The classic headless tell: Notification says denied while the query says prompt.
    permissionsConsistent = !(Notification.permission === "denied" && q.state === "prompt");
  } catch {}
  return {
    webdriver: nav.webdriver === true,
    userAgent: nav.userAgent,
    platform: String(nav.platform),
    chPlatform: nav.userAgentData?.platform ?? null,
    chBrands: (nav.userAgentData?.brands ?? []).map((b) => b.brand).join(", "),
    plugins: nav.plugins.length,
    languages: nav.languages.join(","),
    hasChrome: typeof (window as unknown as { chrome?: unknown }).chrome === "object",
    outer: `${window.outerWidth}x${window.outerHeight}`,
    gpu,
    permissionsConsistent,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

type Probe = Awaited<ReturnType<typeof probe>>;

/** User agent platform family vs the client-hints platform. */
function platformsAgree(p: Probe): boolean {
  if (!p.chPlatform) return true;
  const ua = p.userAgent;
  const family = /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /Linux/.test(ua) ? "Linux" : "?";
  return family === "?" || family === p.chPlatform;
}

export function rowsFrom(p: Probe): DetectRow[] {
  return [
    { check: "navigator.webdriver", value: String(p.webdriver), ok: !p.webdriver },
    { check: "user agent", value: p.userAgent.replace(/^Mozilla\/5\.0 /, "").slice(0, 90), ok: !/Headless/i.test(p.userAgent) },
    { check: "UA platform vs client hints", value: `${p.platform} / ${p.chPlatform ?? "—"}`, ok: platformsAgree(p) },
    { check: "client-hint brands", value: p.chBrands || "—", ok: !/Headless/i.test(p.chBrands) },
    { check: "GPU", value: p.gpu || "(none)", ok: !!p.gpu && !/SwiftShader|llvmpipe/i.test(p.gpu) },
    { check: "plugins", value: String(p.plugins), ok: p.plugins > 0 },
    { check: "languages", value: p.languages || "(none)", ok: !!p.languages },
    { check: "window.chrome", value: String(p.hasChrome), ok: p.hasChrome },
    { check: "outer window", value: p.outer, ok: p.outer !== "0x0" },
    { check: "notification permission", value: p.permissionsConsistent ? "consistent" : "denied vs prompt", ok: p.permissionsConsistent },
    { check: "timezone", value: p.timezone, ok: true },
  ];
}

export async function detect(engine: EngineName, opts: { headless?: boolean; timeoutMs?: number } = {}): Promise<DetectReport> {
  const headless = opts.headless ?? true;
  const dir = mkdtempSync(join(tmpdir(), `webbrain-detect-${engine}-`));
  const context = await launchContext(dir, { headless, engine });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    let sannysoftFailed: string[] | null = null;
    try {
      // Its "load" never fires (a resource hangs); the table is built by then.
      await page.goto(SANNYSOFT, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs ?? 30_000 });
      await page.waitForTimeout(4000); // its async checks fill in after
      sannysoftFailed = await page.evaluate(() =>
        [...document.querySelectorAll("td.failed")].map((td) => {
          const row = td.closest("tr");
          return (row?.querySelector("td")?.textContent ?? td.textContent ?? "").trim().slice(0, 60);
        })
      );
    } catch {
      await page.goto("about:blank").catch(() => {});
    }
    const rows = rowsFrom((await page.evaluate(probe)) as Probe);
    return { engine, headless, rows, sannysoftFailed };
  } finally {
    await context.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

export function formatReport(r: DetectReport): string {
  const width = Math.max(...r.rows.map((x) => x.check.length));
  const lines = [`${r.engine} (${r.headless ? "headless" : "headed"})`];
  for (const row of r.rows) lines.push(`  ${row.ok ? "✅" : "❌"} ${row.check.padEnd(width)}  ${row.value}`);
  lines.push(
    r.sannysoftFailed === null
      ? "  ⚠️  bot.sannysoft.com didn't load"
      : r.sannysoftFailed.length
        ? `  ❌ bot.sannysoft.com failed: ${r.sannysoftFailed.join("; ")}`
        : "  ✅ bot.sannysoft.com: every check passed"
  );
  const bad = r.rows.filter((x) => !x.ok).length + (r.sannysoftFailed?.length ?? 0);
  lines.push(`  ${bad ? `${bad} tell(s)` : "no tells found"}`);
  return lines.join("\n");
}
