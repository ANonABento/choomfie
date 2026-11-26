/**
 * Where a site's state lives: `<data dir>/webbrain/<id>/` holding `profile/`
 * (the logged-in browser profile) and `outbox/` (attachments being sent).
 *
 * Kept outside the repo, like everything else in the data dir — a browser
 * profile is a logged-in session.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { profileName, type EngineName } from "./engine/launch.ts";

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const siteDir = (dataDir: string, id: string) => ensure(join(dataDir, "webbrain", id));
/**
 * The site's browser profile for an engine (each engine keeps its own).
 * Profile 1 is `profile/`; more accounts on the same site are `profile-2/`,
 * `profile-3/`… (`bun run webbrain login <id> --profile 2`), each its own
 * browser and its own allowance.
 */
export const profileDir = (dataDir: string, id: string, engine: EngineName = "patchright", n = 1) =>
  ensure(join(siteDir(dataDir, id), profileDirName(engine, n)));

const profileDirName = (engine: EngineName, n: number) => (n === 1 ? profileName(engine) : `${profileName(engine)}-${n}`);

/** The profiles that have been opened (a login), by number: `[1]`, `[1, 2]`… No launch. */
export function listProfiles(dataDir: string, id: string, engine: EngineName = "patchright"): number[] {
  const dir = join(dataDir, "webbrain", id);
  const re = new RegExp(`^${profileName(engine)}(?:-(\\d+))?$`);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => re.exec(name))
    .filter((m): m is RegExpExecArray => !!m && existsSync(join(dir, m[0], "Default")))
    .map((m) => (m[1] ? Number(m[1]) : 1))
    .sort((a, b) => a - b);
}

/**
 * A chat's stored conversation id says which profile it lives on: profile 1's
 * as the site gave it (so existing chats keep working), another's as `2~<id>`.
 */
export function splitRef(stored: string | null | undefined): { profile: number; ref?: string } {
  if (!stored) return { profile: 1 };
  const m = /^(\d+)~(.*)$/.exec(stored);
  return m ? { profile: Number(m[1]), ref: m[2] } : { profile: 1, ref: stored };
}

export const joinRef = (profile: number, ref: string) => (profile === 1 ? ref : `${profile}~${ref}`);
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
