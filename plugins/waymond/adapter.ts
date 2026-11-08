/**
 * Waymond on Ambition, as a web-brain adapter.
 *
 * Sending goes through the UI (the request body of `POST /api/waymond/chat`
 * is unknown and the UI is the path a real user takes). Reading goes through
 * `/turn` + `/messages`, the JSON the web app itself polls, which is far
 * sturdier than scraping rendered text. Parsing lives in api.ts.
 */

import { basename } from "node:path";
import { DISCORD_MESSAGE_BYTES, errorMessage, type BrainApproval, type BrainFile } from "@choomfie/shared";
import {
  LayoutChangedError,
  LoginRequiredError,
  pageFetchBytes,
  pageFetchOk,
  type Page,
  type SiteAdapter,
} from "@choomfie/webbrain";
import { AUTO_MODE, continueAfterToolCap, planContext, stripNarration, WAYMOND_MODES } from "./modes.ts";
import {
  API_ORIGIN,
  APP_ORIGIN,
  absoluteLinks,
  CHAT_SEND_URL,
  CONVERSATION_PATH_RE,
  conversationIdFromSend,
  answerState,
  chatUrl,
  hasWaitingCard,
  lateMessages,
  memoryPrivateUrl,
  messagesUrl,
  APP_ACTION_PREFIX,
  appActionDetail,
  artifactFileName,
  artifactRefs,
  artifactUrl,
  parseArtifact,
  standaloneHtml,
  appActionUrl,
  offerActionUrl,
  openOffers,
  parseAppAction,
  parseMessages,
  parseTurn,
  parseWorkspaceFile,
  stopUrl,
  turnUrl,
  waitingCardsUrl,
  workspaceFileUrl,
  workspaceLinks,
  type Offer,
  type TurnState,
} from "./api.ts";

const COMPOSER_PLACEHOLDER = "Ask Waymond...";
/** Max wait for tool calls to attach after the text lands (observed ~2.3s). */
const SETTLE_MS = 8_000;
const SETTLE_POLL_MS = 800;
const POLL_MS = 2_500;

const ID = { id: "waymond", label: "Waymond" };

export function toApproval(o: Offer): BrainApproval {
  return {
    id: o.id,
    title: [o.title, o.subtitle].filter(Boolean).join(" · ") || o.kind,
    detail: o.detail,
    approveLabel: o.primary,
    declineLabel: o.secondary,
  };
}

export function progressLine(turn: TurnState, elapsedMs: number): string {
  const what = turn.running.length ? turn.running.slice(0, 3).join(", ") : (turn.intent ?? "thinking");
  return `⏳ Waymond is working (${Math.round(elapsedMs / 1000)}s): ${what.slice(0, 180)}`;
}

/** GET an Ambition endpoint from the logged-in page. */
const getJson = (page: Page, url: string) => pageFetchOk(page, url, ID);

/**
 * App actions (a GitHub commit Waymond proposed) say only "proposed" in the
 * message; their status and arguments live in `app-actions/<id>`. Fill in the
 * preview, and drop ones already approved or cancelled in the app.
 */
async function withAppActions(page: Page, offers: Offer[]): Promise<Offer[]> {
  const out: Offer[] = [];
  for (const o of offers) {
    if (!o.id.startsWith(APP_ACTION_PREFIX)) {
      out.push(o);
      continue;
    }
    const a = parseAppAction(await getJson(page, appActionUrl(o.id.slice(APP_ACTION_PREFIX.length))).catch(() => null));
    if (!a) out.push(o); // couldn't look: still offer it; the site refuses a stale one
    else if (a.status === "pending") out.push({ ...o, detail: appActionDetail(a) });
  }
  return out;
}

/** fetch() needs the app origin for the session cookie and CORS. */
async function onApp(page: Page) {
  if (!page.url().startsWith(APP_ORIGIN)) await page.goto(`${APP_ORIGIN}/chat`, { waitUntil: "domcontentloaded" });
}

/**
 * The composer keeps attachments as a draft until the message is sent, and
 * the draft survives reloads — a send that failed after attaching would leak
 * its files into the next message. So every send starts by clearing it.
 * Scoped to the composer (the element holding both the message box and the
 * attach button), so no other "Remove …" control on the page is touched.
 */
