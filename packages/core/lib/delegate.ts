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
import { awaitLateReply, CLAUDE_BRAIN, getBrain, listBrainIds, type BrainFile, type BrainReply } from "@choomfie/shared";
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

export async function delegate(req: DelegateRequest, ctx: AppContext): Promise<DelegateResult> {
  if (!req.task.trim()) throw new DelegateError("task is empty");
  if (!req.conversation) throw new DelegateError("a conversation (chat or thread id) is required");
  if (NOT_DELEGABLE.has(req.to)) throw new DelegateError(`"${req.to}" can't take a delegated task (targets: ${delegateTargets().join(", ") || "none"})`);
  const brain = getBrain(req.to);
  if (!brain) throw new DelegateError(`no brain "${req.to}" loaded (targets: ${delegateTargets().join(", ") || "none"})`);
  for (const f of req.files ?? []) {
    if (!isAbsolute(f) || !existsSync(f)) throw new DelegateError(`file not found (absolute path needed): ${f}`);
  }
  if (!isAbsolute(req.saveTo)) throw new DelegateError("saveTo must be an absolute path");

  return inConversation(req.conversation, async () => {
    const deadline = Date.now() + req.waitMs;
    const replies: BrainReply[] = [
      await brain.send(
        {
          chatKey: req.conversation,
          content: req.task,
          filePaths: req.files ?? [],
          meta: { chat_id: req.conversation, user: req.from, role: "owner" },
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
