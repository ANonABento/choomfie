#!/usr/bin/env bun
/**
 * Print the configured model, or nothing when none is set.
 *
 * Exists for `bin/choomfie`: the launcher needs the same value the daemon
 * reads, and parsing config.json in bash (without a guaranteed `jq`) is worse
 * than paying for one short Bun start. Prints to stdout so the caller can
 * capture it; any failure prints nothing and exits 0, because a launcher that
 * refuses to start over an unreadable config is worse than one that falls back
 * to Claude Code's own default.
 */

import { ConfigManager } from "../lib/config.ts";
import { resolveDataDir } from "@choomfie/shared";

try {
  const model = new ConfigManager(resolveDataDir()).getModel();
  if (model) console.log(model);
} catch {
  // No output — the launcher treats that as "use the Claude Code default".
}
