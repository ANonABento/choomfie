/**
 * Brain registry — alternative responders for Discord messages.
 *
 * "claude" is not registered here: it is the default path (the message goes to
 * the Claude Code session as it always has). Anything else — e.g. a Waymond
 * web-UI driver — registers a Brain, usually from a plugin's init(), and a
 * channel opts into it with `/brain set`.
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
}

export interface BrainReply {
  text: string;
  files?: string[];
  /** Quick replies; shown as buttons, and clicking one sends that text to the brain. */
  choices?: string[];
}

export interface Brain {
  /** Stable id used in config and `/brain set`. Lowercase, no spaces. */
  id: string;
  /** Display name, e.g. "Waymond". */
  label: string;
  send(message: BrainMessage, ctx: PluginContext): Promise<BrainReply>;
  /** Forget the backend conversation for this key, so the next message starts fresh. */
  reset?(chatKey: string): Promise<void>;
  /** Interrupt the reply in progress for this key. False if nothing was running. */
  stop?(chatKey: string): Promise<boolean>;
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
