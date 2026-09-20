import { join } from "node:path";
import { findMonorepoRoot, resolveDataDir } from "@choomfie/shared";

export const CONTEXT_CHECK_INTERVAL = 60_000;
export const HANDOFF_SUMMARY_TIMEOUT = 30_000;
export const MAX_RESTART_BACKOFF = 60_000;
export const INITIAL_RESTART_BACKOFF = 2_000;
export const CONTEXT_CHECK_FAILURE_LIMIT = 5;
export const WORKER_HEALTH_INTERVAL = 30_000;
export const WORKER_MAX_CONSECUTIVE_FAILURES = 3;
export const MAX_ERROR_RETRIES = 10;

export const DATA_DIR = resolveDataDir();
export const META_DIR = `${DATA_DIR}/meta`;
export const PID_PATH = `${META_DIR}/meta.pid`;
export const HANDOFFS_PATH = `${META_DIR}/handoffs.json`;

// Resolve from packages/core to preserve the original root search start point.
export const PLUGIN_DIR = findMonorepoRoot(join(import.meta.dir, ".."));
