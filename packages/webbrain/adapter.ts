/**
 * The contract a site adapter implements. Everything site-specific lives
 * behind it; everything else (browser, tabs, locks, pacing, Discord progress,
 * attachments, chat records, late results) is the kit's.
 *
 * One required method: `turn()` — send one message in one conversation and
 * return the answer. The page it gets is this chat's own tab, already in the
 * site's logged-in profile; nothing else touches that tab while `turn()` runs.
 */

import type { EngineName } from "./engine/launch.ts";
import type { Locator, Page } from "patchright";
import type { BrainApproval, BrainFile, BrainMode } from "@choomfie/shared";

export type { Locator, Page };

export interface TurnInput {
  /** Prompt text, already framed (`framePrompt`). */
  text: string;
  /** Attachments, copied under their original file names. */
  files: string[];
  /** The chat's mode (`/mode`), already applied to `text`; lets the adapter tidy mode replies. */
  mode?: string;
}

/**
 * A per-chat working style. `frame` is put in front of every message while
 * the chat is in this mode: the site keeps no instructions of ours, so the
 * reminder rides along each time.
 */
export interface SiteMode extends BrainMode {
  frame: string;
  /** Replies end with a task list (`parseTaskList` format): post it as buttons that run each task in its own thread. */
  tasks?: boolean;
  /** A list of exactly one task runs right away, in this same chat, switched to that task's mode. */
  runSingleTask?: boolean;
}

export interface TurnContext {
  /** This chat's conversation on the site, or undefined to start a new one. */
  ref?: string;
  /** Report the conversation id as soon as it is known (so `/stop` can reach it). */
  started(ref: string): void;
  /** True once `/stop` was used for this chat: finish with what you have. */
  stopRequested(): boolean;
  /** A one-line status for long turns ("⏳ Searching the web…"). The kit throttles it. */
  progress(line: string): void;
  /** The site parked something that needs the owner (an approval in its own UI). */
  notice(line: string): void;
  /** Human-paced input. Use these rather than `fill()` / `press()` directly. */
  human: Human;
  /** Give up after this long. Real tasks can run for minutes. */
  timeoutMs: number;
  /**
   * A line in the site's turn log (`<data>/webbrain/<id>/turns.jsonl`, `bun
   * run webbrain log <id>`): what the adapter waited on or skipped, so a stuck
   * or empty turn can be explained afterwards. Not shown in Discord.
   */
  log?(event: string, detail?: Record<string, unknown>): void;
}

export interface Human {
  /** Click, then type `text` with human key timing (long or multi-line text is pasted). */
  type(target: Locator, text: string): Promise<void>;
  /** Wait out the site-wide spacing between submits, then run `submit`. */
  submit(submit: () => Promise<unknown>): Promise<void>;
  /** A short, random pause. */
  pause(minMs?: number, maxMs?: number): Promise<void>;
}

export interface TurnResult {
  text: string;
  /** Files the answer links to (images, PDFs it made), posted as attachments. */
  files?: BrainFile[];
  /** The conversation this turn happened in. */
  ref: string;
  choices?: string[];
  approvals?: BrainApproval[];
  /** Ended because `/stop` was used. */
  stopped?: boolean;
  /**
   * The answer handed work to a background job: the kit keeps polling
   * `readLate` from `lastMessageId` and posts what arrives.
   */
  background?: boolean;
  lastMessageId?: string;
  /** Messages this answer already delivered, so a late-result watch never re-posts them. */
  messageIds?: string[];
  /**
   * The answer's code blocks with their language, read from the page. Text
   * read with `innerText` loses its ``` fences, so a site with `localTools`
   * returns these for the kit to find ```run blocks in.
   */
  codeBlocks?: { lang?: string; code: string }[];
}

export interface LateResult {
  text: string;
  files?: BrainFile[];
  choices?: string[];
  approvals?: BrainApproval[];
  /** Message ids this covers. */
  ids: string[];
  /** These results started more background work: keep watching. */
  more: boolean;
}

