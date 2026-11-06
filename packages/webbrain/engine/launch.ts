/**
 * Starting a site's browser.
 *
 * Patchright (a Playwright fork that closes the CDP leaks bot checks look for)
 * on the installed Google Chrome, which is what Patchright recommends; bundled
 * Chromium only if Chrome isn't installed. Each site gets its own persistent
 * profile, never the user's everyday Chrome profile.
 *
 * Consistency beats randomness for a logged-in account: no fingerprint
 * rotation, a real window size (`viewport: null`), and the same locale and
 * timezone every launch.
 */

import { chromium, type BrowserContext } from "patchright";

export type EngineName = "patchright";

export interface LaunchOptions {
  headless: boolean;
  engine?: EngineName;
}

export async function launchContext(profileDir: string, opts: LaunchOptions): Promise<BrowserContext> {
  const base = {
    headless: opts.headless,
    viewport: null,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
  } as const;
  try {
    return await chromium.launchPersistentContext(profileDir, { ...base, channel: "chrome" });
  } catch {
    return await chromium.launchPersistentContext(profileDir, base);
  }
}
