/**
 * Gemini (gemini.google.com) as a web-brain adapter. Written from a
 * `webbrain record` capture (Nov 25, 2026).
 *
 * The send goes over a streaming call the recorder doesn't capture, so the
 * answer is read from the page: each reply is a `<model-response>` element,
 * its text in `<message-content>`, done once the text stops changing and the
 * stop button is gone. Images it makes come back as attachments.
 *
 * Attachments go in through "Upload and tools" (its hidden file inputs). No
 * `/model`: on a free account every model in the picker but Auto (Hydrogen,
 * Neon, Carbon) opens an upgrade dialog (checked Nov 25, 2026). The owner's
 * messages may run commands on this Mac (local tools: a code block starting
 * `#!run`).
 */

import {
  LayoutChangedError,
  LoginRequiredError,
  QuotaReachedError,
  pageFetchBytes,
  parseResetAt,
  waitForSettledText,
  type Page,
  type SiteAdapter,
} from "@choomfie/webbrain";
import type { BrainFile } from "@choomfie/shared";

const ORIGIN = "https://gemini.google.com";
/** `gemini` is taken by the Gemini API provider (`/brain gemini`). */
const ID = { id: "gemini-web", label: "Gemini web" };

/** From controls-after.json / aria-after.txt and the page's own elements. */
const SELECTORS = {
  composer: "[aria-label='Enter a prompt for Gemini'][contenteditable='true']",
  answers: "model-response",
  answerText: "message-content",
  // Not in the recording (it was taken after the answer): Gemini's stop button while it writes.
  busy: "button[aria-label='Stop response'], button[aria-label*='Stop generating']",
  upload: "button[aria-label='Upload and tools']",
  /** Only on a signed-in page: the account menu link. Signed out, Gemini still answers, without history. */
  account: "a[href*='accounts.google.com/SignOutOptions']",
};

/** /app/864a426af09bb048 */
const CONVERSATION_RE = /\/app\/([0-9a-f]{8,})/;

/**
 * The words Gemini uses when a free allowance is spent. Not seen yet (TODO:
 * confirm the wording when it happens); kept narrow, and only checked on a
 * short answer, so a reply *about* limits isn't mistaken for one.
 */
const QUOTA_RE = /you(?:'ve| have) reached (?:your|the) (?:daily |usage )?limit|limit (?:resets|will reset)|try again (?:tomorrow|later)|out of (?:free )?(?:uses|generations)/i;

const MAX_IMAGE_BYTES = 9 * 1024 * 1024;

/** Wait out (or Escape) any open menu's backdrop, which swallows clicks. */
async function closeOverlays(page: Page): Promise<void> {
  const backdrop = page.locator(".cdk-overlay-backdrop-showing");
  for (let i = 0; i < 3 && (await backdrop.count()); i++) {
    await page.waitForTimeout(400);
    if (await backdrop.count()) await page.keyboard.press("Escape").catch(() => {});
  }
}

/**
 * Attach files: opening "Upload and tools" puts the page's hidden file inputs
 * in place, one for images and video (`image/*,video/*`) and one for
 * documents and code. Each file goes into the input that takes it, then a
 * preview chip for it shows in the composer.
 */
async function attach(page: Page, files: string[]): Promise<void> {
  if (!files.length) return;
  await page.locator(SELECTORS.upload).first().click();
  const inputs = page.locator("input[type=file]");
  await inputs.first().waitFor({ state: "attached", timeout: 15_000 }).catch(() => {
    throw new LayoutChangedError(ID, "no file upload in the Upload menu");
  });
  const accepts = await inputs.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).accept));
  const media = accepts.findIndex((a) => a.startsWith("image/"));
  const docs = accepts.findIndex((a) => !a.startsWith("image/"));
  const isMedia = (f: string) => /\.(png|jpe?g|gif|webp|heic|heif|bmp|mp4|mov|webm|mkv|avi)$/i.test(f);
  const groups: [number, string[]][] = [
    [media === -1 ? docs : media, files.filter(isMedia)],
    [docs === -1 ? media : docs, files.filter((f) => !isMedia(f))],
  ];
  for (const [i, group] of groups) if (group.length && i !== -1) await inputs.nth(i).setInputFiles(group);
  await closeOverlays(page);
  // One preview chip per file ("TXT note": the name shows without its extension).
  await page
    .waitForFunction((n: number) => document.querySelectorAll("uploader-file-preview").length >= n, files.length, { timeout: 60_000 })
    .catch(() => {
      throw new LayoutChangedError(ID, "the attachments never showed in the message box");
    });
  // Previews appear before the upload finishes; give it a moment.
  await page.waitForTimeout(2_000);
}

async function signedIn(page: Page): Promise<boolean> {
  return (await page.locator(SELECTORS.account).count()) > 0;
}

/**
 * The answer's code blocks with their language: innerText drops the ```
 * fences, and local tools look for blocks starting `#!run`. A block is
 * `<code-block>`; Gemini shows an unknown language as "Code snippet".
 */
