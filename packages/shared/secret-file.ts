/**
 * Helpers for writing files that contain secrets or owner-identity data.
 *
 * Why: install.sh creates these files with 0600, but Bun.write / writeFileSync
 * respect umask only — and on overwrite, the `mode` option is ignored entirely.
 * Without an explicit chmod, a file pre-existing at 0644 stays at 0644 forever.
 * These helpers paper over that footgun.
 */

import { writeFileAtomicSync } from "./atomic-file.ts";

/** File mode for any file that contains a secret or owner identity (0600). */
export const SECRET_FILE_MODE = 0o600;

function toText(contents: string | Uint8Array): string {
  return typeof contents === "string" ? contents : new TextDecoder().decode(contents);
}

/**
 * Async secret-file write. Atomic (temp + rename) so a crash mid-write cannot
 * truncate access.json and lose the owner id and allowlist.
 */
export async function writeSecretFile(
  path: string,
  contents: string | Uint8Array
): Promise<void> {
  writeFileAtomicSync(path, toText(contents), { mode: SECRET_FILE_MODE });
}

/** Sync secret-file write. Same atomicity guarantee. */
export function writeSecretFileSync(
  path: string,
  contents: string | Uint8Array
): void {
  writeFileAtomicSync(path, toText(contents), { mode: SECRET_FILE_MODE });
}
