/**
 * Starting a site's browser, on one of two engines.
 *
 * - `patchright` (default): a Playwright fork that closes the CDP leaks bot
 *   checks look for, on the installed Google Chrome (bundled Chromium only if
 *   Chrome isn't installed).
 * - `cloak`: CloakBrowser, a Chromium with fingerprint patches in its source.
 *   Needs a license key (free with an email, one browser at a time):
 *   `npx cloakbrowser login`. Its binary downloads on first launch.
 *
 * Pick per site in config.json: `"webbrain": { "<id>": { "engine": "cloak" } }`,
 * else the adapter's `engine`, else patchright. Each engine keeps its own
 * profile — a profile doesn't move cleanly between browser builds, so
 * switching engines means logging in once more.
 *
 * Consistency beats randomness for a logged-in account: no fingerprint
 * rotation, a real window size (`viewport: null`), and the same locale and
 * timezone every launch.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext } from "patchright";

export const ENGINES = ["patchright", "cloak"] as const;
export type EngineName = (typeof ENGINES)[number];

export interface LaunchOptions {
  headless: boolean;
  engine?: EngineName;
}

export function isEngine(v: unknown): v is EngineName {
  return ENGINES.includes(v as EngineName);
}

/** The engine a site runs on: config.json, then the adapter's default, then patchright. */
export function engineFor(dataDir: string, site: { id: string; engine?: EngineName }): EngineName {
  try {
    const cfg = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf-8"));
    const chosen = cfg?.webbrain?.[site.id]?.engine;
    if (isEngine(chosen)) return chosen;
  } catch {
    // No config yet.
  }
  return site.engine ?? "patchright";
}

/** Profile folder name for an engine (patchright keeps the original `profile`). */
export const profileName = (engine: EngineName = "patchright") => (engine === "patchright" ? "profile" : `profile-${engine}`);

export async function launchContext(profileDir: string, opts: LaunchOptions): Promise<BrowserContext> {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const timezoneId = Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (opts.engine === "cloak") {
    let cloak: typeof import("cloakbrowser");
    try {
      cloak = await import("cloakbrowser");
    } catch (e) {
      throw new Error(`cloak engine: cloakbrowser isn't installed (${e instanceof Error ? e.message : e})`);
    }
    try {
      // Same Playwright API; typed against playwright-core rather than patchright.
      return (await cloak.launchPersistentContext({
        userDataDir: profileDir,
        headless: opts.headless,
        viewport: null,
        locale,
        timezoneId,
      })) as unknown as BrowserContext;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/licen[cs]e|key/i.test(msg)) {
        throw new Error(`cloak engine needs a license key — run \`npx cloakbrowser login\` (free with an email). ${msg}`);
      }
      throw e;
    }
  }

  const base = { headless: opts.headless, viewport: null, locale, timezoneId };
  const launch = async (extra: { userAgent?: string } = {}) => {
    try {
      return await chromium.launchPersistentContext(profileDir, { ...base, ...extra, channel: "chrome" });
    } catch {
      return await chromium.launchPersistentContext(profileDir, { ...base, ...extra });
    }
  };
  if (!opts.headless) return launch();

  // Headless Chrome says so in its user agent ("HeadlessChrome/156…") — the
  // first thing a bot check reads. Learn the real one once, then relaunch
  // with "Chrome" in its place. (Client-hint brands already say Google Chrome.)
  if (headlessFixedUa === undefined) {
    const probe = await launch();
    try {
      const page = probe.pages()[0] ?? (await probe.newPage());
      const ua = await page.evaluate(() => navigator.userAgent);
      headlessFixedUa = /HeadlessChrome/.test(ua) ? ua.replace("HeadlessChrome", "Chrome") : null;
    } finally {
      await probe.close().catch(() => {});
    }
  }
  return launch(headlessFixedUa ? { userAgent: headlessFixedUa } : {});
}

/** Per process: the headless user agent with "Headless" removed, or null if it never had it. */
let headlessFixedUa: string | null | undefined;
