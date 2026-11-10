/**
 * Images posted in a chat, kept on disk for a while so a tool can ask for
 * "the pictures in your last reply" or "in my last message" instead of a path:
 * a brain (Waymond) can't name a file on this machine, but it knows what it
 * just posted.
 *
 *   <data dir>/thread-files/<chat>/<time>-<message id>/
 *     meta.json   {messageId, source: "user" | "brain", at, files}
 *     <the images>
 *
 * Recorded from the Discord handler (the user's attachments, already
 * downloaded) and from brain replies (their files). Entries older than
 * KEEP_MS are pruned whenever something new is recorded.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { PipelineError } from "./args.ts";

export type FileSource = "user" | "brain";
export type FileSpec = "last_reply" | "last_mine" | string[];

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
export const KEEP_MS = 7 * 24 * 60 * 60_000;

interface Entry {
  dir: string;
  messageId: string;
  source: FileSource;
  at: number;
  files: string[];
}

const root = (dataDir: string) => join(dataDir, "thread-files");
const safe = (s: string) => s.replace(/[^\w.-]+/g, "_").slice(0, 80) || "_";

export function isImage(name: string): boolean {
  return IMAGE_EXTS.has(extname(name).toLowerCase());
}

/** Keep the images among `files` (in memory or on disk) for this chat and message. */
export function recordThreadFiles(
  dataDir: string,
  chatKey: string,
  messageId: string,
  source: FileSource,
  files: ({ name: string; data: Uint8Array } | { path: string })[],
  now = Date.now()
): void {
  const images = files.filter((f) => isImage("path" in f ? f.path : f.name));
  if (!images.length) return;
  const dir = join(root(dataDir), safe(chatKey), `${now}-${safe(messageId)}`);
  mkdirSync(dir, { recursive: true });
  const names: string[] = [];
  images.forEach((f, i) => {
    let name = safe(basename("path" in f ? f.path : f.name));
    if (names.includes(name)) name = `${i + 1}-${name}`;
    if ("path" in f) {
      if (!existsSync(f.path)) return;
      copyFileSync(f.path, join(dir, name));
    } else writeFileSync(join(dir, name), f.data);
    names.push(name);
  });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ messageId, source, at: now, files: names }));
  prune(dataDir, now);
}

function entries(dataDir: string, chatKey: string): Entry[] {
  const chatDir = join(root(dataDir), safe(chatKey));
  if (!existsSync(chatDir)) return [];
  const out: Entry[] = [];
  for (const name of readdirSync(chatDir)) {
    try {
      const meta = JSON.parse(readFileSync(join(chatDir, name, "meta.json"), "utf-8"));
      out.push({ dir: join(chatDir, name), ...meta });
    } catch {
      // half-written or foreign: not an entry
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Whether this chat has kept images from the brain ("last_reply") or the user ("last_mine"). */
export function hasThreadFiles(dataDir: string, chatKey: string, spec: "last_reply" | "last_mine"): boolean {
  const source: FileSource = spec === "last_reply" ? "brain" : "user";
  return entries(dataDir, chatKey).some((e) => e.source === source);
}

/** Copy the images `spec` names into `dest`; returns their paths there. Throws PipelineError if there are none. */
export function resolveThreadFiles(dataDir: string, chatKey: string, spec: FileSpec, dest: string): string[] {
  const all = entries(dataDir, chatKey);
  let picked: Entry[];
  if (spec === "last_reply" || spec === "last_mine") {
    const source: FileSource = spec === "last_reply" ? "brain" : "user";
    const latest = all.find((e) => e.source === source);
    picked = latest ? [latest] : [];
  } else if (Array.isArray(spec) && spec.every((s) => typeof s === "string")) {
    picked = spec.map((id) => {
      const e = all.find((x) => x.messageId === id);
      if (!e) throw new PipelineError(`no images kept for message ${id} in this chat`);
      return e;
    });
  } else {
    throw new PipelineError('files must be "last_reply", "last_mine" or a list of message ids');
  }
  if (!picked.length) throw new PipelineError(`no images found for ${JSON.stringify(spec)} in this chat (kept ${KEEP_MS / 86_400_000} days)`);
  mkdirSync(dest, { recursive: true });
  const out: string[] = [];
  // Oldest message first, files in the order they were posted.
  for (const e of [...picked].reverse()) {
    for (const f of e.files) {
      let target = join(dest, f);
      if (out.includes(target)) target = join(dest, `${out.length + 1}-${f}`);
      copyFileSync(join(e.dir, f), target);
      out.push(target);
    }
  }
  return out;
}

/** Remove the folders directly under `base` last changed more than `keepMs` ago. */
export function pruneByAge(base: string, keepMs = KEEP_MS, now = Date.now()): void {
  if (!existsSync(base)) return;
  for (const name of readdirSync(base)) {
    const dir = join(base, name);
    try {
      if (now - statSync(dir).mtimeMs > keepMs) rmSync(dir, { recursive: true, force: true });
    } catch {
      // gone already
    }
  }
}

function prune(dataDir: string, now: number): void {
  const base = root(dataDir);
  for (const chat of readdirSync(base)) {
    const chatDir = join(base, chat);
    for (const name of readdirSync(chatDir)) {
      const at = Number(name.split("-")[0]);
      if (Number.isFinite(at) && now - at > KEEP_MS) rmSync(join(chatDir, name), { recursive: true, force: true });
    }
    if (!readdirSync(chatDir).length) rmSync(chatDir, { recursive: true, force: true });
  }
}
