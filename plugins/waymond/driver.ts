/**
 * Waymond driver — one headless browser, logged in as the owner, that sends a
 * message through Ambition's own composer and reads the answer from the JSON
 * endpoints the web app itself polls.
 *
 * Sending goes through the UI (the request body of `POST /api/waymond/chat`
 * is unknown and the UI is the path a real user takes). Reading goes through
 * `/turn` + `/messages`, which is far sturdier than scraping rendered text.
 *
 * One page, one request at a time across all chats: it is one logged-in user.
 */

import { basename } from "node:path";
import { chromium, type BrowserContext, type Page } from "patchright";
import { errorMessage } from "@choomfie/shared";
import {
  APP_ORIGIN,
  CONVERSATION_PATH_RE,
  chatUrl,
  hasWaitingCard,
  answerState,
  messagesUrl,
  parseMessages,
  parseTurn,
  stopUrl,
  turnUrl,
  waitingCardsUrl,
  type ChatMessage,
  type TurnState,
} from "./api.ts";

export class LoginRequiredError extends Error {
  constructor() {
    super("Waymond isn't logged in — on the Mac running Choomfie, run `bun run waymond:login`.");
  }
}

export interface DriverHooks {
  /** Periodic progress while a turn runs (intent + running tools). */
  onProgress?(turn: TurnState, elapsedMs: number): void;
  /** Waymond parked an approval card for this conversation. */
  onApprovalNeeded?(conversationId: string): void;
}

export interface DriverOptions {
  profileDir: string;
  headless?: boolean;
  /** Whole-turn timeout. Real tasks can run for minutes. */
  turnTimeoutMs?: number;
  pollMs?: number;
  /** Close the browser after this long idle. */
  idleCloseMs?: number;
}

const COMPOSER_PLACEHOLDER = "Ask Waymond...";

export async function launchWaymondContext(profileDir: string, headless: boolean): Promise<BrowserContext> {
  const opts = { headless, viewport: null } as const;
  try {
    // Real Chrome is what Patchright recommends for avoiding bot checks. Its
    // own profile dir, so it never touches the user's everyday Chrome profile.
    return await chromium.launchPersistentContext(profileDir, { ...opts, channel: "chrome" });
  } catch {
    return await chromium.launchPersistentContext(profileDir, opts);
  }
}

export interface SendResult {
  reply: string;
  /** Quick replies Waymond offered; sending one continues the conversation. */
  options: string[];
  conversationId: string;
  /** The turn ended because /brain stop was used. */
  stopped: boolean;
  /** Waymond handed work to a background job; results arrive later. */
  background: boolean;
  /** Watermark for collecting those late results. */
  lastMessageId?: string;
  /** Waymond messages this answer delivered (so a watcher never re-posts them). */
  messageIds: string[];
}

export class WaymondDriver {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly turnTimeoutMs: number;
  private readonly pollMs: number;
  private readonly idleCloseMs: number;
  /** Conversation the in-flight send is waiting on, if any. */
  private activeConversation: string | null = null;
  private stopRequested = false;

  constructor(private opts: DriverOptions) {
    this.turnTimeoutMs = opts.turnTimeoutMs ?? 15 * 60_000;
    this.pollMs = opts.pollMs ?? 2_500;
    this.idleCloseMs = opts.idleCloseMs ?? 10 * 60_000;
  }

  /** Send `text` (and optional files) into `conversationId`, or a new chat. */
  send(
    text: string,
    conversationId: string | undefined,
    hooks: DriverHooks = {},
    files: string[] = []
  ): Promise<SendResult> {
    const run = this.lock.then(() => this.sendLocked(text, conversationId, hooks, files));
    this.lock = run.catch(() => {});
    return run;
  }

  /** Read the conversation's recent messages (queued behind any send in flight). */
  readMessages(conversationId: string): Promise<ChatMessage[]> {
    const run = this.lock.then(async () => {
      const page = await this.getPage();
      try {
        // fetch() needs the app origin for the session cookie and CORS.
        if (!page.url().startsWith(APP_ORIGIN)) await page.goto(`${APP_ORIGIN}/chat`, { waitUntil: "domcontentloaded" });
        return parseMessages(await this.getJson(page, messagesUrl(conversationId)));
      } finally {
        this.scheduleIdleClose();
      }
    });
    this.lock = run.catch(() => {});
    return run;
  }

  /**
   * Ask Waymond to stop the turn running in `conversationId`. Runs alongside
   * the in-flight send (it only issues one request on the same page); the send
   * then returns whatever Waymond had produced. False if nothing was running there.
   */
  async stop(conversationId: string): Promise<boolean> {
    if (!this.page || this.page.isClosed() || this.activeConversation !== conversationId) return false;
    this.stopRequested = true;
    const status = (await this.page.evaluate(async (u: string) => {
      const r = await fetch(u, { method: "POST", credentials: "include" });
      return r.status;
    }, stopUrl(conversationId))) as number;
    if (status === 401 || status === 403) throw new LoginRequiredError();
    if (status >= 400) throw new Error(`Ambition refused the stop (${status})`);
    return true;
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const ctx = this.context;
    this.context = null;
    this.page = null;
    await ctx?.close().catch(() => {});
  }

