/**
 * A harness spec → a Brain. One conversation per chat (the CLI's id is the
 * chat's backendRef), one working folder per chat
 * (`<data>/harness/<id>/<chat id>`), one turn at a time per chat. Files the
 * agent makes or changes in the folder come back as attachments.
 *
 * Only the owner gets the spec's working modes: anyone else's message runs in
 * its read-only mode, whatever the chat is set to. The agent runs tools on
 * this machine.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import {
  DISCORD_MESSAGE_BYTES,
  DISCORD_MESSAGE_FILES,
  framePrompt,
  type Brain,
  type BrainFile,
  type BrainMessage,
  type PluginContext,
} from "@choomfie/shared";
import { spawnCli, type Spawner } from "./run.ts";
import type { HarnessSpec } from "./spec.ts";

export interface HarnessDeps {
  /** The executable's full path (from `Bun.which`). */
  binPath: string;
  spawn?: Spawner;
  /** Models for `/model`, listed at init. */
  models?: string[];
}

const ATTACHED = "attachments";
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__", ATTACHED]);
const MAX_SCAN = 2_000;

/** path → mtime:size for every file in the folder (bounded; dot folders and dependencies skipped). */
export function snapshot(dir: string): Map<string, string> {
  const seen = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (seen.size >= MAX_SCAN) return;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(p);
      } else if (e.isFile()) {
        const s = statSync(p);
        seen.set(p, `${s.mtimeMs}:${s.size}`);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return seen;
}

/** Files new or changed since `before`, as attachments; the ones that can't go are named instead. */
export function changedFiles(dir: string, before: Map<string, string>): { files: BrainFile[]; skipped: string[] } {
  const files: BrainFile[] = [];
  const skipped: string[] = [];
  for (const [p, sig] of snapshot(dir)) {
    if (before.get(p) === sig) continue;
    const name = relative(dir, p);
    const size = Number(sig.split(":")[1]);
    if (files.length >= DISCORD_MESSAGE_FILES || size > DISCORD_MESSAGE_BYTES) skipped.push(name);
    else files.push({ name: basename(p), data: readFileSync(p) });
  }
  return { files, skipped };
}

export function createHarnessBrain(spec: HarnessSpec, ctx: PluginContext, deps: HarnessDeps): Brain {
  const chats = ctx.chats;
  if (!chats) throw new Error(`${spec.label} needs Choomfie's chat store (ctx.chats)`);
  const spawn = deps.spawn ?? spawnCli;
  const active = new Map<string, AbortController>();
  const queue = new Map<string, Promise<unknown>>();

  /** One turn at a time per chat: the CLI's conversation can't take two. */
  const serial = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const run = (queue.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    queue.set(key, run);
    return run.finally(() => {
      if (queue.get(key) === run) queue.delete(key);
    });
  };

  const folderFor = (chatId: string) => {
    const dir = join(ctx.DATA_DIR, "harness", spec.id, chatId);
    mkdirSync(join(dir, ATTACHED), { recursive: true });
    return dir;
  };

  async function turn(message: BrainMessage) {
    const chat = chats!.current(message.chatKey, spec.id, message.content);
    const owner = message.meta.role === "owner";
    const mode = owner ? (chat.mode && spec.modes.some((m) => m.id === chat.mode) ? chat.mode : spec.defaultMode) : spec.readOnlyMode;
    const cwd = folderFor(chat.id);

    // Attachments go in the folder, so the agent can open them by name.
    const attached = message.filePaths.map((src) => {
      const name = basename(src);
      copyFileSync(src, join(cwd, ATTACHED, name));
      return `${ATTACHED}/${name}`;
    });
    let prompt = framePrompt(message.content, message.meta);
    if (attached.length) prompt += `\n\n[Attached files, in your working folder: ${attached.join(", ")}]`;

    const before = snapshot(cwd);
    const abort = new AbortController();
    active.set(message.chatKey, abort);
    let out;
    try {
      out = await spawn([deps.binPath, ...spec.args({ prompt, ref: chat.backendRef ?? undefined, model: chat.model ?? undefined, mode, cwd })], {
        cwd,
        signal: abort.signal,
        timeoutMs: spec.timeoutMs ?? 20 * 60_000,
      });
    } finally {
      if (active.get(message.chatKey) === abort) active.delete(message.chatKey);
    }
    if (out.killed === "stopped") return { text: `${spec.label} stopped.`, stopped: true };
    if (out.killed === "timeout") throw new Error(`${spec.label} took longer than ${Math.round((spec.timeoutMs ?? 20 * 60_000) / 60_000)} min and was stopped`);

    const r = spec.parse(out);
    if (r.ref && r.ref !== chat.backendRef) chats!.setBackendRef(chat.id, r.ref);
    chats!.touch(chat.id);
    if (r.failed) throw new Error(`${spec.label}: ${r.failed}`);
    const { files, skipped } = changedFiles(cwd, before);
    const more = skipped.length ? `\n-# also changed (too many or too big to attach): ${skipped.slice(0, 10).join(", ")}${skipped.length > 10 ? ", …" : ""}` : "";
    return { text: (r.text.trim() || `(${spec.label} sent an empty reply)`) + more, ...(files.length ? { files } : {}) };
  }

  return {
    id: spec.id,
    label: spec.label,
    modes: spec.modes,
    defaultMode: spec.defaultMode,
    send: (message) => serial(message.chatKey, () => turn(message)),
    async reset(chatKey) {
      chats.start(chatKey, spec.id);
    },
    async stop(chatKey) {
      const a = active.get(chatKey);
      if (!a) return false;
      a.abort();
      return true;
    },
    async status() {
      return [`**${spec.label}** — \`${deps.binPath}\`${spec.note ? ` · ${spec.note}` : ""}`];
    },
    ...(deps.models?.length ? { models: () => deps.models!.map((id) => ({ id })) } : {}),
  };
}
