/**
 * Project root + data directory resolution — resilient to restructuring.
 *
 * Walks up from a starting directory until it finds the root package.json
 * (the one with "workspaces"). This replaces fragile import.meta.dir + "../.."
 * patterns throughout the codebase.
 */

import { join, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";

/** Walk up from a starting dir until we find the root package.json (the one with "workspaces"). */
export function findMonorepoRoot(from: string): string {
  let dir = from;
  while (dir !== "/") {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, "utf-8"));
        if (parsed.workspaces) return dir;
      } catch {}
    }
    dir = dirname(dir);
  }
  // Fallback: assume 2 levels up from any package
  return join(from, "..", "..");
}

/** Where Choomfie keeps its token, access list, database, and inbox. */
export const DEFAULT_DATA_DIR_SUFFIX = ".claude/plugins/data/choomfie-inline";

/**
 * Resolve the runtime data directory.
 *
 * Single source of truth for every entry point — supervisor, worker, daemon,
 * and the scripts. Both env var names are honored, in a
 * fixed order, so that setting either one moves *all* of them together.
 * (Previously each call site hardcoded the default and read only one of the
 * two names, so `CHOOMFIE_DATA_DIR` could point install.sh at a directory the
 * runtime never read.)
 */
export function resolveDataDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return (
    env.CHOOMFIE_DATA_DIR ||
    env.CLAUDE_PLUGIN_DATA ||
    join(env.HOME ?? ".", DEFAULT_DATA_DIR_SUFFIX)
  );
}
