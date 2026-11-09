/**
 * Turning a caller's arguments into a command line, safely. This is the
 * boundary for the `pipeline` tool: it runs with the owner's authority, possibly
 * for a remote caller.
 *
 * - Arguments are a list, run without a shell: nothing is interpreted.
 * - The first argument must be on the pipeline's `allow` list.
 * - Anything that looks like a path (absolute, `~`, or with a `..` segment,
 *   also after `--flag=`) must stay inside the pipeline's folder or the job's
 *   files folder.
 * - `{files}` is replaced with the job's files folder.
 */

import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { PipelineConfig } from "./config.ts";

export const FILES_PLACEHOLDER = "{files}";
const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 4000;

/** A request that can't run: the message says why, for the caller to fix. */
export class PipelineError extends Error {}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The path an argument names, if it looks like one; resolved against the pipeline's folder. */
function pathOf(arg: string, dir: string): string | null {
  const value = arg.startsWith("-") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
  if (value.startsWith("~")) return resolve(homedir(), value.slice(1).replace(/^\/+/, ""));
  if (isAbsolute(value)) return resolve(value);
  if (value.split(/[\\/]/).includes("..")) return resolve(dir, value);
  return null;
}

/** The full command line (program first) for these arguments. Throws PipelineError when they can't run. */
export function buildArgv(p: PipelineConfig, args: unknown, filesDir?: string): string[] {
  if (!Array.isArray(args) || !args.length) throw new PipelineError("args must be a non-empty list, e.g. [\"next\", \"aiko\"]");
  if (args.length > MAX_ARGS) throw new PipelineError(`at most ${MAX_ARGS} arguments`);
  const out: string[] = [];
  for (const a of args) {
    if (typeof a !== "string") throw new PipelineError("every argument must be a string");
    if (a.length > MAX_ARG_LENGTH || a.includes("\0")) throw new PipelineError("argument too long or not text");
    out.push(a);
  }
  if (!p.allow.includes(out[0])) {
    throw new PipelineError(`"${out[0]}" isn't allowed for ${p.name} (allowed: ${p.allow.join(", ")})`);
  }
  const filled = out.map((a) => {
    if (!a.includes(FILES_PLACEHOLDER)) return a;
    if (!filesDir) throw new PipelineError(`${FILES_PLACEHOLDER} needs files (files: "last_reply", "last_mine" or message ids)`);
    return a.split(FILES_PLACEHOLDER).join(filesDir);
  });
  const roots = [p.dir, ...(filesDir ? [filesDir] : [])];
  for (const a of filled) {
    const path = pathOf(a, p.dir);
    if (path && !roots.some((r) => inside(r, path))) {
      throw new PipelineError(`path outside ${p.name}'s folder: ${a}`);
    }
  }
  const json = p.json && !filled.includes(p.json) ? [p.json] : [];
  return [...p.command, ...filled, ...json];
}
