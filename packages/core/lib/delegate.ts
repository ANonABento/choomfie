/**
 * delegate: one brain hands a job to another and gets the answer back as text
 * plus files on disk. The `delegate` tool (Claude → Waymond today) and later
 * callers (a pipeline, another brain) all go through here.
 *
 * The target runs exactly as it does for a `/brain` channel: the same
 * conversation per chat key (so follow-ups, and the design context of a thread,
 * carry over), the same status line in that chat, the same queue (a message
 * typed in the thread waits for the task, and the other way round). If the
 * target moves the work to the background, delegate waits for the late result
 * instead of letting it go only to the chat.
 *
 * Who may delegate is the caller's business (`callerIsOwner`); which brains may
 * take a task is decided here.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import {
  awaitLateReply,
  brainDirectory,
  CLAUDE_BRAIN,
  DELEGATION_DEPTH,
  getBrain,
  listBrainIds,
  MAX_DELEGATION_DEPTH,
  setBrainAsker,
  type BrainFile,
  type BrainReply,
} from "@choomfie/shared";
import { inConversation } from "./brain-router.ts";
import type { AppContext } from "./types.ts";

/**
 * Brains that can't take a task. Claude as a target would let a caller (the
 * remote endpoint, another brain) start a session that runs commands on this
 * machine; it stays off until there's a use for it and limits to go with it.
 */
const NOT_DELEGABLE = new Set([CLAUDE_BRAIN]);

export interface DelegateRequest {
  /** The brain to hand the task to, e.g. "waymond". */
  to: string;
  /** Self-contained: the target doesn't see the delegator's conversation. */
  task: string;
  /** The target's conversation: a Discord channel or thread id. Its status line shows there. */
  conversation: string;
  /** Absolute paths of files to send. */
  files?: string[];
  /** Absolute folder for the files it hands back. */
  saveTo: string;
  /** Who is delegating, shown to the target as the sender. */
  from: string;
  /** How long to wait, in all, including results that went to the background. */
  waitMs: number;
  /** For this task only, the model to use (free: `groq`, `groq:openai/gpt-oss-120b`, `auto`). */
  model?: string;
  /** Asks deep this already is: Claude's or the owner's is 0. Past MAX_DELEGATION_DEPTH it's refused (no loops). */
  depth?: number;
  /** The chat the delegator is answering in: `/stop` there stops this task too. */
  askedFrom?: string;
}

export interface DelegateResult {
  /** The target's display name. */
  label: string;
  text: string;
  /** Where the files it handed back were saved. */
  files: string[];
  /** Quick replies it offered; answer with another delegate call. */
  choices: string[];
  /** Titles of actions it wants the owner to approve (in a `/brain` chat). */
  approvals: string[];
  /** Still going when the wait ran out: the rest will be posted in the conversation. */
  stillWorking: boolean;
  stopped: boolean;
}

/** A request that can't be made (unknown brain, bad path): the message says why. */
export class DelegateError extends Error {}

/** Brains that can take a task right now. */
export function delegateTargets(): string[] {
  return listBrainIds().filter((id) => !NOT_DELEGABLE.has(id));
}

/** A file name that can't climb out of the folder it's written to. */
export function safeFileName(name: string, i: number): string {
  const base = basename(name).replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "");
  return base || `file-${i + 1}`;
}

/** Write files to `dir` under safe, distinct names; returns their paths. */
export function saveFiles(files: BrainFile[], dir: string): string[] {
  if (!files.length) return [];
  mkdirSync(dir, { recursive: true });
  const used = new Set<string>();
  return files.map((f, i) => {
    let name = safeFileName(f.name, i);
    if (used.has(name)) name = `${i + 1}-${name}`;
    used.add(name);
    const path = join(dir, name);
    writeFileSync(path, f.data);
    return path;
  });
}

/** Tasks in flight, by the chat that asked: `/stop` there reaches them. */
const running = new Map<string, Set<{ to: string; conversation: string }>>();