async function codeBlocks(page: Page, index: number): Promise<{ lang?: string; code: string }[]> {
  return page.evaluate(
    ([sel, i]) => {
      const answer = document.querySelectorAll(sel as string)[i as number];
      if (!answer) return [];
      return [...answer.querySelectorAll("code-block, pre")]
        .filter((el) => el.tagName.toLowerCase() === "code-block" || !el.closest("code-block"))
        .map((el) => {
          const code = el.querySelector("code") ?? el;
          const header = el.querySelector(".code-block-decoration, [class*='decoration'], [class*='header']");
          const label = header?.querySelector("span")?.textContent ?? header?.textContent ?? "";
          const cls = /language-([\w-]+)/.exec(code.className)?.[1];
          const lang = (cls ?? label).trim().split(/\s+/)[0]?.toLowerCase();
          return { lang: lang || undefined, code: (code as HTMLElement).innerText };
        });
    },
    [SELECTORS.answers, index] as [string, number]
  );
}

/** Images in the answer that aren't icons: Gemini's generated pictures. */
async function answerImages(page: Page, index: number): Promise<BrainFile[]> {
  const srcs = await page.evaluate(
    ([sel, i]) => {
      const answer = document.querySelectorAll(sel as string)[i as number];
      if (!answer) return [];
      return [...answer.querySelectorAll("img")]
        .filter((img) => img.naturalWidth >= 256 && img.naturalHeight >= 256 && /^(https:|blob:|data:)/.test(img.src))
        .map((img) => img.src);
    },
    [SELECTORS.answers, index] as [string, number]
  );
  const files: BrainFile[] = [];
  for (const [n, src] of [...new Set(srcs)].entries()) {
    const data = await pageFetchBytes(page, src, MAX_IMAGE_BYTES).catch(() => null);
    if (data) files.push({ name: `gemini-${n + 1}.png`, data });
  }
  return files;
}

export const geminiAdapter: SiteAdapter = {
  ...ID,
  loginUrl: `${ORIGIN}/app`,
  chatUrl: (ref) => (ref ? `${ORIGIN}/app/${ref}` : `${ORIGIN}/app`),
  // A signed-out profile is not redirected: Gemini shows its guest page at /app.
  async loggedIn(page) {
    await page.goto(`${ORIGIN}/app`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.locator(SELECTORS.composer).first().waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
    return signedIn(page);
  },
  // Gemini can check this Mac and commit/push for the owner (```run blocks, local-tools.ts).
  localTools: true,
  terms: {
    automation: "forbidden",
    checked: "2026-11-25",
    note: "Google's Terms of Service bar automated access to its services",
  },

  async turn(page, { text, files: attachments }, t) {
    await page.goto(this.chatUrl(t.ref), { waitUntil: "domcontentloaded" });
    const composer = page.locator(SELECTORS.composer).first();
    try {
      await composer.waitFor({ state: "visible", timeout: 30_000 });
    } catch {
      if (!page.url().startsWith(ORIGIN)) throw new LoginRequiredError(ID);
      throw new LayoutChangedError(ID, "the message box never appeared");
    }
    if (!(await signedIn(page))) throw new LoginRequiredError(ID);

    const answers = page.locator(SELECTORS.answers);
    const before = await answers.count();

    await attach(page, attachments);
    await t.human.type(composer, text);
    await t.human.submit(() => composer.press("Enter"));

    let ref = t.ref;
    if (!ref) {
      await page.waitForURL(CONVERSATION_RE, { timeout: 60_000 });
      ref = CONVERSATION_RE.exec(page.url())![1];
    }
    t.started(ref);

    await page.waitForFunction(([sel, n]) => document.querySelectorAll(sel as string).length > (n as number), [SELECTORS.answers, before] as [string, number], {
      timeout: 90_000,
    });
    const index = before;
    const answer = answers.nth(index);
    const reply = await waitForSettledText(() => answer.locator(SELECTORS.answerText).first().innerText(), {
      timeoutMs: t.timeoutMs,
      quietMs: 3_000,
      isBusy: async () => (await page.locator(SELECTORS.busy).count()) > 0,
      stopRequested: t.stopRequested,
      onTick: (ms) => t.progress(`⏳ ${ID.label} is writing (${Math.round(ms / 1000)}s)`),
    });
    if (reply.length < 400 && QUOTA_RE.test(reply)) throw new QuotaReachedError(ID.label, parseResetAt(reply), reply);
    // An answer from an attachment ends with a chip naming it ("banana\nnote.txt"): drop it.
    const names = new Set(attachments.map((f) => f.split("/").pop()));
    const lines = reply.split("\n");
    while (lines.length > 1 && names.has(lines.at(-1)!.trim())) lines.pop();
    const tidy = lines.join("\n").trim();

    const files = await answerImages(page, index);
    const blocks = await codeBlocks(page, index).catch(() => []);
    return { text: tidy, ref, stopped: t.stopRequested(), ...(files.length ? { files } : {}), ...(blocks.length ? { codeBlocks: blocks } : {}) };
  },

  async stop(page) {
    const button = page.locator(SELECTORS.busy).first();
    if (!(await button.count())) return false;
    await button.click().catch(() => {});
    return true;
  },
};
