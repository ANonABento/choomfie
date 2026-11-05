/**
 * Where a site's state lives: `<data dir>/webbrain/<id>/` holding `profile/`
 * (the logged-in browser profile) and `outbox/` (attachments being sent).
 *
 * Kept outside the repo, like everything else in the data dir — a browser
 * profile is a logged-in session.
 */

import { existsSync, lstatSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const siteDir = (dataDir: string, id: string) => ensure(join(dataDir, "webbrain", id));
export const profileDir = (dataDir: string, id: string) => ensure(join(siteDir(dataDir, id), "profile"));
export const outboxDir = (dataDir: string, id: string) => ensure(join(siteDir(dataDir, id), "outbox"));

/**
 * Before the kit, a site kept its state in `<data dir>/<id>/` (Waymond did).
 * Move it once so the existing login carries over. Only safe before the
 * browser opens, which is when plugins initialize.
 */
export function adoptLegacyDir(dataDir: string, id: string): boolean {
  const legacy = join(dataDir, id);
  const target = join(dataDir, "webbrain", id);
  if (!existsSync(legacy) || existsSync(target)) return false;
  ensure(join(dataDir, "webbrain"));
  renameSync(legacy, target);
  return true;
}

/**
 * Chrome holds this while a profile is open; two browsers can't share one
 * profile. It's a symlink to "<host>-<pid>", which doesn't exist as a file, so
 * `existsSync` (which follows links) would always say no.
 */
export function profileInUse(dir: string): boolean {
  try {
    lstatSync(join(dir, "SingletonLock"));
    return true;
  } catch {
    return false;
  }
}
