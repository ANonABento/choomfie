/**
 * Helpers for writing files that contain secrets or owner-identity data.
 *
 * Why: install.sh creates these files with 0600, but Bun.write / writeFileSync
 * respect umask only — and on overwrite, the `mode` option is ignored entirely.
 * Without an explicit chmod, a file pre-existing at 0644 stays at 0644 forever.
 * These helpers paper over that footgun.
 */

import { writeFileSync, chmodSync } from "node:fs";
import { chmod } from "node:fs/promises";

/** File mode for any file that contains a secret or owner identity (0600). */
export const SECRET_FILE_MODE = 0o600;

/** Async secret-file write (Bun.write + chmod). */
export async function writeSecretFile(
  path: string,
  contents: string | Uint8Array
): Promise<void> {
  await Bun.write(path, contents);
  try {
    await chmod(path, SECRET_FILE_MODE);
  } catch {
    // Filesystem may not support chmod (e.g. some Windows mounts). Best effort.
  }
}

/** Sync secret-file write (writeFileSync + chmodSync). */
export function writeSecretFileSync(
  path: string,
  contents: string | Uint8Array
): void {
  writeFileSync(path, contents, { mode: SECRET_FILE_MODE });
  try {
    chmodSync(path, SECRET_FILE_MODE);
  } catch {
    // Best effort — see writeSecretFile.
  }
}
