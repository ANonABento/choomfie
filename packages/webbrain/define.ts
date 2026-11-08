/**
 * `defineWebBrain(adapter)` — turns a site adapter into a Choomfie plugin
 * that registers a brain.
 *
 * Owns everything that isn't the site: the browser and its tabs, per-chat
 * ordering, submit pacing, the Discord status line for long turns,
 * attachments, the chat record (`ctx.chats`), `/stop`, approvals, and late
 * background results.
 */

import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import {
  errorMessage,
  parseTaskList,
  pushBrainReply,
  registerBrain,
  unregisterBrain,
  type Brain,
  type Plugin,
  type PluginContext,
} from "@choomfie/shared";
import type { Page } from "patchright";
import { LoginRequiredError, type SiteAdapter, type TurnContext, type TurnResult } from "./adapter.ts";
import { engineFor, launchContext } from "./engine/launch.ts";
import { createHuman, Pacer } from "./engine/human.ts";
import { outboxDir, profileDir } from "./paths.ts";
import { TabPool, type ContextLike } from "./tabs.ts";
import { LateWatch } from "./watch.ts";

export interface WebBrainOptions {
  /** Tabs open at once (chats answering side by side). Default 3. */
  maxTabs?: number;
  /** Close the browser after this long with nothing running. Default 10 min. */
  idleCloseMs?: number;
  /** Whole-turn timeout. Default 15 min. */
  turnTimeoutMs?: number;
  /** Replace the browser launch (tests, or another engine). Gets the site's profile dir. */
  launch?(profileDir: string): Promise<ContextLike<Page>>;
}

type Quiet = { content: string; allowedMentions: { parse: never[] } };
/** Status lines quote the site's own words: never let them ping anyone. */
const quiet = (content: string): Quiet => ({ content, allowedMentions: { parse: [] } });

interface StatusChannel {
  send(options: Quiet): Promise<{ edit(options: Quiet): Promise<unknown>; delete(): Promise<unknown> }>;
  sendTyping?(): Promise<unknown>;
}

async function channelFor(ctx: PluginContext, chatKey: string): Promise<StatusChannel | null> {
  try {
    const ch = await ctx.discord?.channels.fetch(chatKey);
    return ch && "send" in ch ? (ch as unknown as StatusChannel) : null;
  } catch {
    return null;
  }
}

/** The site only ever sees one account, so say who's talking when it isn't the owner. */
export function framePrompt(content: string, meta: Record<string, string>): string {
  const from = meta.role === "owner" ? "" : `[Discord message from ${meta.user ?? "someone"}]\n`;
  return `${from}${content}`;
}

/** Discord inbox files are named `<ts>_<rand>_<name>`; give the site the original name. */
export function originalName(inboxPath: string): string {
  return basename(inboxPath).replace(/^\d+_[a-z0-9]+_/, "") || basename(inboxPath);
}

/** What the Discord answer says beyond the site's own text. */
export function answerText(result: Pick<TurnResult, "text" | "stopped" | "background">, label: string): string {
  if (result.stopped) return `${result.text ? `${result.text}\n\n` : ""}⏹️ Stopped.`;
  if (result.background) return `${result.text}\n\n-# I'll post the results here when ${label} finishes.`;
  return result.text || `(${label} finished without a text reply)`;
}

/** The message as the site sees it: the chat's mode frame (if any), then the framed message. */
export function modePrompt(adapter: Pick<SiteAdapter, "modes">, mode: string | null, framed: string): { text: string; mode?: string } {
  const m = mode ? adapter.modes?.find((x) => x.id === mode) : undefined;
  return m ? { text: `${m.frame.trim()}\n\n${framed}`, mode: m.id } : { text: framed };
}

/** Headed for debugging: `CHOOMFIE_<ID>_HEADED=1`. */
const headedFor = (id: string) => process.env[`CHOOMFIE_${id.toUpperCase()}_HEADED`] === "1";

interface ActiveTurn {
  ref?: string;
  stop: boolean;
}

