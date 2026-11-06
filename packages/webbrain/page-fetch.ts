/**
 * `fetch()` from inside the logged-in page, so the site's session cookie and
 * origin ride along. Reading a site's own JSON endpoints this way is far
 * sturdier than scraping rendered text.
 */

import type { Page } from "patchright";
import { LoginRequiredError, type SiteAdapter } from "./adapter.ts";

export interface PageFetchResult {
  status: number;
  json?: unknown;
  /** First 200 characters of an error response, for the message. */
  errorText?: string;
}

export async function pageFetch(
  page: Page,
  url: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {}
): Promise<PageFetchResult> {
  return (await page.evaluate(
    async ([u, i]: [string, typeof init]) => {
      const r = await fetch(u, { credentials: "include", ...i });
      if (!r.ok) return { status: r.status, errorText: (await r.text().catch(() => "")).slice(0, 200) };
      // Parse whatever came back: not every API labels its JSON.
      const body = await r.text();
      try {
        return { status: r.status, json: body ? JSON.parse(body) : undefined };
      } catch {
        return { status: r.status };
      }
    },
    [url, init] as [string, typeof init]
  )) as PageFetchResult;
}

/**
 * GET a file from inside the logged-in page, as bytes. Null when it fails or
 * is larger than `maxBytes` (checked before it crosses into Node) — a file is
 * an extra, never a reason to fail the answer it came with.
 */
export async function pageFetchBytes(page: Page, url: string, maxBytes: number): Promise<Uint8Array | null> {
  const b64 = (await page.evaluate(
    async ([u, max]: [string, number]) => {
      const r = await fetch(u, { credentials: "include" }).catch(() => null);
      if (!r?.ok) return null;
      const blob = await r.blob();
      if (blob.size > max) return null;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    },
    [url, maxBytes] as [string, number]
  )) as string | null;
  return b64 === null ? null : new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * `pageFetch` for an endpoint that must succeed: 401/403 means the site wants
 * a login (`LoginRequiredError`), any other failure throws with the status and
 * the start of the body. Returns the parsed JSON.
 */
export async function pageFetchOk(
  page: Page,
  url: string,
  site: Pick<SiteAdapter, "id" | "label">,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {}
): Promise<unknown> {
  const res = await pageFetch(page, url, init);
  if (res.status === 401 || res.status === 403) throw new LoginRequiredError(site);
  if (res.status >= 400) {
    throw new Error(`${site.label} ${res.status} for ${new URL(url).pathname}${res.errorText ? `: ${res.errorText}` : ""}`);
  }
  return res.json;
}
