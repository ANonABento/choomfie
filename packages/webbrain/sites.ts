/**
 * `webbrain sites` / `webbrain setup` — every web brain the plugins provide,
 * and whether its browser profile is logged in. The web-brain counterpart of
 * `apibrain keys`: a site has no key, it has a logged-in profile.
 *
 * Logged in or not is checked by opening the site's chat URL headless on its
 * profile: a logged-out profile gets sent somewhere else (a sign-in page). An
 * adapter whose site doesn't redirect can say for itself (`loggedIn`).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SiteAdapter, SiteTerms } from "./adapter.ts";
import { engineFor, launchContext, profileName } from "./engine/launch.ts";
import { profileInUse } from "./paths.ts";

export type SiteState = "logged-in" | "logged-out" | "never" | "busy" | "unknown";

export interface SiteStatus {
  id: string;
  label: string;
  state: SiteState;
  detail?: string;
  terms?: SiteTerms;
}

/**
 * Plugins that export a web-brain `adapter` (or a list, `adapters`: the `webbrains` plugin). Read from the source first (an
 * `adapter` export), so plugins that aren't web brains are never imported
 * (importing one can start things: voice, socials).
 */
export async function discoverAdapters(pluginsDir: string, load: (id: string) => Promise<unknown> = (id) => import(`@choomfie/${id}`)): Promise<SiteAdapter[]> {
  const found: SiteAdapter[] = [];
  for (const id of readdirSync(pluginsDir).sort()) {
    const index = join(pluginsDir, id, "index.ts");
    if (!existsSync(index)) continue;
    const source = readFileSync(index, "utf8");
    if (!/export\s*\{[^}]*\bas\s+adapters?\b|export\s*\{[^}]*\badapters?\b|export\s+(const|let)\s+adapters?\b/.test(source)) continue;
    try {
      const mod = (await load(id)) as { adapter?: SiteAdapter; adapters?: SiteAdapter[] };
      if (mod.adapter?.turn) found.push(mod.adapter);
      for (const a of mod.adapters ?? []) if (a?.turn) found.push(a);
    } catch (e) {
      console.error(`  (couldn't load @choomfie/${id}: ${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return found;
}

/** The profile folder, without creating it (unlike `profileDir`). */
function profilePath(dataDir: string, adapter: SiteAdapter): string {
  return join(dataDir, "webbrain", adapter.id, profileName(engineFor(dataDir, adapter)));
}

/** Has this site's profile ever been opened (a login, a recording)? No launch, nothing sent. */
export function hasProfile(dataDir: string, adapter: SiteAdapter): boolean {
  return existsSync(join(profilePath(dataDir, adapter), "Default"));
}

/** Where a logged-in profile lands: the chat URL's origin and first path segment. */
export function landedInChat(adapter: Pick<SiteAdapter, "chatUrl">, url: string): boolean {
  try {
    const want = new URL(adapter.chatUrl());
    const got = new URL(url);
    const first = (p: string) => p.split("/").filter(Boolean)[0] ?? "";
    return got.origin === want.origin && first(got.pathname) === first(want.pathname);
  } catch {
    return false;
  }
}

export async function siteStatus(dataDir: string, adapter: SiteAdapter, opts: { check?: boolean } = {}): Promise<SiteStatus> {
  const base = { id: adapter.id, label: adapter.label, ...(adapter.terms ? { terms: adapter.terms } : {}) };
  const dir = profilePath(dataDir, adapter);
  if (!existsSync(join(dir, "Default"))) return { ...base, state: "never" };
  if (profileInUse(dir)) return { ...base, state: "busy", detail: "the bot has it open (closes after ~10 min idle)" };
  if (opts.check === false) return { ...base, state: "unknown", detail: "not checked" };
  const context = await launchContext(dir, { headless: true, engine: engineFor(dataDir, adapter) });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    if (adapter.loggedIn) return { ...base, state: (await adapter.loggedIn(page)) ? "logged-in" : "logged-out" };
    await page.goto(adapter.chatUrl(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    // Sign-in redirects often happen in the page's script, after the first load.
    await page.waitForTimeout(3_000);
    return { ...base, state: landedInChat(adapter, page.url()) ? "logged-in" : "logged-out", detail: landedInChat(adapter, page.url()) ? undefined : `sent to ${new URL(page.url()).pathname}` };
  } catch (e) {
    return { ...base, state: "unknown", detail: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  } finally {
    await context.close().catch(() => {});
  }
}

const MARK: Record<SiteState, string> = { "logged-in": "✅", "logged-out": "⬜", never: "⬜", busy: "⏳", unknown: "❔" };
const SAID: Record<SiteState, string> = {
  "logged-in": "logged in",
  "logged-out": "logged out",
  never: "never logged in",
  busy: "in use",
  unknown: "couldn't tell",
};

export function formatStatus(s: SiteStatus): string {
  const line = `${MARK[s.state]} ${s.id.padEnd(11)} ${SAID[s.state]}${s.detail ? ` · ${s.detail}` : ""}`;
  return s.terms && s.terms.automation !== "allowed" ? `${line}\n${" ".repeat(14)}${termsWarning(s.terms)}` : line;
}

/** One line for a site whose terms ban (or may ban) automation. */
export function termsWarning(t: SiteTerms): string {
  const what = t.automation === "forbidden" ? "⚠️ its terms forbid bots" : "⚠️ its terms may not allow bots";
  return `${what} (checked ${t.checked}): spare account only, human pace${t.note ? ` · ${t.note}` : ""}`;
}

/** Sites that need a login, in order. A busy profile is skipped (it's in use, so it was working). */
export const needsLogin = (s: SiteStatus) => s.state === "logged-out" || s.state === "never";
