/**
 * After a plan merges into Choomfie's own repo: bring the running checkout up
 * to date and restart on it, so the change is live without anyone at the Mac.
 *
 * Only a plain fast-forward of a clean checkout on the default branch; anything
 * else (another branch checked out, local edits to tracked files) is left
 * alone and reported. The restart waits until no task, review or brain turn
 * is running here, then the daemon waits for its own sessions' turns.
 */

import { join } from "node:path";
import { isDaemonOwnedProcess } from "@choomfie/shared";
import { requestDaemonControl } from "./daemon-status.ts";
import { runCommand, type Runner } from "./patch-pr.ts";

/** The checkout this worker runs from (packages/core/lib → repo root). */
export const RUNNING_CHECKOUT = join(import.meta.dir, "..", "..", "..");

const tryRun = (run: Runner, cmd: string[], cwd?: string) => run(cmd, cwd).then((out) => out.trim(), () => null);

export type SelfUpdate = { kind: "other-repo" } | { kind: "pulled"; from: string; to: string } | { kind: "skipped"; why: string };

/** Fast-forward the running checkout if it's `repo`'s clone. */
export async function pullRunningCheckout(repo: string, run: Runner = runCommand, dir = RUNNING_CHECKOUT): Promise<SelfUpdate> {
  // The configured URL, not get-url's (which applies url.insteadOf rewrites).
  const url = await tryRun(run, ["git", "config", "--get", "remote.origin.url"], dir);
  const name = url?.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i)?.[1];
  if (!name || name.toLowerCase() !== repo.toLowerCase()) return { kind: "other-repo" };
  const branch = await tryRun(run, ["git", "rev-parse", "--abbrev-ref", "HEAD"], dir);
  const base = (await tryRun(run, ["git", "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], dir))?.replace(/^origin\//, "") || "main";
  if (branch !== base) return { kind: "skipped", why: `the running checkout is on \`${branch}\`, not \`${base}\`` };
  if (await tryRun(run, ["git", "status", "--porcelain", "--untracked-files=no"], dir)) {
    return { kind: "skipped", why: "the running checkout has local changes" };
  }
  const from = (await run(["git", "rev-parse", "--short", "HEAD"], dir)).trim();
  try {
    await run(["git", "-c", "core.hooksPath=/dev/null", "pull", "-q", "--ff-only", "origin", base], dir);
  } catch (e) {
    return { kind: "skipped", why: `\`git pull --ff-only\` failed: ${e instanceof Error ? e.message : e}`.slice(0, 300) };
  }
  const to = (await run(["git", "rev-parse", "--short", "HEAD"], dir)).trim();
  return { kind: "pulled", from, to };
}

/**
 * Restart the daemon once `idle()` holds (checked every `everyMs`, given up
 * after `maxMs`). Foreground mode can't restart itself: false.
 */
export async function restartWhenIdle(
  dataDir: string,
  location: string,
  idle: () => boolean,
  { everyMs = 30_000, maxMs = 6 * 3600_000, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)) } = {}
): Promise<boolean> {
  if (!isDaemonOwnedProcess()) return false;
  const started = Date.now();
  while (!idle()) {
    if (Date.now() - started > maxMs) return false;
    await sleep(everyMs);
  }
  await requestDaemonControl(dataDir, "restart", { location, requestedBy: "plan merge" });
  return true;
}