export function defineWebBrain(adapter: SiteAdapter, opts: WebBrainOptions = {}): Plugin {
  let pool: TabPool<Page> | null = null;
  let watch: LateWatch | null = null;

  function createBrain(ctx: PluginContext): Brain {
    const chats = ctx.chats;
    if (!chats) throw new Error(`${adapter.label} needs Choomfie's chat store (ctx.chats)`);

    const engine = engineFor(ctx.DATA_DIR, adapter);
    const profile = profileDir(ctx.DATA_DIR, adapter.id, engine);
    const outbox = outboxDir(ctx.DATA_DIR, adapter.id);
    const human = createHuman(new Pacer());
    const timeoutMs = opts.turnTimeoutMs ?? 15 * 60_000;
    const active = new Map<string, ActiveTurn>();
    const tabs = (pool = new TabPool<Page>({
      launch: () => (opts.launch ? opts.launch(profile) : launchContext(profile, { headless: !headedFor(adapter.id), engine })),
      maxTabs: opts.maxTabs,
      idleCloseMs: opts.idleCloseMs,
    }));
    const refAt = (chatKey: string) => chats.bound(chatKey, adapter.id)?.backendRef ?? undefined;

    /** Run on the chat's tab; a broken page (not a logged-out one) is reset so it can't poison the next turn. */
    const onTab = <T>(chatKey: string, fn: (page: Page) => Promise<T>) =>
      tabs.run(chatKey, async (page) => {
        try {
          return await fn(page);
        } catch (e) {
          if (!(e instanceof LoginRequiredError)) await page.goto("about:blank").catch(() => {});
          throw e instanceof Error ? e : new Error(errorMessage(e));
        }
      });

    const lateWatch = (watch = new LateWatch(
      (chatKey, ref, afterId, posted) =>
        adapter.readLate ? onTab(chatKey, (page) => adapter.readLate!(page, ref, afterId, posted)) : Promise.resolve(null),
      (chatKey, late) =>
        pushBrainReply(adapter.id, chatKey, { text: late.text, files: late.files, choices: late.choices, approvals: late.approvals })
    ));

    return {
      id: adapter.id,
      label: adapter.label,
      modes: adapter.modes?.map(({ id, label, description }) => ({ id, label, description })),
      defaultMode: adapter.defaultMode,

      // Core has already bound a fresh chat here; only the background watch is ours to drop.
      async reset(chatKey) {
        lateWatch.stop(chatKey);
      },

      async stop(chatKey) {
        const turn = active.get(chatKey);
        const page = tabs.peek(chatKey);
        if (!turn?.ref || !page || !adapter.stop) return false;
        turn.stop = true;
        return adapter.stop(page, turn.ref);
      },

      async resolveApproval(chatKey, approvalId, approve) {
        const ref = refAt(chatKey);
        if (!ref || !adapter.resolveApproval) throw new Error(`no ${adapter.label} conversation for this channel`);
        return onTab(chatKey, (page) => adapter.resolveApproval!(page, ref, approvalId, approve));
      },

      async send(message) {
        const chat = chats.current(message.chatKey, adapter.id, message.content);
        // In a chat the bot isn't in, status goes in the "thinking…" reply instead.
        const relayProgress = message.progress;
        const channel = relayProgress ? null : await channelFor(ctx, message.chatKey);
        let status: Awaited<ReturnType<StatusChannel["send"]>> | null = null;
        let lastEdit = 0;
        let lastTyping = 0;
        let statusBusy = false;
        let started = 0;

        const progress = (line: string) => {
          const now = Date.now();
          const elapsed = now - started;
          if (channel?.sendTyping && now - lastTyping > 8_000) {
            lastTyping = now;
            void channel.sendTyping().catch(() => {});
          }
          if (relayProgress) {
            // The placeholder is already on screen, so it can say more, sooner.
            if (statusBusy || elapsed < 10_000 || now - lastEdit < 15_000) return;
            lastEdit = now;
            statusBusy = true;
            void relayProgress(line)
              .catch(() => {})
              .finally(() => (statusBusy = false));
            return;
          }
          // Quiet for short answers; one self-updating status line for long tasks.
          if (!channel || statusBusy || elapsed < 45_000 || now - lastEdit < 20_000) return;
          lastEdit = now;
          statusBusy = true;
          void (status ? status.edit(quiet(line)) : channel.send(quiet(line)).then((m) => (status = m)))
            .catch(() => {})
            .finally(() => (statusBusy = false));
        };
        const notice = (line: string) => {
          void (relayProgress ? relayProgress(line) : channel?.send(quiet(line)))?.catch(() => {});
        };

        // Copy attachments under their original names so the site sees "photo.png".
        const batch = join(outbox, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
        const files = message.filePaths.map((p) => {
          mkdirSync(batch, { recursive: true });
          const dest = join(batch, originalName(p));
          copyFileSync(p, dest);
          return dest;
        });

        const turn: ActiveTurn = { ref: chat.backendRef ?? undefined, stop: false };
        try {
          const { text, mode } = modePrompt(
            adapter,
            chat.mode ?? adapter.defaultMode ?? null,
            (adapter.framePrompt ?? framePrompt)(message.content, message.meta)
          );
          const result = await onTab(message.chatKey, (page) => {
            started = Date.now();
            active.set(message.chatKey, turn);
            const tctx: TurnContext = {
              ref: turn.ref,
              started(ref) {
                turn.ref = ref;
                chats.setBackendRef(chat.id, ref);
              },
              stopRequested: () => turn.stop,
              progress,
              notice,
              human,
              timeoutMs,
            };
            return adapter.turn(page, { text, files, mode }, tctx);
          });
          chats.setBackendRef(chat.id, result.ref);
          lateWatch.delivered(message.chatKey, result.messageIds ?? []);
          if (result.background && result.lastMessageId) lateWatch.start(message.chatKey, result.ref, result.lastMessageId);
          const planMode = mode ? adapter.modes?.find((m) => m.id === mode && m.tasks) : undefined;
          // A task can't be for the planning modes themselves, except a sub-plan.
          const runnable = (adapter.modes ?? []).filter((m) => !m.runSingleTask).map((m) => m.id);
          const tasks = planMode ? parseTaskList(result.text, runnable) : [];
          const runNow = !!planMode?.runSingleTask && tasks.length === 1;
          return {
            text: answerText(result, adapter.label),
            files: result.files,
            choices: result.choices,
            approvals: result.approvals,
            ...(tasks.length ? { tasks, taskContext: adapter.taskContext?.(result.text), runNow } : {}),
          };
        } finally {
          if (active.get(message.chatKey) === turn) active.delete(message.chatKey);
          await (status as { delete(): Promise<unknown> } | null)?.delete().catch(() => {});
          rmSync(batch, { recursive: true, force: true });
        }
      },
    };
  }

  return {
    name: adapter.id,

    async init(ctx) {
      registerBrain(createBrain(ctx));
      console.error(`${adapter.label} initialized — brain \`${adapter.id}\` registered`);
    },

    async destroy() {
      unregisterBrain(adapter.id);
      watch?.stopAll();
      watch = null;
      await pool?.close();
      pool = null;
    },
  };
}
