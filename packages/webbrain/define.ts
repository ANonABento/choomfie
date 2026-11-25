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
  isQuotaReached,
  framePrompt,
  parseTaskList,
  pushBrainReply,
  registerBrain,
  unregisterBrain,
  type Brain,
  type BrainApproval,
  type Plugin,
  type PluginContext,
} from "@choomfie/shared";
import type { Page } from "patchright";
import { LoginRequiredError, type SiteAdapter, type TurnContext, type TurnResult } from "./adapter.ts";
import { engineFor, launchContext } from "./engine/launch.ts";
import { createHuman, Pacer } from "./engine/human.ts";
import { outboxDir, profileDir } from "./paths.ts";
import { hasProfile } from "./sites.ts";
import { TabPool, type ContextLike } from "./tabs.ts";
import { LateWatch } from "./watch.ts";
import { isLookOnly, MAX_CALLS, MAX_STEPS, ranNote, resultsPrompt, runCalls, runCommand, TOOL_REMINDER, toolGuide, type RunResult } from "./local-tools.ts";

export interface WebBrainOptions {
  /** Tabs open at once (chats answering side by side). Default 3. */
  maxTabs?: number;
  /** Close the browser after this long with nothing running. Default 10 min. */
  idleCloseMs?: number;
  /** How long to wait on one turn before leaving it to the late-result watch. Default 15 min. */
  turnTimeoutMs?: number;
  /** The same for a work mode's turn (one that makes a patch or files). Default 45 min. */
  workTurnTimeoutMs?: number;
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

export { framePrompt };

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

/** Times one message carries on after the site cuts an answer short. */
export const MAX_CONTINUES = 3;

/** Meta flag on a continue the kit sends itself for a late answer (it doesn't reset the count). */
const LATE_CONTINUE = "webbrain_continue";
/** Meta flag on the message carrying approved commands' output back to the site. */
const TOOL_RESULT = "webbrain_tool_result";

const runAll = async (cmds: string[]) => {
  const out: RunResult[] = [];
  for (const c of cmds) out.push(await runCommand(c));
  return out;
};

/** Headed for debugging: `CHOOMFIE_<ID>_HEADED=1` (dashes as underscores: `CHOOMFIE_GEMINI_WEB_HEADED`). */
const headedFor = (id: string) => process.env[`CHOOMFIE_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_HEADED`] === "1";

interface ActiveTurn {
  ref?: string;
  stop: boolean;
}

/** What `/compact` asks the site for: everything a fresh conversation needs to carry on. */
export const COMPACT_PROMPT =
  "Summarize our conversation so far so we can continue it in a new chat. Include the goal, decisions made, key facts, " +
  "what's done and what's still open, and any file names, code, commands and numbers word for word. Reply with the summary only.";

/** The first message of the fresh conversation after `/compact`: the summary, then what the owner wrote. */
export function seededPrompt(summary: string, message: string): string {
  return `[Summary of our earlier conversation, which we're continuing here:]\n${summary.trim()}\n\n[New message:]\n${message}`;
}

/** One site's brain and what it holds open (its browser, its late-result watch). */
interface WebBrainRuntime {
  create(ctx: PluginContext): Brain;
  close(): Promise<void>;
}

function webBrainRuntime(adapter: SiteAdapter, opts: WebBrainOptions = {}): WebBrainRuntime {
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
    const workTimeoutMs = opts.workTurnTimeoutMs ?? 45 * 60_000;
    const isWorkMode = (mode: string | null | undefined) => !!adapter.modes?.some((m) => m.id === mode && (m.repo || m.files || m.readsRepo));
    /** Continues sent for late answers, per chat, since the owner last wrote: bounded like the in-turn ones. */
    const lateContinues = new Map<string, number>();
    const active = new Map<string, ActiveTurn>();
    /**
     * `/compact` summaries waiting for the chat's next message, which opens a
     * fresh site conversation seeded with them. In memory: a restart before
     * then leaves the old conversation bound, so nothing is lost.
     */
    const compacted = new Map<string, string>();
    /** Commands waiting for the owner's Approve button, by approval id. */
    const pendingRuns = new Map<string, { chatKey: string; cmds: string[] }>();
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
          if (!(e instanceof LoginRequiredError) && !isQuotaReached(e)) await page.goto("about:blank").catch(() => {});
          throw e instanceof Error ? e : new Error(errorMessage(e));
        }
      });

    const lateWatch = (watch = new LateWatch(
      (chatKey, ref, afterId, posted) =>
        adapter.readLate ? onTab(chatKey, (page) => adapter.readLate!(page, ref, afterId, posted)) : Promise.resolve(null),
      async (chatKey, late) => {
        // A late answer that stopped short (the turn outlasted our wait, then hit the tool cap): carry on, as in a turn.
        const more = late.approvals?.length ? null : adapter.continueAfter?.(late.text, chats.bound(chatKey, adapter.id)?.mode ?? undefined);
        const n = lateContinues.get(chatKey) ?? 0;
        if (more && n < MAX_CONTINUES) {
          lateContinues.set(chatKey, n + 1);
          await pushBrainReply(adapter.id, chatKey, { text: `-# ${adapter.label} stopped before finishing — continuing (${n + 1}/${MAX_CONTINUES})` });
          const reply = await brain.send({ chatKey, content: more, filePaths: [], meta: { chat_id: chatKey, role: "owner", [LATE_CONTINUE]: "1" } }, ctx);
          await pushBrainReply(adapter.id, chatKey, reply);
          return;
        }
        await pushBrainReply(adapter.id, chatKey, { text: late.text, files: late.files, choices: late.choices, approvals: late.approvals });
      }
    ));

    const brain: Brain = {
      id: adapter.id,
      label: adapter.label,
      modes: adapter.modes?.map(({ id, label, description, repo, files }) => ({ id, label, description, ...(repo ? { repo } : {}), ...(files ? { files } : {}) })),
      defaultMode: adapter.defaultMode,

      // Core has already bound a fresh chat here; only the background watch is ours to drop.
      async reset(chatKey) {
        lateWatch.stop(chatKey);
        compacted.delete(chatKey);
      },

      // The site keeps the whole conversation; we can't trim it. So ask it for a summary, and
      // start the next message in a fresh conversation that opens with it.
      async compact(chatKey) {
        const ref = refAt(chatKey);
        if (!ref) return `Nothing to compact here yet — no ${adapter.label} conversation.`;
        if (active.has(chatKey)) return `${adapter.label} is still working on a message here — /compact once it's done.`;
        const result = await onTab(chatKey, (page) =>
          adapter.turn(page, { text: COMPACT_PROMPT, files: [] }, {
            ref,
            started: () => {},
            stopRequested: () => false,
            progress: () => {},
            notice: () => {},
            human,
            timeoutMs: 5 * 60_000,
          })
        );
        const summary = result.text.trim();
        if (!summary || result.stopped) return `${adapter.label} didn't give a summary — nothing changed.`;
        lateWatch.delivered(chatKey, result.messageIds ?? []);
        compacted.set(chatKey, summary);
        return `${adapter.label} summarized this chat (${summary.length.toLocaleString()} characters). Your next message here starts a fresh ${adapter.label} conversation that opens with the summary.`;
      },

      async stop(chatKey) {
        const turn = active.get(chatKey);
        const page = tabs.peek(chatKey);
        if (!turn?.ref || !page || !adapter.stop) return false;
        turn.stop = true;
        return adapter.stop(page, turn.ref);
      },

      async resolveApproval(chatKey, approvalId, approve) {
        const run = pendingRuns.get(approvalId);
        if (run) {
          pendingRuns.delete(approvalId);
          // Run (or not), hand the outcome to the site, and post its answer when it comes.
          void (async () => {
            const results = approve ? await runAll(run.cmds) : [];
            const content = approve ? resultsPrompt(results) : "[The owner declined to run that. Answer without it, or suggest another way.]";
            const reply = await brain.send({ chatKey, content, filePaths: [], meta: { chat_id: chatKey, role: "owner", [TOOL_RESULT]: "1" } }, ctx);
            await pushBrainReply(adapter.id, chatKey, results.length ? { ...reply, text: `${reply.text}\n${ranNote(results)}` } : reply);
          })().catch((e) => pushBrainReply(adapter.id, chatKey, { text: `⚠️ ${errorMessage(e)}` }));
          return approve ? `Running ${run.cmds.length === 1 ? "it" : `${run.cmds.length} commands`}…` : "Declined.";
        }
        const ref = refAt(chatKey);
        if (!ref || !adapter.resolveApproval) throw new Error(`no ${adapter.label} conversation for this channel`);
        return onTab(chatKey, (page) => adapter.resolveApproval!(page, ref, approvalId, approve));
      },

      async send(message) {
        if (!message.meta?.[LATE_CONTINUE]) lateContinues.delete(message.chatKey);
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

        // After /compact: a fresh site conversation, opened with the summary.
        const seed = message.meta?.[LATE_CONTINUE] ? undefined : compacted.get(message.chatKey);
        const turn: ActiveTurn = { ref: seed ? undefined : (chat.backendRef ?? undefined), stop: false };
        // Local tools: the owner's messages only, on a site that opts in.
        const tools = !!adapter.localTools && message.meta?.role === "owner";
        const toolResult = !!message.meta?.[TOOL_RESULT];
        try {
          // A thread on a pipeline (`/pipeline`) gets no default frame: its
          // note says how to work there, and a default like "do it in your
          // sandbox" pulls the brain away from the pipeline tool. `/mode` still wins.
          const onPipeline = !!chats.pipelineAt?.(message.chatKey);
          const framed = (adapter.framePrompt ?? framePrompt)(message.content, message.meta);
          // The guide opens each site conversation; later messages get a one-line reminder.
          const withTools = tools && !toolResult ? `${turn.ref ? TOOL_REMINDER : toolGuide()}\n\n${framed}` : framed;
          const { text, mode } = modePrompt(
            adapter,
            toolResult ? null : (chat.mode ?? (onPipeline ? null : adapter.defaultMode) ?? null),
            seed ? seededPrompt(seed, withTools) : withTools
          );
          const runTurn = (prompt: string, attach: string[]) =>
            onTab(message.chatKey, (page) => {
              started ||= Date.now();
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
                timeoutMs: isWorkMode(mode) ? workTimeoutMs : timeoutMs,
              };
              return adapter.turn(page, { text: prompt, files: attach, mode }, tctx);
            });
          let result = await runTurn(text, files);
          // The site cut the answer short (a tool-call cap): carry on, keeping files from every part.
          for (let i = 0; i < MAX_CONTINUES && !result.stopped && !turn.stop && !result.approvals?.length; i++) {
            if (result.background) break;
            const more = adapter.continueAfter?.(result.text, mode ?? undefined);
            if (!more) break;
            turn.ref = result.ref;
            chats.setBackendRef(chat.id, result.ref);
            lateWatch.delivered(message.chatKey, result.messageIds ?? []);
            notice(`${adapter.label} stopped before finishing — continuing (${i + 1}/${MAX_CONTINUES})`);
            const earlier = result.files ?? [];
            const { text: next } = modePrompt(adapter, mode ?? null, more);
            result = await runTurn(next, []);
            const names = new Set((result.files ?? []).map((f) => f.name));
            const kept = earlier.filter((f) => !names.has(f.name));
            if (kept.length) result = { ...result, files: [...kept, ...(result.files ?? [])] };
          }
          // The site asked to run commands here: look-only ones run now, anything else waits for the owner.
          const ran: RunResult[] = [];
          let waiting: BrainApproval | undefined;
          for (let step = 0; tools; step++) {
            if (result.stopped || turn.stop || result.background || result.approvals?.length) break;
            const asked = runCalls(result.text, result.codeBlocks);
            if (!asked.length) break;
            if (step >= MAX_STEPS) {
              result = { ...result, text: `${result.text}\n\n-# Stopped after ${MAX_STEPS} rounds of commands; say "go on" to continue.` };
              break;
            }
            const cmds = asked.slice(0, MAX_CALLS);
            if (!cmds.every(isLookOnly)) {
              const id = `run-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
              pendingRuns.set(id, { chatKey: message.chatKey, cmds });
              waiting = {
                id,
                title: `${adapter.label} wants to run this on your Mac`,
                detail: `\`\`\`sh\n${cmds.join("\n").slice(0, 1_800)}\n\`\`\``,
                approveLabel: "Run",
                declineLabel: "Don't run",
              };
              break;
            }
            progress(`🔧 running ${cmds.map((c) => `\`${c.slice(0, 60)}\``).join(", ")}`);
            const results = await runAll(cmds);
            ran.push(...results);
            turn.ref = result.ref;
            chats.setBackendRef(chat.id, result.ref);
            lateWatch.delivered(message.chatKey, result.messageIds ?? []);
            const skipped = asked.length > cmds.length ? `[Only the first ${MAX_CALLS} commands ran.]` : undefined;
            result = await runTurn(resultsPrompt(results, skipped), []);
          }
          if (ran.length) result = { ...result, text: `${result.text}\n${ranNote(ran)}` };
          if (waiting) result = { ...result, approvals: [...(result.approvals ?? []), waiting] };

          chats.setBackendRef(chat.id, result.ref);
          if (seed) {
            compacted.delete(message.chatKey);
            lateWatch.stop(message.chatKey); // the old conversation's background work isn't this one's
          }
          lateWatch.delivered(message.chatKey, result.messageIds ?? []);
          if (result.background && result.lastMessageId) lateWatch.start(message.chatKey, result.ref, result.lastMessageId);
          const planMode = mode ? adapter.modes?.find((m) => m.id === mode && m.tasks) : undefined;
          // A task can't be for the planning modes themselves, except a sub-plan.
          const runnable = (adapter.modes ?? []).filter((m) => !m.runSingleTask).map((m) => m.id);
          const tasks = planMode ? parseTaskList(result.text, runnable) : [];
          const runNow = !!planMode?.runSingleTask && tasks.length === 1;
          return {
            text: answerText(result, adapter.label),
            ...(result.stopped || turn.stop ? { stopped: true } : {}),
            ...(result.background ? { background: true } : {}),
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
    return brain;
  }

  return {
    create: createBrain,
    async close() {
      watch?.stopAll();
      watch = null;
      await pool?.close();
      pool = null;
    },
  };
}

/** One site as its own plugin (Waymond). */
export function defineWebBrain(adapter: SiteAdapter, opts: WebBrainOptions = {}): Plugin {
  const runtime = webBrainRuntime(adapter, opts);
  return {
    name: adapter.id,

    async init(ctx) {
      registerBrain(runtime.create(ctx));
      console.error(`${adapter.label} initialized — brain \`${adapter.id}\` registered`);
    },

    async destroy() {
      unregisterBrain(adapter.id);
      await runtime.close();
    },
  };
}

