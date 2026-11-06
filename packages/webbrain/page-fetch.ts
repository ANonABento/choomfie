/**
 * `fetch()` from inside the logged-in page, so the site's session cookie and
 * origin ride along. Reading a site's own JSON endpoints this way is far
 * sturdier than scraping rendered text.
 */

import type { Page } from "patchright";

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
