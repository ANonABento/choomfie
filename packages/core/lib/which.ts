/**
 * Find a command the way the owner's shell would. The daemon runs under
 * launchd with a short PATH, so a tool installed somewhere personal (gh in
 * ~/bin) isn't found by name — observed 2026-11-08: "Executable not found in
 * $PATH: gh". Falls back to the usual install spots; the name itself if none.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EXTRA_DIRS = [join(homedir(), "bin"), join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"];
const found = new Map<string, string>();

export function which(name: string, dirs = EXTRA_DIRS): string {
  const hit = found.get(name);
  if (hit) return hit;
  const path = Bun.which(name) ?? dirs.map((d) => join(d, name)).find((p) => existsSync(p)) ?? name;
  if (path !== name) found.set(name, path);
  return path;
}
