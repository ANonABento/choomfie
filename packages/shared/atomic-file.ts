/**
 * Crash-safe file writes.
 *
 * Every JSON file Choomfie owns — config.json, access.json, meta/handoffs.json,
 * meta/daemon-state.json — was written by truncating the target and streaming
 * the new contents into it. A crash, a kill -9, a full disk, or a worker
 * restart landing mid-write leaves a truncated or half-written file, and the
 * next read either throws or silently falls back to defaults. For config.json
 * that means losing your personas and settings; for access.json it means
 * losing your owner id and allowlist.
 *
 * Writing to a sibling temp file and rename(2)-ing it over the target makes the
 * replacement atomic: a reader sees either the old file or the new one, never a
 * partial one. rename is only atomic within a filesystem, so the temp file is
 * always created next to the target rather than in /tmp.
 *
 * `openai/auth.ts` did this by hand for the API key store; this is that pattern
 * generalized so every writer gets it.
 */

import { writeFileSync, chmodSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

export type AtomicWriteOptions = {
  /** File mode applied to both the temp file and the final file. */
  mode?: number;
};

function tempPathFor(path: string): string {
  // Same directory (rename is only atomic within a filesystem), and unique per
  // process so two writers never collide on the temp name.
  return `${path}.${process.pid}.${Date.now()}.tmp`;
}

/** Write `contents` to `path` atomically, creating parent directories. */
export function writeFileAtomicSync(
  path: string,
  contents: string,
  options: AtomicWriteOptions = {},
): void {
  const { mode } = options;
  mkdirSync(dirname(path), { recursive: true });

  const tmpPath = tempPathFor(path);
  try {
    writeFileSync(tmpPath, contents, mode === undefined ? undefined : { mode });
    if (mode !== undefined) {
      try {
        chmodSync(tmpPath, mode);
      } catch {
        // Filesystem may not support chmod. Best effort.
      }
    }
    renameSync(tmpPath, path);
    if (mode !== undefined) {
      try {
        chmodSync(path, mode);
      } catch {
        // Best effort — see above.
      }
    }
  } catch (error) {
    // Never leave the temp file behind on a failed write.
    try {
      unlinkSync(tmpPath);
    } catch {
      // Already gone, or never created.
    }
    throw error;
  }
}

/** Pretty-print `value` as JSON and write it atomically. */
export function writeJsonAtomicSync(
  path: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): void {
  writeFileAtomicSync(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

/** Async wrappers. The write itself is sync — it is small and must not interleave. */
export async function writeFileAtomic(
  path: string,
  contents: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  writeFileAtomicSync(path, contents, options);
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  writeJsonAtomicSync(path, value, options);
}