async function clearDraftAttachments(page: Page): Promise<void> {
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

/**
 * How much one answer brings back. Discord takes 10 files / ~10 MB per
 * message, so a bigger set goes over several messages; one file has to fit
 * a message on its own.
 */
const MAX_FILES = 20;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * The answer with its workspace links made absolute, plus the files they
 * point at. A file that can't be fetched or doesn't fit keeps only its link.
 */
export async function withFiles(page: Page, text: string): Promise<{ text: string; files: BrainFile[] }> {
  const files: BrainFile[] = [];
  const left: string[] = [];
  let room = MAX_UPLOAD_BYTES;
  const links = workspaceLinks(text);
  for (const link of links) {
    const name = basename(link.path);
    if (files.length >= MAX_FILES) {
      left.push(name);
      continue;
    }
    try {
      const where = parseWorkspaceFile(await getJson(page, workspaceFileUrl(link)));
      const cap = Math.min(room, DISCORD_MESSAGE_BYTES);
      const data = !where
        ? null
        : "content" in where
          ? new TextEncoder().encode(where.content)
          : await pageFetchBytes(page, where.downloadUrl, cap);
      if (data && data.length <= cap) {
        files.push({ name, data });
        room -= data.length;
      } else left.push(name);
    } catch (e) {
      left.push(name);
      console.error(`[waymond] couldn't fetch workspace file ${link.path}: ${errorMessage(e)}`);
    }
  }
  // Artifacts (a web sim, a chart): attach a page that opens on its own, and say so where the ref was.
  for (const ref of artifactRefs(text)) {
    let line = `**${ref.title}** (open it in the Waymond chat)`;
    try {
      const a = parseArtifact(await getJson(page, artifactUrl(ref.id)));
      let file: BrainFile | null = null;
      if (a?.document) {
        file = { name: artifactFileName(a.title, "html"), data: new TextEncoder().encode(standaloneHtml(a)) };
      } else if (a?.mediaUrl) {
        const ext = (/\.(\w{2,5})(?:\?|$)/.exec(a.mediaUrl)?.[1] ?? "bin").toLowerCase();
        const data = await pageFetchBytes(page, new URL(a.mediaUrl, API_ORIGIN).href, room);
        if (data) file = { name: artifactFileName(a.title, ext), data };
      }
      if (file && file.data.length <= Math.min(room, DISCORD_MESSAGE_BYTES) && files.length < MAX_FILES) {
        if (files.some((f) => f.name === file.name)) file.name = file.name.replace(/(\.\w+)$/, `-${ref.id.slice(0, 4)}$1`);
        files.push(file);
        room -= file.data.length;
        line = `📎 **${a!.title}** — attached as \`${file.name}\`${a!.document ? " (open it in a browser)" : ""}`;
      }
    } catch (e) {
      console.error(`[waymond] couldn't fetch artifact ${ref.id}: ${errorMessage(e)}`);
    }
    text = text.split(ref.token).join(line);
  }
  // Say which links didn't come along, rather than dropping them quietly.
  if (left.length) text += `\n\n-# Not attached (too big for Discord, or too many): ${left.join(", ")} — the links above open them in Waymond.`;
  return { text: absoluteLinks(text), files };
}

/** Put files on the composer's hidden file input and wait until each shows as attached. */
async function attach(page: Page, files: string[]): Promise<void> {
  const input = page.locator('input[type="file"]').first();
  if (!(await input.count())) throw new LayoutChangedError(ID, "the attach control is gone");
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

export const waymondAdapter: SiteAdapter = {
  ...ID,
  loginUrl: `${APP_ORIGIN}/chat`,
  chatUrl,
  modes: WAYMOND_MODES,
  defaultMode: AUTO_MODE,
  taskContext: planContext,
  continueAfter: continueAfterToolCap,

  async turn(page, { text, files, mode }, t) {
    await page.goto(chatUrl(t.ref), { waitUntil: "domcontentloaded" });
    const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER).first();
    try {
      await composer.waitFor({ state: "visible", timeout: 30_000 });
    } catch {
      if (!page.url().startsWith(`${APP_ORIGIN}/chat`)) throw new LoginRequiredError(ID);
      throw new LayoutChangedError(ID, "the message box never appeared");
    }

    let ref = t.ref;
    const baseline = new Set(ref ? parseMessages(await getJson(page, messagesUrl(ref))).map((m) => m.id) : []);

    await clearDraftAttachments(page);
    if (files.length) await attach(page, files);
    await t.human.type(composer, text);
    // A new chat's URL only changes once the whole answer has streamed, so the
    // conversation id comes from the send request instead.
    const sent = ref
      ? null
      : page.waitForRequest((r) => r.method() === "POST" && r.url().startsWith(CHAT_SEND_URL), { timeout: 30_000 });
    await t.human.submit(() => composer.press("Enter"));

    if (!ref) {
      const id = conversationIdFromSend((await sent!).postData()) ?? CONVERSATION_PATH_RE.exec(page.url())?.[1];
      if (!id) throw new LayoutChangedError(ID, "couldn't tell which conversation the message started");
      ref = id;
      // Chats from Discord stay out of Waymond's memory, so nothing in them
      // resurfaces elsewhere (a community chat it answers in).
      await pageFetchOk(page, memoryPrivateUrl(ref), ID, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ private: true }),
      }).catch((e) => t.notice(`⚠️ Couldn't turn off Waymond's memory for this chat: ${errorMessage(e)}`));
    }
    t.started(ref);

    const started = Date.now();
    let approvalNotified = false;
    let sawActive = false;
    let doneSince = 0;
    let polls = 0;
    for (;;) {
      await page.waitForTimeout(POLL_MS);
      const turn = parseTurn(await getJson(page, turnUrl(ref)));
      sawActive ||= turn.active;
      if (!turn.active) {
        const state = answerState(parseMessages(await getJson(page, messagesUrl(ref))), baseline, turn.active, sawActive);
        // Done, but give Waymond a moment to attach quick replies / cards.
        if (state.done && !state.settled && !t.stopRequested()) {
          doneSince ||= Date.now();
          if (Date.now() - doneSince < SETTLE_MS) {
            await page.waitForTimeout(SETTLE_POLL_MS);
            continue;
          }
        }
        if (state.done && !state.messageIds.length && !t.stopRequested()) {
          // Turn over, nothing written: Waymond's side failed (a tool call crashed the turn).
          throw new Error(`Waymond's turn ended without an answer (a tool may have failed on its side) — ${chatUrl(ref)}`);
        }
        if (state.done || t.stopRequested()) {
          const answer = await withFiles(page, mode ? stripNarration(state.reply) : state.reply);
          return {
            ...answer,
            ref,
            choices: state.options,
            approvals: (await withAppActions(page, state.offers)).map(toApproval),
            stopped: t.stopRequested(),
            background: state.background,
            lastMessageId: state.lastMessageId,
            messageIds: state.messageIds,
          };
        }
      }
      const elapsed = Date.now() - started;
      t.progress(progressLine(turn, elapsed));
      if (!approvalNotified && ++polls % 3 === 0 && hasWaitingCard(await getJson(page, waitingCardsUrl()), ref)) {
        approvalNotified = true;
        t.notice(`🔐 Waymond is waiting for your OK on something. Approve or decline it here: ${chatUrl(ref)}`);
      }
      if (elapsed > t.timeoutMs) {
        // Hand it to the late-result watch rather than lose the answer: it's posted when the turn ends.
        const ours = parseMessages(await getJson(page, messagesUrl(ref))).find((m) => m.role === "user" && !baseline.has(m.id));
        if (!ours) throw new Error(`still working after ${Math.round(elapsed / 60_000)} min — follow it at ${chatUrl(ref)}`);
        return {
          text: `⏳ Still working after ${Math.round(elapsed / 60_000)} min — follow it at ${chatUrl(ref)}`,
          files: [],
          ref,
          background: true,
          lastMessageId: ours.id,
          messageIds: [],
        };
      }
    }
  },

  async stop(page, ref) {
    await pageFetchOk(page, stopUrl(ref), ID, { method: "POST" });
    return true;
  },

  async readLate(page, ref, afterId, posted) {
    await onApp(page);
    // Mid-turn, the answer is still being written: wait for the turn to end.
    if (parseTurn(await getJson(page, turnUrl(ref))).active) return null;
    const late = lateMessages(parseMessages(await getJson(page, messagesUrl(ref))), afterId, posted);
    if (!late.length) return null;
    return {
      ...(await withFiles(page, late.map((m) => m.content.trim()).filter(Boolean).join("\n\n"))),
      choices: [...late].reverse().find((m) => m.options.length)?.options ?? [],
      approvals: (await withAppActions(page, openOffers(late))).map(toApproval),
      ids: late.map((m) => m.id),
      more: late.some((m) => m.startsTask),
    };
  },

  /** `POST cards/:id/send|decline`. Returns Ambition's status for the card. */
  async resolveApproval(page, ref, approvalId, approve) {
    await onApp(page);
    if (approvalId.startsWith(APP_ACTION_PREFIX)) {
      const id = approvalId.slice(APP_ACTION_PREFIX.length);
      const a = parseAppAction(await getJson(page, appActionUrl(id)));
      if (a && a.status !== "pending") return `already ${a.status}`;
      // The Discord click is the confirmation; "ask_twice" asks the site for the second one too.
      const json = await pageFetchOk(page, appActionUrl(id, approve ? "approve" : "decline"), ID, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(approve ? { confirm: true, twice: a?.tier === "ask_twice" } : {}),
      });
      return String((json as { status?: unknown } | undefined)?.status ?? (approve ? "approved" : "declined"));
    }
    const action = approve ? "send" : "decline";
    const json = await pageFetchOk(page, offerActionUrl(approvalId, action), ID, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversation_id: ref }),
    });
    return String((json as { status?: unknown } | undefined)?.status ?? action);
  },
};
