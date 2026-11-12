/**
 * Brain registry — alternative responders for Discord messages.
 *
 * "claude" is not registered here: it is the default path (the message goes to
 * the Claude Code session as it always has). Anything else — e.g. a Waymond
 * web-UI driver — registers a Brain, usually from a plugin's init(), and a
 * channel opts into it with `/brain <name>`.
 *
 * Lives in @choomfie/shared, like the interaction registries, so plugins can
 * register without importing core.
 */

import type { PluginContext } from "./plugin-context.ts";

export const CLAUDE_BRAIN = "claude";

export interface BrainMessage {
  /** One backend conversation per key: the Discord channel or thread id. */
  chatKey: string;
  content: string;
  /** Same metadata the Claude path receives (user, user_id, role, …). */
  meta: Record<string, string>;
  /** Downloaded attachment paths. */
  filePaths: string[];
  /**
   * Set when the brain can't post to the chat itself (a group DM `/choomfie`):
   * show a "still working" line here instead. The answer replaces it.
   */
  progress?: (line: string) => Promise<void>;
}

/**
 * What one Discord message can carry for a bot on an unboosted server: 10
 * attachments, 10 MB in all (a little under, for the request's own overhead).
 * A reply with more is posted over several messages; one file over the cap can't go.
 */
export const DISCORD_MESSAGE_FILES = 10;
export const DISCORD_MESSAGE_BYTES = 9.5 * 1024 * 1024;

/** Files in posting order, packed into as few messages as Discord allows. */
export function fileBatches<T extends { data: Uint8Array }>(files: T[]): T[][] {
  const batches: T[][] = [];
  let bytes = 0;
  for (const f of files) {
    const cur = batches.at(-1);
    if (cur && cur.length < DISCORD_MESSAGE_FILES && bytes + f.data.length <= DISCORD_MESSAGE_BYTES) {
      cur.push(f);
      bytes += f.data.length;
    } else {
      batches.push([f]);
      bytes = f.data.length;
    }
  }
  return batches;
}

/** A file a brain hands back (an image it made, a PDF), posted as a Discord attachment. */
export interface BrainFile {
  name: string;
  data: Uint8Array;
}

export interface BrainReply {
  text: string;
  /** Ended by `/stop`: a plan's Run all stops here too. */
  stopped?: boolean;
  /** Still going on the brain's side (a long turn, a background job): the rest is posted when it lands. */
  background?: boolean;
  files?: BrainFile[];
  /** Quick replies; shown as buttons, and clicking one sends that text to the brain. */
  choices?: string[];
  /** Actions the brain wants the owner to approve (send a post, an email, …). */
  approvals?: BrainApproval[];
  /** A plan's task list: each becomes a button that runs the task in its own thread, in its mode. */
  tasks?: BrainTask[];
  /** Put in front of every task's prompt (where the full plan is, say). */
  taskContext?: string;
  /** Run `tasks[0]` now, in this same chat, switched to its mode — instead of posting buttons. */
  runNow?: boolean;
}

/** One step of a plan, for the mode that should do it. */
export interface BrainTask {
  n: number;
  /** The id as the plan wrote it ("11b"); falls back to n. */
  id?: string;
  /** A mode of the same brain (`code`, `cad`, …). */
  mode: string;
  /** Short name, for the button. */
  title: string;
  /** The whole task, sub-lines included: what to make and when it's done. Sent to a fresh chat, so it must stand alone. */
  spec: string;
  /** `owner/name` the task works in, when its line names one ("— in owner/name: …"). */
  repo?: string;
}

/**
 * The GitHub repo a task line works in: "in owner/name" anywhere ("in
 * ANonABento/rs3m-twin (new repo), create …"), or a line that starts with it.
 * A GitHub owner has no dots or underscores, which keeps file paths
 * ("in rs3m_twin/contact.py") out.
 */
export function taskRepo(spec: string): string | undefined {
  const name = "`?([A-Za-z0-9-]+\\/[A-Za-z0-9_.-]*[A-Za-z0-9_-])`?";
  const m = new RegExp(`\\bin\\s+${name}(?![\\w/-]|\\.\\w)`).exec(spec) ?? new RegExp(`^${name}\\s+[—–:-]`).exec(spec);
  const repo = m?.[1];
  return repo && !repo.includes("..") && !/\.(py|ts|js|md|ya?ml|json|scad|stl|txt|toml)$/i.test(repo) ? repo : undefined;
}

/**
 * The task list at the end of a plan: a line saying "Tasks", then one task
 * per line as `1. [cad] Motor mount — 40 x 30 plate … Done when: …`, with
 * any indented sub-lines under it. Only modes in `modes` count; anything else
 * is left as text.
 */
