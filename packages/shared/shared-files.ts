/**
 * Files too big for Discord, served from this machine instead: the worker
 * saves one under `<data>/shared-files/<token>/`, and the remote MCP endpoint
 * (the process behind the Tailscale Funnel) serves it at `/f/<token>/<name>`
 * until it expires. The token is 24 random bytes: the link is the only key,
 * so it goes only into the reply.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { BrainFile } from "./brains.ts";

export const SHARE_TTL_MS = 7 * 24 * 3_600_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

const root = (dataDir: string) => join(dataDir, "shared-files");

/** A name safe to put in a path and a URL: no folders, no odd characters. */
export function safeName(name: string): string {
  const clean = name.split(/[\\/]/).pop()!.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "");
  return clean.slice(-120) || "file";
}

/** Save a file to be served; returns the path part of its link (`f/<token>/<name>`). */
export function shareFile(dataDir: string, file: BrainFile, ttlMs = SHARE_TTL_MS, now = Date.now()): { urlPath: string; expiresAt: number } {
  const token = randomBytes(24).toString("base64url");
  const dir = join(root(dataDir), token);
  mkdirSync(dir, { recursive: true });
  const name = safeName(file.name);
  writeFileSync(join(dir, name), file.data);
  const expiresAt = now + ttlMs;
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ name, expiresAt }));
  return { urlPath: `f/${token}/${encodeURIComponent(name)}`, expiresAt };
}

/** The file behind `/f/<token>/<name>`, if it exists and hasn't expired. */
export function sharedFilePath(dataDir: string, token: string, name: string, now = Date.now()): string | null {
  if (!TOKEN_RE.test(token)) return null;
  const dir = join(root(dataDir), token);
  try {
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { name: string; expiresAt: number };
    if (meta.name !== name || meta.expiresAt < now) return null;
    const path = join(dir, meta.name);
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

/** Delete expired shares (and any without a readable meta). */
export function sweepSharedFiles(dataDir: string, now = Date.now()): number {
  let removed = 0;
  let tokens: string[];
  try {
    tokens = readdirSync(root(dataDir));
  } catch {
    return 0;
  }
  for (const token of tokens) {
    const dir = join(root(dataDir), token);
    let expired = true;
    try {
      expired = (JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { expiresAt: number }).expiresAt < now;
    } catch {
      // No meta: half-written or foreign, remove it.
    }
    if (expired) {
      rmSync(dir, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}