  private async getPage(): Promise<Page> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.page && !this.page.isClosed()) return this.page;
    this.context ??= await launchWaymondContext(this.opts.profileDir, this.opts.headless ?? true);
    this.context.on("close", () => {
      this.context = null;
      this.page = null;
    });
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    return this.page;
  }

  private scheduleIdleClose() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.close(), this.idleCloseMs);
  }

  /** fetch() from inside the logged-in page, so the session cookie rides along. */
  private async getJson(page: Page, url: string): Promise<unknown> {
    const res = (await page.evaluate(async (u: string) => {
      const r = await fetch(u, { credentials: "include" });
      if (!r.ok) return { __status: r.status };
      return { __json: await r.json() };
    }, url)) as { __status?: number; __json?: unknown };
    if (res.__status === 401 || res.__status === 403) throw new LoginRequiredError();
    if (res.__status) throw new Error(`Ambition API ${res.__status} for ${new URL(url).pathname}`);
    return res.__json;
  }

  private async sendLocked(
    text: string,
    conversationId: string | undefined,
    hooks: DriverHooks,
    files: string[]
  ): Promise<SendResult> {
    const page = await this.getPage();
    this.stopRequested = false;
    try {
      await page.goto(chatUrl(conversationId), { waitUntil: "domcontentloaded" });
      const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER).first();
      try {
        await composer.waitFor({ state: "visible", timeout: 30_000 });
      } catch {
        if (!page.url().startsWith(`${APP_ORIGIN}/chat`)) throw new LoginRequiredError();
        throw new Error("Waymond's message box never appeared (the page layout may have changed).");
      }

      let convId = conversationId;
      const baseline = new Set(
        convId ? parseMessages(await this.getJson(page, messagesUrl(convId))).map((m) => m.id) : []
      );

      await this.clearDraftAttachments(page);
      if (files.length) await this.attach(page, files);
      await composer.click();
      await composer.fill(text);
      await composer.press("Enter");

      if (!convId) {
        await page.waitForURL(CONVERSATION_PATH_RE, { timeout: 30_000 });
        convId = CONVERSATION_PATH_RE.exec(page.url())![1];
      }
      this.activeConversation = convId;

      const started = Date.now();
      let approvalNotified = false;
      let sawActive = false;
      let polls = 0;
      for (;;) {
        await page.waitForTimeout(this.pollMs);
        const turn = parseTurn(await this.getJson(page, turnUrl(convId)));
        sawActive ||= turn.active;
        if (!turn.active) {
          const messages = parseMessages(await this.getJson(page, messagesUrl(convId)));
          const state = answerState(messages, baseline, turn.active, sawActive);
          if (state.done || (this.stopRequested && !turn.active)) {
            return {
              reply: state.reply || (this.stopRequested ? "" : "(Waymond finished without a text reply)"),
              options: state.options,
              conversationId: convId,
              stopped: this.stopRequested,
              background: state.background,
              lastMessageId: state.lastMessageId,
              messageIds: state.messageIds,
            };
          }
        }
        const elapsed = Date.now() - started;
        hooks.onProgress?.(turn, elapsed);
        if (!approvalNotified && ++polls % 3 === 0) {
          if (hasWaitingCard(await this.getJson(page, waitingCardsUrl()), convId)) {
            approvalNotified = true;
            hooks.onApprovalNeeded?.(convId);
          }
        }
        if (elapsed > this.turnTimeoutMs) {
          throw new Error(`still working after ${Math.round(elapsed / 60_000)} min — follow it at ${chatUrl(convId)}`);
        }
      }
    } catch (e) {
      // A broken page shouldn't poison the next request.
      if (!(e instanceof LoginRequiredError)) await page.goto("about:blank").catch(() => {});
      throw e instanceof Error ? e : new Error(errorMessage(e));
    } finally {
      this.activeConversation = null;
      this.scheduleIdleClose();
    }
  }

  /**
   * The composer keeps attachments as a draft until the message is sent, and
   * the draft survives reloads — a send that failed after attaching would leak
   * its files into the next message. So every send starts by clearing it.
   * Scoped to the composer (the element holding both the message box and the
   * attach button), so no other "Remove …" control on the page is touched.
   */
  private async clearDraftAttachments(page: Page): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const removed = await page.evaluate((placeholder: string) => {
        let box: Element | null = document.querySelector(`[placeholder="${placeholder}"]`);
        while (box && !box.querySelector('button[aria-label="Attach files"]')) box = box.parentElement;
        const btn = box?.querySelector<HTMLButtonElement>('button[aria-label^="Remove "]');
        if (!btn) return false;
        btn.click();
        return true;
      }, COMPOSER_PLACEHOLDER);
      if (!removed) return;
      await page.waitForTimeout(150);
    }
  }

  /** Put files on the composer's hidden file input and wait until each shows as attached. */
  private async attach(page: Page, files: string[]): Promise<void> {
    const input = page.locator('input[type="file"]').first();
    if (!(await input.count())) throw new Error("Waymond's attach control is gone (the page layout may have changed).");
    await input.setInputFiles(files);
    for (const file of files) {
      const name = basename(file);
      try {
        await page.locator(`button[aria-label="Remove ${name.replace(/"/g, '\\"')}"]`).first().waitFor({ timeout: 30_000 });
      } catch {
        throw new Error(`Waymond didn't accept the attachment ${name}`);
      }
    }
  }
}
