/**
 * `defineWebBrain(adapter)` — turns a site adapter into a Choomfie plugin
 * that registers a brain.
 *
 * Owns everything that isn't the site: the browser and its tabs, per-chat
 * ordering, submit pacing, the Discord status line for long turns,
 * attachments, the chat record (`ctx.chats`), `/stop`, approvals, and late
 * background results.
 */

import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import {
  errorMessage,
  isQuotaReached,
  mediaKindOf,
  JsonlLog,
  nowIso,
  framePrompt,
  parseTaskList,
  pushBrainReply,
  registerBrain,
  statusLine,
  askBrain,
  brainDirectory,
  DELEGATION_DEPTH,
  MAX_DELEGATION_DEPTH,
  type BrainFile,
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
import { joinRef, listProfiles, outboxDir, profileDir, siteDir, splitRef } from "./paths.ts";
import { hasProfile } from "./sites.ts";
import { TabPool, type ContextLike } from "./tabs.ts";
import { LateWatch } from "./watch.ts";
import {
  askCalls,
  askGuide,
  askResultsPrompt,
  isLookOnly,
  MAX_CALLS,
  MAX_STEPS,
  ranNote,
  resultsPrompt,
  runCalls,
  runCommand,
  TOOL_REMINDER,
  toolGuide,
  withoutRunBlocks,
  type RunResult,
} from "./local-tools.ts";

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

export { framePrompt };

/** Discord inbox files are named `<ts>_<rand>_<name>`; give the site the original name. */
export function originalName(inboxPath: string): string {
  return basename(inboxPath).replace(/^\d+_[a-z0-9]+_/, "") || basename(inboxPath);
}

/** What the Discord answer says beyond the site's own text. */
export function answerText(result: Pick<TurnResult, "text" | "stopped" | "background" | "files">, label: string): string {
  if (result.stopped) return `${result.text ? `${result.text}\n\n` : ""}⏹️ Stopped.`;
  if (result.background) return `${result.text}\n\n-# I'll post the results here when ${label} finishes.`;
  // A picture or track alone is the answer.
  return result.text || (result.files?.length ? "" : `(${label} finished without a text reply)`);
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

/** An account out of quota that didn't say until when: try it again after this. */
const PROFILE_QUOTA_MS = 3_600_000;

function webBrainRuntime(adapter: SiteAdapter, opts: WebBrainOptions = {}): WebBrainRuntime {
  /** One browser per logged-in account (profile 1, 2, …). */
  const pools = new Map<number, TabPool<Page>>();
  let watch: LateWatch | null = null;

  function createBrain(ctx: PluginContext): Brain {
    const chats = ctx.chats;
    if (!chats) throw new Error(`${adapter.label} needs Choomfie's chat store (ctx.chats)`);

    const engine = engineFor(ctx.DATA_DIR, adapter);
    /** The accounts logged in on this site (`webbrain login <id> --profile 2` adds one); at least profile 1. */
    const profiles = ((l) => (l.length ? l : [1]))(listProfiles(ctx.DATA_DIR, adapter.id, engine));
    const outbox = outboxDir(ctx.DATA_DIR, adapter.id);
    /** What each turn did (`bun run webbrain log <id>`): the daemon's stderr isn't kept anywhere. */
    const turnLog = new JsonlLog(join(siteDir(ctx.DATA_DIR, adapter.id), "turns.jsonl"), undefined, "webbrain");
    const logEvent = (chatKey: string, event: string, detail: Record<string, unknown> = {}) =>
      turnLog.write({ at: nowIso(), chat: chatKey, event, ...detail });
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
    const poolFor = (n: number): TabPool<Page> => {
      let p = pools.get(n);
      if (!p) {
        const dir = profileDir(ctx.DATA_DIR, adapter.id, engine, n);
        p = new TabPool<Page>({
          launch: () => (opts.launch ? opts.launch(dir) : launchContext(dir, { headless: !headedFor(adapter.id), engine })),
          maxTabs: opts.maxTabs,
          idleCloseMs: opts.idleCloseMs,
        });
        pools.set(n, p);
      }
      return p;
    };

    /**
     * Accounts out of their allowance, until when: `2`, or `2#music` when the
     * site caps one kind of work. A chat stays on the account its conversation
     * lives on; new work goes to the first account that isn't out.
     */
    const outUntil = new Map<string, number>();
    const isOut = (n: number, kind?: string) =>
      (outUntil.get(`${n}`) ?? 0) > Date.now() || (!!kind && (outUntil.get(`${n}#${kind}`) ?? 0) > Date.now());
    const freeProfile = (kind?: string) => profiles.find((n) => !isOut(n, kind));
    /** A chat with no conversation id yet: the account its first turn is on. */
    const startedOn = new Map<string, number>();
    const profileOf = (chatKey: string) => {
      const stored = chats.bound(chatKey, adapter.id)?.backendRef;
      return stored ? splitRef(stored).profile : (startedOn.get(chatKey) ?? profiles[0]);
    };
    const refAt = (chatKey: string) => splitRef(chats.bound(chatKey, adapter.id)?.backendRef).ref;

    /** Run on the chat's tab, in its account's browser; a broken page (not a logged-out one) is reset so it can't poison the next turn. */
    const onTab = <T>(chatKey: string, fn: (page: Page) => Promise<T>, profile = profileOf(chatKey)) =>
      poolFor(profile).run(chatKey, async (page) => {
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
      ...(adapter.capabilities ? { capabilities: adapter.capabilities } : {}),

      // More than one account: which are out, for `/brain status`.
      ...(profiles.length > 1
        ? {
            async status() {
              const now = Date.now();
              const parts = profiles.map((n) => {
                const out = [...outUntil].filter(([k, until]) => until > now && (k === `${n}` || k.startsWith(`${n}#`)));
                return out.length ? `${n} (out${out.map(([k]) => (k.includes("#") ? ` of ${k.split("#")[1]}` : "")).join(",")})` : `${n}`;
              });
              return [`${adapter.label} accounts: ${parts.join(", ")}`];
            },
          }
        : {}),

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
        const page = poolFor(profileOf(chatKey)).peek(chatKey);
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
            if (!approve) logEvent(chatKey, "declined", { cmds: run.cmds });
            for (const r of results) logEvent(chatKey, "ran", { cmd: r.cmd, exit: r.code, auto: false, ...(r.timedOut ? { timedOut: true } : {}) });
            const content = approve ? resultsPrompt(results) : "[The owner declined to run that, so it didn't run. Say so in a line and ask what they'd like instead.]";
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
        // One self-updating status line on a long turn (or the "thinking…" reply, in a chat the bot isn't in).
        const status = await statusLine(ctx, message.chatKey, message.progress);
        const progress = status.progress;
        const notice = (line: string) => {
          logEvent(message.chatKey, "notice", { line });
          status.notice(line);
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
        const stored = splitRef(chat.backendRef);
        const turn: ActiveTurn = { ref: seed ? undefined : stored.ref, stop: false };
        // Which account: the conversation's own, unless that one is out of what this asks for and another isn't.
        const kind = mediaKindOf(message.content);
        let profile = stored.profile;
        if (!turn.ref || isOut(profile, kind)) {
          const free = freeProfile(kind);
          if (free !== undefined && free !== profile && turn.ref) {
            notice(`${adapter.label} account ${profile} is out of ${kind ? `its ${kind} allowance` : "its allowance"} — this goes to account ${free}, in a fresh conversation`);
            turn.ref = undefined;
          }
          profile = free ?? profile;
        }
        if (!turn.ref) startedOn.set(message.chatKey, profile);
        // Local tools: the owner's messages only, on a site that opts in.
        const tools = !!adapter.localTools && message.meta?.role === "owner";
        const toolResult = !!message.meta?.[TOOL_RESULT];
        // Asking another brain (`#!ask <id>`): with tools on, and not past the hand-off depth (no loops).
        const depth = Number(message.meta?.[DELEGATION_DEPTH] ?? 0) || 0;
        const others = brainDirectory([adapter.id]);
        const canAsk = tools && depth < MAX_DELEGATION_DEPTH && !!others;
        try {
          // A thread on a pipeline (`/pipeline`) gets no default frame: its
          // note says how to work there, and a default like "do it in your
          // sandbox" pulls the brain away from the pipeline tool. `/mode` still wins.
          const onPipeline = !!chats.pipelineAt?.(message.chatKey);
          const framed = (adapter.framePrompt ?? framePrompt)(message.content, message.meta);
          // The guide opens each site conversation; later messages get a one-line reminder.
          // Built per attempt: a turn moved to another account opens a new conversation, which needs the full guide.
          const build = () => {
            const guide = turn.ref
              ? `${TOOL_REMINDER}${canAsk ? " [Or ask another AI: a block starting #!ask <id>.]" : ""}`
              : `${toolGuide()}${canAsk ? `\n${askGuide(others)}` : ""}`;
            const withTools = tools && !toolResult ? `${guide}\n\n${framed}` : framed;
            return modePrompt(
              adapter,
              toolResult ? null : (chat.mode ?? (onPipeline ? null : adapter.defaultMode) ?? null),
              seed ? seededPrompt(seed, withTools) : withTools
            );
          };
          const { mode } = build();
          const runTurn = (prompt: string, attach: string[]) =>
            onTab(message.chatKey, (page) => {
              status.begin();
              active.set(message.chatKey, turn);
              const tctx: TurnContext = {
                ref: turn.ref,
                started(ref) {
                  turn.ref = ref;
                  chats.setBackendRef(chat.id, joinRef(profile, ref));
                },
                stopRequested: () => turn.stop,
                progress,
                notice,
                human,
                timeoutMs: isWorkMode(mode) ? workTimeoutMs : timeoutMs,
              };
              const t0 = Date.now();
              logEvent(message.chatKey, "start", { ref: turn.ref ?? null, ...(profiles.length > 1 ? { profile } : {}), mode: mode ?? null, said: message.content.slice(0, 200), prompt: prompt.slice(-200), files: attach.map((f) => basename(f)) });
              tctx.log = (event, detail) => logEvent(message.chatKey, event, { ref: turn.ref ?? null, ...detail });
              return adapter.turn(page, { text: prompt, files: attach, mode }, tctx).then(
                (r) => {
                  logEvent(message.chatKey, "end", {
                    ref: r.ref,
                    ms: Date.now() - t0,
                    text: r.text.slice(0, 500),
                    chars: r.text.length,
                    ...(r.files?.length ? { out: r.files.map((f) => `${f.name} (${f.data.length} B)`) } : {}),
                    ...(r.codeBlocks?.length ? { codeBlocks: r.codeBlocks.length } : {}),
                    ...(r.stopped ? { stopped: true } : {}),
                    ...(r.background ? { background: true } : {}),
                  });
                  return r;
                },
                (e) => {
                  const detail = (e as { detail?: unknown } | null)?.detail;
                  logEvent(message.chatKey, "error", {
                    ms: Date.now() - t0,
                    error: errorMessage(e),
                    kind: e instanceof Error ? e.name : typeof e,
                    // The site's own words (a quota message), so the log says what it actually said.
                    ...(typeof detail === "string" ? { detail: detail.slice(0, 500) } : {}),
                  });
                  throw e;
                }
              );
            }, profile);
          const firstTurn = async () => {
            try {
              return await runTurn(build().text, files);
            } catch (e) {
              if (!isQuotaReached(e)) throw e;
              // This account is spent (or spent on this kind of work): bench it, and go on with another if there is one.
              outUntil.set(e.scope ? `${profile}#${e.scope}` : `${profile}`, e.resetAt ?? Date.now() + PROFILE_QUOTA_MS);
              const next = freeProfile(e.scope ?? kind);
              if (next === undefined) throw e;
              notice(`${adapter.label} account ${profile} is out of ${e.scope ? `its ${e.scope} allowance` : "its allowance"} — trying account ${next}${turn.ref ? ", in a fresh conversation" : ""}`);
              profile = next;
              turn.ref = undefined;
              startedOn.set(message.chatKey, profile);
              return await runTurn(build().text, files);
            }
          };
          let result = await firstTurn();
          // The site cut the answer short (a tool-call cap): carry on, keeping files from every part.
          for (let i = 0; i < MAX_CONTINUES && !result.stopped && !turn.stop && !result.approvals?.length; i++) {
            if (result.background) break;
            const more = adapter.continueAfter?.(result.text, mode ?? undefined);
            if (!more) break;
            turn.ref = result.ref;
            chats.setBackendRef(chat.id, joinRef(profile, result.ref));
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
          /** Files other brains made for this turn (an image Waymond drew): attached to the reply. */
          const fromOthers: BrainFile[] = [];
          const askedOf: string[] = [];
          for (let step = 0; tools; step++) {
            if (result.stopped || turn.stop || result.background || result.approvals?.length) break;
            const asks = canAsk ? askCalls(result.text, result.codeBlocks) : [];
            const asked = runCalls(result.text, result.codeBlocks);
            if (!asked.length && !asks.length) break;
            if (step >= MAX_STEPS) {
              result = { ...result, text: `${result.text}\n\n-# Stopped after ${MAX_STEPS} rounds of commands; say "go on" to continue.` };
              break;
            }
            if (asks.length) {
              // Ask first; any commands in the same reply wait for the next round.
              const answers = [];
              for (const a of asks.slice(0, MAX_CALLS)) {
                progress(`🤝 asking ${a.to}`);
                logEvent(message.chatKey, "asked", { to: a.to, task: a.task.slice(0, 200) });
                try {
                  const r = await askBrain({ to: a.to, task: a.task, conversation: `${message.chatKey}:${adapter.id}-asks`, from: adapter.label, depth });
                  for (const f of r.files) fromOthers.push({ name: basename(f), data: new Uint8Array(readFileSync(f)) });
                  askedOf.push(r.label);
                  answers.push({ to: a.to, label: r.label, text: r.text, files: r.files });
                } catch (e) {
                  answers.push({ to: a.to, error: errorMessage(e) });
                }
              }
              turn.ref = result.ref;
              chats.setBackendRef(chat.id, joinRef(profile, result.ref));
              lateWatch.delivered(message.chatKey, result.messageIds ?? []);
              const prompt = askResultsPrompt(answers) + (asked.length ? "\n[Commands in that reply didn't run; ask again if you still need them.]" : "");
              result = await runTurn(prompt, []);
              continue;
            }
            const cmds = asked.slice(0, MAX_CALLS);
            if (!cmds.every(isLookOnly)) {
              const id = `run-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
              pendingRuns.set(id, { chatKey: message.chatKey, cmds });
              logEvent(message.chatKey, "ask", { cmds });
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
            for (const r of results) logEvent(message.chatKey, "ran", { cmd: r.cmd, exit: r.code, auto: true, ...(r.timedOut ? { timedOut: true } : {}) });
            ran.push(...results);
            turn.ref = result.ref;
            chats.setBackendRef(chat.id, joinRef(profile, result.ref));
            lateWatch.delivered(message.chatKey, result.messageIds ?? []);
            const skipped = asked.length > cmds.length ? `[Only the first ${MAX_CALLS} commands ran.]` : undefined;
            result = await runTurn(resultsPrompt(results, skipped), []);
          }
          if (tools) {
            // The command shows on the Run card / "ran" line, not as a raw #!run block.
            const shown = withoutRunBlocks(result.text);
            result = { ...result, text: shown || (waiting ? `-# ${adapter.label} needs a command run here first.` : shown) };
          }
          if (ran.length) result = { ...result, text: `${result.text}\n${ranNote(ran)}` };
          if (askedOf.length) result = { ...result, text: `${result.text}\n-# 🤝 asked ${[...new Set(askedOf)].join(", ")}` };
          if (fromOthers.length) result = { ...result, files: [...(result.files ?? []), ...fromOthers] };
          if (waiting) result = { ...result, approvals: [...(result.approvals ?? []), waiting] };

          chats.setBackendRef(chat.id, joinRef(profile, result.ref));
          startedOn.delete(message.chatKey);
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
          await status.close();
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
      await Promise.all([...pools.values()].map((p) => p.close()));
      pools.clear();
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