/** Stop every task delegated from `chatId` that is still running. Returns the labels of the brains asked to stop. */
export async function stopDelegations(chatId: string): Promise<string[]> {
  const tasks = [...(running.get(chatId) ?? [])];
  const stopped = await Promise.all(
    tasks.map(async (t) => {
      const brain = getBrain(t.to);
      const ok = await brain?.stop?.(t.conversation).catch(() => false);
      return ok ? brain!.label : null;
    })
  );
  return [...new Set(stopped.filter((l): l is string => !!l))];
}

/** Who can take a task and what each does, for errors. */
const targetsLine = () => `brains: ${brainDirectory() || "none loaded"}`;

export async function delegate(req: DelegateRequest, ctx: AppContext): Promise<DelegateResult> {
  if (!req.task.trim()) throw new DelegateError("task is empty");
  if (!req.conversation) throw new DelegateError("a conversation (chat or thread id) is required");
  const depth = req.depth ?? 0;
  if (depth >= MAX_DELEGATION_DEPTH) throw new DelegateError(`that's ${depth} hand-offs deep already; answer with what you have`);
  if (NOT_DELEGABLE.has(req.to)) throw new DelegateError(`"${req.to}" can't take a delegated task (${targetsLine()})`);
  const brain = getBrain(req.to);
  if (!brain) throw new DelegateError(`no brain "${req.to}" loaded (${targetsLine()})`);
  for (const f of req.files ?? []) {
    if (!isAbsolute(f) || !existsSync(f)) throw new DelegateError(`file not found (absolute path needed): ${f}`);
  }
  if (!isAbsolute(req.saveTo)) throw new DelegateError("saveTo must be an absolute path");

  const task = { to: brain.id, conversation: req.conversation };
  const mine = req.askedFrom ? (running.get(req.askedFrom) ?? new Set()) : null;
  if (mine) running.set(req.askedFrom!, mine.add(task));
  try {
    return await run();
  } finally {
    if (mine) {
      mine.delete(task);
      if (!mine.size && running.get(req.askedFrom!) === mine) running.delete(req.askedFrom!);
    }
  }

  function run() {
    return inConversation(req.conversation, async () => {
      const deadline = Date.now() + req.waitMs;
      const replies: BrainReply[] = [
        await brain.send(
          {
            chatKey: req.conversation,
            content: req.task,
            filePaths: req.files ?? [],
            meta: {
              chat_id: req.conversation,
              user: req.from,
              role: "owner",
              // Whoever answers this can't hand it on past the limit.
              [DELEGATION_DEPTH]: String(depth + 1),
              ...(req.model ? { model: req.model } : {}),
            },
          },
          ctx
        ),
      ];
      // Background work: wait here (holding the conversation) for each late result, until the deadline.
      while (replies.at(-1)!.background && !replies.at(-1)!.stopped) {
        const late = await awaitLateReply(brain.id, req.conversation, deadline - Date.now());
        if (!late) break;
        replies.push(late);
      }
      const last = replies.at(-1)!;
      return {
        label: brain.label,
        text: replies.map((r) => r.text).filter(Boolean).join("\n\n"),
        files: saveFiles(replies.flatMap((r) => r.files ?? []), req.saveTo),
        choices: last.choices ?? [],
        approvals: replies.flatMap((r) => r.approvals ?? []).map((a) => a.title),
        stillWorking: !!last.background && !last.stopped,
        stopped: !!last.stopped,
      };
    });
  }
}

/**
 * Let brains outside core ask another brain (`askBrain` in @choomfie/shared):
 * the web-brain kit's `#!ask` blocks. Same rules as the tool: owner work,
 * depth-limited, files saved under the data dir.
 */
export function installBrainAsker(ctx: AppContext): void {
  setBrainAsker(async (req) => {
    const r = await delegate(
      {
        to: req.to,
        task: req.task,
        conversation: req.conversation,
        files: req.files ?? [],
        saveTo: join(ctx.DATA_DIR, "brain-files", req.to, new Date().toISOString().replace(/[:.]/g, "-")),
        from: req.from,
        waitMs: 10 * 60_000,
        depth: req.depth,
      },
      ctx
    );
    return { label: r.label, text: r.text, files: r.files };
  });
}