export function parseTaskList(text: string, modes: string[]): BrainTask[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^[#*\s]*tasks\b[^a-z]*$/i.test(l.trim()));
  if (start === -1) return [];
  const tasks: BrainTask[] = [];
  let current: BrainTask | null | undefined; // null: the last task line was a mode we skip
  for (const raw of lines.slice(start + 1)) {
    const line = raw.replace(/\*\*/g, "").trim();
    if (!line) continue;
    // "11b." is a task too (a plan inserted later) — it used to end the list.
    const m = /^(\d+)([a-z]?)[.)]\s*\[([a-z0-9]+)\]\s*(.+)$/i.exec(line);
    if (!m) {
      // A task's own sub-lines (indented, or bullets after a line ending in ":")
      // are part of its spec — dropping them sent a task out as just its heading.
      const sub = /^\s/.test(raw) || (/^[-*•]\s/.test(line) && (!current || current.spec.endsWith(":") || current.spec.includes("\n")));
      if (sub && current !== undefined) {
        if (current) current.spec += "\n" + raw.replace(/\*\*/g, "").trimEnd();
        continue; // a skipped task's sub-lines are skipped with it
      }
      if (tasks.length) break; // the list ended
      continue;
    }
    current = null;
    const mode = m[3].toLowerCase();
    if (!modes.includes(mode)) continue;
    const spec = m[4].trim();
    // "owner/repo — Scaffold: …" names the repo first; the title is what follows.
    const parts = spec.split(/\s+[—–-]\s+|:\s/).map((p) => p.trim()).filter(Boolean);
    const named = parts.length > 1 && /^[\w.-]+\/[\w.-]+$/.test(parts[0]) ? parts[1] : parts[0];
    let title = (named ?? spec).split(/[(,;]/)[0].trim();
    if (title.length > 40) title = title.slice(0, 40).replace(/\s+\S*$/, "") + "…";
    const repo = taskRepo(spec);
    current = { n: Number(m[1]), ...(m[2] ? { id: m[1] + m[2].toLowerCase() } : {}), mode, title, spec, ...(repo ? { repo } : {}) };
    tasks.push(current);
  }
  return tasks.slice(0, 50);
}

export interface BrainApproval {
  id: string;
  /** What it is, e.g. "RedTeam · New message". */
  title: string;
  /** The content that would go out. */
  detail: string;
  approveLabel: string;
  declineLabel: string;
}

/** A working style a brain offers per chat (`/mode`): how it should go about the work. */
export interface BrainMode {
  /** `/mode <id>`. Lowercase, no spaces. */
  id: string;
  label: string;
  /** One line for `/mode` and autocomplete. */
  description: string;
  /** Works on a git repo and hands back a `.patch` (a plan's tasks in it build on one branch). */
  repo?: boolean;
  /** Makes files (parts, models): in a plan with a repo, they're committed to this folder of its branch. */
  files?: string;
  /**
   * Reads a plan's repo (gets its branch as a bundle) but commits nothing: its
   * answer is the result, and its files stay with the brain (research reports
   * live in Waymond's workspace, not in a public repo).
   */
  readsRepo?: boolean;
}

export interface Brain {
  /** Stable id used in config and `/brain <name>`. Lowercase, no spaces. */
  id: string;
  /** Display name, e.g. "Waymond". */
  label: string;
  /** Modes a chat with this brain can be put in (`/mode`). */
  modes?: BrainMode[];
  /** The mode a chat runs in when none is set. */
  defaultMode?: string;
  send(message: BrainMessage, ctx: PluginContext): Promise<BrainReply>;
  /** Forget the backend conversation for this key, so the next message starts fresh. */
  reset?(chatKey: string): Promise<void>;
  /** Interrupt the reply in progress for this key. False if nothing was running. */
  stop?(chatKey: string): Promise<boolean>;
  /** Approve or decline a pending approval. Returns a short status for the card. */
  resolveApproval?(chatKey: string, approvalId: string, approve: boolean): Promise<string>;
}

/**
 * Posting a message a brain produced *outside* a request — e.g. a background
 * job finishing an hour later. Core installs the poster at boot (it owns the
 * Discord formatting and the quick-reply buttons); plugins only call push.
 */
type BrainPoster = (brainId: string, chatKey: string, reply: BrainReply) => Promise<void>;
let poster: BrainPoster | null = null;

export function setBrainPoster(fn: BrainPoster): void {
  poster = fn;
}

/**
 * Someone waiting for a conversation's late result (askBrain after a reply
 * that went to the background). It takes the result instead of the chat.
 */
const lateWaiters = new Map<string, (reply: BrainReply) => void>();
const lateKey = (brainId: string, chatKey: string) => `${brainId}\u0000${chatKey}`;

/**
 * The next late result for this conversation, or null after `ms`. Results
 * that land after that go to the chat as usual.
 */
export function awaitLateReply(brainId: string, chatKey: string, ms: number): Promise<BrainReply | null> {
  const key = lateKey(brainId, chatKey);
  return new Promise((resolve) => {
    const take = (reply: BrainReply | null) => {
      clearTimeout(timer);
      if (lateWaiters.get(key) === take) lateWaiters.delete(key);
      resolve(reply);
    };
    const timer = setTimeout(() => take(null), ms);
    lateWaiters.set(key, take);
  });
}

export async function pushBrainReply(brainId: string, chatKey: string, reply: BrainReply): Promise<void> {
  const waiter = lateWaiters.get(lateKey(brainId, chatKey));
  if (waiter) return waiter(reply);
  if (!poster) throw new Error("brain poster not installed");
  await poster(brainId, chatKey, reply);
}

const brains = new Map<string, Brain>();

export function registerBrain(brain: Brain): void {
  if (brain.id === CLAUDE_BRAIN) throw new Error(`"${CLAUDE_BRAIN}" is the built-in brain`);
  brains.set(brain.id, brain);
}

export function unregisterBrain(id: string): void {
  brains.delete(id);
}

export function getBrain(id: string): Brain | undefined {
  return brains.get(id);
}

/** Registered brain ids, plus the built-in "claude" first. */
export function listBrainIds(): string[] {
  return [CLAUDE_BRAIN, ...brains.keys()];
}