/** What a site's terms of use say about automation, as last checked. */
export interface SiteTerms {
  /** `forbidden`: the terms ban bots or automated access (run on a spare account, if at all). */
  automation: "forbidden" | "unclear" | "allowed";
  /** When the terms were last read (YYYY-MM-DD). */
  checked: string;
  /** The clause or a link, one line. */
  note?: string;
}

export interface SiteAdapter {
  /** Brain id: `/brain <id>`, plugin name, profile directory. Lowercase, no spaces. */
  id: string;
  /** Display name. */
  label: string;
  /** Where `webbrain login <id>` opens. */
  loginUrl: string;
  /** Modes a chat can be put in with `/mode`. */
  modes?: SiteMode[];
  /** The mode a chat runs in when none is set (`/mode off`). */
  defaultMode?: string;
  /** Default browser engine; config.json `webbrain.<id>.engine` overrides. */
  engine?: EngineName;
  /** Link to a conversation, for messages that point the owner at the site. */
  chatUrl(ref?: string): string;
  /**
   * Is this profile signed in? For `webbrain sites`. Default: open `chatUrl()`
   * and see whether the site keeps us there or sends us to sign in. Only for a
   * site that shows a logged-out page at the chat URL instead of redirecting.
   */
  loggedIn?(page: Page): Promise<boolean>;
  /** What the site's terms say about driving it with a bot; `webbrain sites` shows it. */
  terms?: SiteTerms;
  /**
   * The site's model may run commands on this Mac (```run blocks, owner
   * only; see local-tools.ts). Off for a site with tools of its own (Waymond).
   */
  localTools?: boolean;

  /**
   * One message and its answer. Throw `LoginRequiredError` when the site
   * wants a login, and `QuotaReachedError` (from `@choomfie/shared`, with
   * `parseResetAt` on the site's words) when it says the daily or weekly
   * allowance is spent: free then benches this brain until the reset.
   */
  turn(page: Page, input: TurnInput, ctx: TurnContext): Promise<TurnResult>;
  /**
   * The answer stopped short (a per-turn tool-call cap, or a work mode's
   * turn that ended mid-task): the message to send so it carries on, or null
   * when it finished. `mode` is the chat's mode, if any. The kit sends it in
   * the same conversation, a few times at most — late answers included.
   */
  continueAfter?(answer: string, mode?: string): string | null;

  /** Interrupt the turn running in `ref`. Called on the same tab while `turn()` is in flight. */
  stop?(page: Page, ref: string): Promise<boolean>;
  /** Messages after `afterId` not in `posted` (background results), or null for none. */
  readLate?(page: Page, ref: string, afterId: string, posted: Set<string>): Promise<LateResult | null>;
  /** Approve or decline an approval the site offered. Returns a short status. */
  resolveApproval?(page: Page, ref: string, approvalId: string, approve: boolean): Promise<string>;
  /** For a task list: what every task needs to know first (where the full plan is). */
  taskContext?(answer: string): string | undefined;
  /** Turn a Discord message into the prompt. Default: prefix who's talking when it isn't the owner. */
  framePrompt?(content: string, meta: Record<string, string>): string;
}

/** Thrown by an adapter when the site wants a login. The kit tells the owner how. */
export class LoginRequiredError extends Error {
  constructor(adapter: Pick<SiteAdapter, "id" | "label">) {
    super(`${adapter.label} isn't logged in — on the Mac running Choomfie, run \`bun run webbrain login ${adapter.id}\`.`);
    this.name = "LoginRequiredError";
  }
}

/** The site's page layout moved and a control the adapter needs is gone. */
export class LayoutChangedError extends Error {
  constructor(adapter: Pick<SiteAdapter, "label">, what: string) {
    super(`${adapter.label}: ${what} (the page layout may have changed).`);
    this.name = "LayoutChangedError";
  }
}
