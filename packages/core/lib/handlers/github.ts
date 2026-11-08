/**
 * Shared GitHub CLI helper — used by both MCP tool and slash command.
 */

import { which } from "../which.ts";

const GH_TIMEOUT_MS = 15_000;

/** Build gh CLI args from a command + optional repo */
export function buildGhArgs(
  command: string,
  repo?: string | null
): string[] | null {
  const repoArgs = repo ? ["-R", repo] : [];

  switch (command) {
    case "prs":
      return ["pr", "list", "--state=open", "--limit=10", ...repoArgs];
    case "issues":
      return ["issue", "list", "--state=open", "--limit=10", ...repoArgs];
    case "notifications":
      return ["api", "/notifications", "--jq", ".[].subject.title"];
    case "pr_status":
      return ["pr", "status", ...repoArgs];
    default:
      return null;
  }
}

/** Run gh CLI and return stdout/stderr output */
export async function runGh(args: string[]): Promise<string> {
  const proc = Bun.spawn([which("gh"), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const timeout = setTimeout(() => proc.kill(), GH_TIMEOUT_MS);

  try {
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    return stdout.trim() || stderr.trim() || "(no results)";
  } finally {
    clearTimeout(timeout);
  }
}
