/**
 * Where a site's state lives: `<data dir>/webbrain/<id>/` holding `profile/`
 * (the logged-in browser profile) and `outbox/` (attachments being sent).
 *
 * Kept outside the repo, like everything else in the data dir — a browser
 * profile is a logged-in session.
 */

import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { profileName, type EngineName } from "./engine/launch.ts";

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const siteDir = (dataDir: string, id: string) => ensure(join(dataDir, "webbrain", id));
/** The site's browser profile for an engine (each engine keeps its own). */
export const profileDir = (dataDir: string, id: string, engine: EngineName = "patchright") =>
  ensure(join(siteDir(dataDir, id), profileName(engine)));
export const outboxDir = (dataDir: string, id: string) => ensure(join(siteDir(dataDir, id), "outbox"));

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
