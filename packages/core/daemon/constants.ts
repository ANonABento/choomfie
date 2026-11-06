import { join } from "node:path";
import { chatHomeDir, findMonorepoRoot, resolveDataDir } from "@choomfie/shared";

export const CONTEXT_CHECK_INTERVAL = 60_000;
export const HANDOFF_SUMMARY_TIMEOUT = 30_000;
/**
 * A threshold crossing only marks a compact as pending; it runs once the
 * session has been quiet this long with no turn in flight. Any new prompt or
 * stream message restarts the clock.
 */
export const CYCLE_IDLE_DEBOUNCE_MS = 45_000;
/**
 * Hard ceiling, as a multiple of `tokenThreshold`: past it the cycle is forced
 * even mid-task (120k default → 180k). Capped at 90% of the model's real
 * context window when that is known.
 */
export const CONTEXT_HARD_CEILING_RATIO = 1.5;
export const CONTEXT_HARD_CEILING_MAX_FRACTION = 0.9;
/** How long a forced cycle waits for the in-flight turn before asking for a summary. */
export const HANDOFF_TURN_DRAIN_TIMEOUT = 120_000;
export const MAX_RESTART_BACKOFF = 60_000;
export const INITIAL_RESTART_BACKOFF = 2_000;
export const WORKER_HEALTH_INTERVAL = 30_000;
export const WORKER_MAX_CONSECUTIVE_FAILURES = 3;

export const DATA_DIR = resolveDataDir();
export const META_DIR = `${DATA_DIR}/meta`;
export const PID_PATH = `${META_DIR}/meta.pid`;
/** Default cwd for a Claude chat (see `chatHomeDir`). */
export const CHAT_HOME = chatHomeDir(DATA_DIR);

// Resolve from packages/core to preserve the original root search start point.
export const PLUGIN_DIR = findMonorepoRoot(join(import.meta.dir, ".."));
