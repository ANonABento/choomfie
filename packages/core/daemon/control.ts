/**
 * Reads control requests written by the worker (see
 * `@choomfie/shared/daemon-control.ts`) and hands them to the runtime.
 */

import { readFile, unlink } from "node:fs/promises";
import {
  daemonControlPath,
  isControlRequestStale,
  parseDaemonControlRequest,
  type DaemonControlRequest,
} from "@choomfie/shared";
import { DATA_DIR } from "./constants.ts";
import { getErrorMessage } from "./error.ts";
import { log } from "./log.ts";

const CONTROL_PATH = daemonControlPath(DATA_DIR);

/**
 * Consume the request at `path`, if any.
 *
 * Consume-once: the file is deleted *before* the caller acts, so a crash part
 * way through a cycle can't replay the request against the session that
 * replaces it. A malformed or stale request is deleted the same way — left in
 * place, an unparseable file would be re-read every two seconds forever.
 *
 * Takes the path so it can be tested; `takeControlRequest` is the real caller.
 */
export async function consumeControlRequest(
  path: string,
): Promise<DaemonControlRequest | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return null; // No request pending — the overwhelmingly common case.
  }

  let request: DaemonControlRequest | null = null;
  try {
    request = parseDaemonControlRequest(JSON.parse(raw));
  } catch (error: unknown) {
    log(`Discarding unparseable control request: ${getErrorMessage(error)}`);
  }
  if (!request) log("Discarding malformed control request");

  try {
    await unlink(path);
  } catch {
    // Already gone. Staleness covers anything we somehow fail to remove.
  }

  if (!request) return null;

  if (isControlRequestStale(request)) {
    const age = Math.round((Date.now() - request.requestedAt) / 1000);
    log(`Discarding stale ${request.command} request (${age}s old)`);
    return null;
  }

  return request;
}

export function takeControlRequest(): Promise<DaemonControlRequest | null> {
  return consumeControlRequest(CONTROL_PATH);
}
