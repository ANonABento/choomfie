/**
 * Pipelines: local command-line tools a brain may run on this machine through
 * `pipeline_run` (a character builder, a renderer, …). Declared by hand in
 * config.json, like `chatRoots`, because each one widens what a chat (and the
 * remote endpoint, if the tools are on its allowlist) can do here:
 *
 *   "pipelines": {
 *     "lochara": {
 *       "dir": "~/lochara",
 *       "command": ["./lochara"],
 *       "allow": ["next", "requests", "concept", "part", "deliver", "build", "check", "render", "export"],
 *       "json": "--json"
 *     }
 *   }
 *
 * - `dir`: where it runs; also the only place path arguments may point (plus a job's files folder).
 * - `command`: the program and fixed leading arguments, run without a shell.
 * - `allow`: the subcommands a caller may pass as the first argument. Nothing else runs.
 * - `json` (optional): a flag that makes the tool print one JSON result on stdout. With it, the
 *   runner reads `show` (pictures to post), `say`/`next` and `ok` from that result.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface PipelineConfig {
  name: string;
  dir: string;
  command: string[];
  allow: string[];
  json?: string;
}

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;

function expandHome(p: string): string {
  return p.startsWith("~") ? (process.env.HOME ?? "") + p.slice(1) : p;
}

/** Valid pipelines from the raw config value, plus one line per entry that was skipped and why. */
export function parsePipelines(raw: unknown): { pipelines: Map<string, PipelineConfig>; problems: string[] } {
  const pipelines = new Map<string, PipelineConfig>();
  const problems: string[] = [];
  if (raw === undefined) return { pipelines, problems };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { pipelines, problems: ["pipelines must be an object of name → { dir, command, allow }"] };
  }
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const v = (value ?? {}) as Record<string, unknown>;
    const skip = (why: string) => problems.push(`pipeline "${name}" skipped: ${why}`);
    if (!NAME.test(name)) {
      skip("name must be lowercase letters, digits, - or _");
      continue;
    }
    const dir = typeof v.dir === "string" ? expandHome(v.dir.trim()) : "";
    if (!isAbsolute(dir) || !existsSync(dir) || !statSync(dir).isDirectory()) {
      skip(`dir must be an existing absolute folder (got ${JSON.stringify(v.dir)})`);
      continue;
    }
    const command = v.command;
    if (!Array.isArray(command) || !command.length || !command.every((c) => typeof c === "string" && c)) {
      skip("command must be a non-empty list of strings");
      continue;
    }
    const allow = v.allow;
    if (!Array.isArray(allow) || !allow.length || !allow.every((a) => typeof a === "string" && /^[\w-]+$/.test(a))) {
      skip("allow must be a non-empty list of subcommand names");
      continue;
    }
    if (v.json !== undefined && (typeof v.json !== "string" || !v.json.startsWith("-"))) {
      skip("json must be a flag, e.g. \"--json\"");
      continue;
    }
    pipelines.set(name, { name, dir, command: command as string[], allow: allow as string[], ...(v.json ? { json: v.json as string } : {}) });
  }
  return { pipelines, problems };
}
