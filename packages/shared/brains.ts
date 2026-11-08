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

/** A file a brain hands back (an image it made, a PDF), posted as a Discord attachment. */
export interface BrainFile {
  name: string;
  data: Uint8Array;
}

export interface BrainReply {
  text: string;
  /** Ended by `/stop`: a plan's Run all stops here too. */
  stopped?: boolean;
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
  /** A mode of the same brain (`code`, `cad`, …). */
  mode: string;
  /** Short name, for the button. */
  title: string;
  /** The whole task line: what to make and when it's done. Sent to a fresh chat, so it must stand alone. */
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
 * per line as `1. [cad] Motor mount — 40 x 30 plate … Done when: …`. Only
 * modes in `modes` count; anything else is left as text.
 */
export function parseTaskList(text: string, modes: string[]): BrainTask[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^[#*\s]*tasks\b[^a-z]*$/i.test(l.trim()));
  if (start === -1) return [];
  const tasks: BrainTask[] = [];
  for (const raw of lines.slice(start + 1)) {
    const line = raw.replace(/\*\*/g, "").trim();
    if (!line) continue;
    const m = /^(\d+)[.)]\s*\[([a-z0-9]+)\]\s*(.+)$/i.exec(line);
    if (!m) {
      if (tasks.length) break; // the list ended
      continue;
    }
    const mode = m[2].toLowerCase();
    if (!modes.includes(mode)) continue;
    const spec = m[3].trim();
    // "owner/repo — Scaffold: …" names the repo first; the title is what follows.
    const parts = spec.split(/\s+[—–-]\s+|:\s/).map((p) => p.trim()).filter(Boolean);
    const named = parts.length > 1 && /^[\w.-]+\/[\w.-]+$/.test(parts[0]) ? parts[1] : parts[0];
    let title = (named ?? spec).split(/[(,;]/)[0].trim();
    if (title.length > 40) title = title.slice(0, 40).replace(/\s+\S*$/, "") + "…";
    const repo = taskRepo(spec);
    tasks.push({ n: Number(m[1]), mode, title, spec, ...(repo ? { repo } : {}) });
  }
  return tasks.slice(0, 25);
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

export async function pushBrainReply(brainId: string, chatKey: string, reply: BrainReply): Promise<void> {
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
