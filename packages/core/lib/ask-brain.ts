/**
 * askBrain: one brain hands a job to another and gets the answer back as text
 * plus files on disk. The `ask_brain` tool (Claude → Waymond today) and later
 * callers (a pipeline, another brain) all go through here.
 *
 * The target runs exactly as it does for a `/brain` channel: the same
 * conversation per chat key (so follow-ups, and the design context of a thread,
 * carry over), the same status line in that chat, the same queue (a message
 * typed in the thread waits for the ask, and the other way round). If the
 * target moves the work to the background, askBrain waits for the late result
 * instead of letting it go only to the chat.
 *
 * Who may ask is the caller's business (`callerIsOwner`); which brains may be
 * asked is decided here.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { awaitLateReply, CLAUDE_BRAIN, getBrain, listBrainIds, type BrainFile, type BrainReply } from "@choomfie/shared";
import { inConversation } from "./brain-router.ts";
import type { AppContext } from "./types.ts";

/**
 * Brains that can't be asked. Claude as a target would let a caller (the
 * remote endpoint, another brain) start a session that runs commands on this
 * machine; it stays off until there's a use for it and limits to go with it.
 */
const NOT_ASKABLE = new Set([CLAUDE_BRAIN]);

export interface AskBrainRequest {
  /** The brain to ask, e.g. "waymond". */
  to: string;
  /** Self-contained: the target doesn't see the asker's conversation. */
  prompt: string;
  /** The target's conversation: a Discord channel or thread id. Its status line shows there. */
  conversation: string;
  /** Absolute paths of files to send. */
  files?: string[];
  /** Absolute folder for the files it hands back. */
  saveTo: string;
  /** Who is asking, shown to the target as the sender. */
  from: string;
  /** How long to wait, in all, including results that went to the background. */
  waitMs: number;
}

export interface AskBrainResult {
  /** The target's display name. */
  label: string;
  text: string;
  /** Where the files it handed back were saved. */
  files: string[];
  /** Quick replies it offered; answer with another ask. */
  choices: string[];
  /** Titles of actions it wants the owner to approve (in a `/brain` chat). */
  approvals: string[];
  /** Still going when the wait ran out: the rest will be posted in the conversation. */
  stillWorking: boolean;
  stopped: boolean;
}

/** A request that can't be made (unknown brain, bad path): the message says why. */
export class AskBrainError extends Error {}

/** Brains that can be asked right now. */
export function askableBrains(): string[] {
  return listBrainIds().filter((id) => !NOT_ASKABLE.has(id));
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

export async function askBrain(req: AskBrainRequest, ctx: AppContext): Promise<AskBrainResult> {
  if (!req.prompt.trim()) throw new AskBrainError("prompt is empty");
  if (!req.conversation) throw new AskBrainError("a conversation (chat or thread id) is required");
  if (NOT_ASKABLE.has(req.to)) throw new AskBrainError(`"${req.to}" can't be asked (askable: ${askableBrains().join(", ") || "none"})`);
  const brain = getBrain(req.to);
  if (!brain) throw new AskBrainError(`no brain "${req.to}" loaded (askable: ${askableBrains().join(", ") || "none"})`);
  for (const f of req.files ?? []) {
    if (!isAbsolute(f) || !existsSync(f)) throw new AskBrainError(`file not found (absolute path needed): ${f}`);
  }
  if (!isAbsolute(req.saveTo)) throw new AskBrainError("saveTo must be an absolute path");

  return inConversation(req.conversation, async () => {
    const deadline = Date.now() + req.waitMs;
    const replies: BrainReply[] = [
      await brain.send(
        {
          chatKey: req.conversation,
          content: req.prompt,
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