/**
 * Many sites in one plugin (`webbrains`): each site whose profile has been
 * logged in (`bun run webbrain login <id>`) becomes a brain; one never logged
 * in is skipped, and config.json `webbrain.<id>.enabled: false` turns one off.
 */
export function defineWebBrains(name: string, adapters: SiteAdapter[], opts: WebBrainOptions = {}): Plugin {
  const running = new Map<string, WebBrainRuntime>();
  return {
    name,

    async init(ctx) {
      const cfg = (ctx.config.getConfig() as { webbrain?: Record<string, { enabled?: boolean }> }).webbrain ?? {};
      for (const adapter of adapters) {
        if (cfg[adapter.id]?.enabled === false) continue;
        if (!hasProfile(ctx.DATA_DIR, adapter)) {
          console.error(`${name}: ${adapter.label} skipped — not logged in (bun run webbrain login ${adapter.id})`);
          continue;
        }
        const runtime = webBrainRuntime(adapter, opts);
        registerBrain(runtime.create(ctx));
        running.set(adapter.id, runtime);
      }
      console.error(`${name} initialized — ${running.size ? [...running.keys()].map((id) => `\`${id}\``).join(", ") : "no sites logged in"}`);
    },

    async destroy() {
      for (const [id, runtime] of running) {
        unregisterBrain(id);
        await runtime.close();
      }
      running.clear();
    },
  };
}
