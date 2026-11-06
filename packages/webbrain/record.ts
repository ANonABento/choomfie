/**
 * `webbrain record <id> <url>` — capture what a site does when you send one
 * message, so an adapter can be written from it.
 *
 * Opens the site headed on `<id>`'s own profile (so signing in here is also
 * the login). You send one test message by hand; it records:
 *
 *   network.jsonl        every fetch/XHR/stream: method, URL, status, type,
 *                        request body and response body (both clipped).
 *                        No headers at all — cookies and tokens stay out.
 *   controls-*.json      inputs, editors and buttons with their placeholder,
 *                        aria-label, role and test id: selector material
 *   aria-*.txt           the page's accessibility snapshot
 *   urls.txt             main-frame URL changes (where the conversation id is)
 *   meta.json            timings: submit marked → answer marked
 *
 * `before` is captured when you press Enter with the chat ready, `after` when
 * you press Enter again once the answer has finished. Everything is written to
 * `<data>/webbrain/<id>/recording/` — the data dir, never the repo: it holds
 * your account's responses.
 */

import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page, Request, Response } from "patchright";
import { engineFor, launchContext } from "./engine/launch.ts";
import { profileDir, profileInUse, siteDir } from "./paths.ts";

const BODY_LIMIT = 20_000;
const REQUEST_BODY_LIMIT = 4_000;
const KINDS = new Set(["fetch", "xhr", "eventsource", "websocket"]);
const TEXTUAL = /json|text|javascript|event-stream|x-protobuf|grpc|ndjson/i;

export interface NetworkEntry {
  t: number;
  phase: "before-mark" | "exchange" | "after-mark";
  method: string;
  url: string;
  status?: number;
  type?: string;
  requestBody?: string;
  body?: string;
  bodyTruncated?: boolean;
}

/** Inputs and buttons worth writing selectors against. Runs in the page. */
function collectControls() {
  const els = Array.from(
    document.querySelectorAll<HTMLElement>('textarea, input, [contenteditable="true"], [role="textbox"], button, [role="button"]')
  );
  return els
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })
    .slice(0, 150)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") ?? undefined,
      role: el.getAttribute("role") ?? undefined,
      placeholder: el.getAttribute("placeholder") ?? el.getAttribute("data-placeholder") ?? undefined,
      ariaLabel: el.getAttribute("aria-label") ?? undefined,
      testId: el.getAttribute("data-testid") ?? el.getAttribute("data-test-id") ?? undefined,
      text: (el.innerText ?? "").trim().slice(0, 60) || undefined,
      disabled: (el as HTMLButtonElement).disabled || undefined,
    }));
}

/** Clip a body and say whether it was clipped. */
export function clip(text: string, limit: number): { text: string; truncated: boolean } {
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false };
}

async function snapshot(page: Page, dir: string, label: "before" | "after") {
  const controls = await page.evaluate(collectControls).catch(() => []);
  writeFileSync(join(dir, `controls-${label}.json`), JSON.stringify(controls, null, 2));
  const aria = await page.locator("body").ariaSnapshot().catch((e: unknown) => `(aria snapshot failed: ${String(e)})`);
  writeFileSync(join(dir, `aria-${label}.txt`), aria);
}

async function waitForEnter(prompt: string): Promise<void> {
  process.stderr.write(`${prompt}\n> `);
  for await (const _line of console) return;
}

export async function record(dataDir: string, id: string, url: string): Promise<string> {
  // No adapter yet, so only config.json can pick the engine.
  const engine = engineFor(dataDir, { id });
  const profile = profileDir(dataDir, id, engine);
  if (profileInUse(profile)) throw new Error(`${id}'s profile is open in another browser; close it (or wait for Choomfie to go idle) first.`);
  const dir = join(siteDir(dataDir, id), "recording");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const net = join(dir, "network.jsonl");
  writeFileSync(net, "");

  const context: BrowserContext = await launchContext(profile, { headless: false, engine });
  const page = context.pages()[0] ?? (await context.newPage());
  const t0 = Date.now();
  let phase: NetworkEntry["phase"] = "before-mark";
  const marks: Record<string, number> = {};
  const urls: string[] = [];

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) urls.push(`${Date.now() - t0}ms ${frame.url()}`);
  });
  context.on("response", async (res: Response) => {
    const req: Request = res.request();
    if (!KINDS.has(req.resourceType())) return;
    const type = res.headers()["content-type"];
    const entry: NetworkEntry = { t: Date.now() - t0, phase, method: req.method(), url: req.url(), status: res.status(), type };
    const post = req.postData();
    if (post) entry.requestBody = clip(post, REQUEST_BODY_LIMIT).text;
    if (type && TEXTUAL.test(type)) {
      try {
        const c = clip(await res.text(), BODY_LIMIT);
        entry.body = c.text;
        if (c.truncated) entry.bodyTruncated = true;
      } catch {
        // Streams that never finish, or a body the page already consumed.
      }
    }
    appendFileSync(net, `${JSON.stringify(entry)}\n`);
  });

  await page.goto(url);
  await waitForEnter("Sign in if needed and open a fresh chat. When the message box is ready, press Enter here.");
  marks.ready = Date.now() - t0;
  await snapshot(page, dir, "before");
  phase = "exchange";
  await waitForEnter('Now send exactly: Reply with exactly: pong\nWhen the whole answer has appeared, press Enter here.');
  marks.answered = Date.now() - t0;
  await snapshot(page, dir, "after");
  phase = "after-mark";
  await page.waitForTimeout(1500);

  writeFileSync(join(dir, "urls.txt"), urls.join("\n"));
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ id, url, recordedAt: new Date().toISOString(), marks }, null, 2));
  await context.close();
  return dir;
}
