/**
 * One branch per plan. A plan's repo tasks (Waymond in `code`/`debug` mode)
 * run in sandboxes that keep nothing and can't read a private repo, so this Mac
 * holds the real work: a local clone on `plan/<name>`. Each task gets that
 * branch as a git bundle attachment, works on it, and hands back a patch,
 * which is committed and pushed here. The first commit opens one draft PR for
 * the whole plan.
 *
 * Like patch-pr.ts, nothing from a patch is executed here: `git apply`,
 * commit with hooks off, push. Review and CI happen on the PR.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, type Runner } from "./patch-pr.ts";

export interface PlanBranch {
  /** `owner/name`. */
  repo: string;
  branch: string;
  /** Local clone, checked out on `branch`. */
  dir: string;
  /** The repo didn't exist, so it was created (private) for this plan. */
  created: boolean;
  /** The plan's draft PR, once the first task landed. */
  prUrl?: string;
}

const SAFE_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

export function planBranchName(repo: string, now = Date.now()): string {
  const name = repo.split("/")[1].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
  return `plan/${name || "work"}-${now.toString(36)}`;
}

/** Clone (or create, private) `repo` under `root` and start `branch` from its default branch, pushed. */
export async function openPlanBranch(repo: string, root: string, run: Runner = runCommand, now = Date.now()): Promise<PlanBranch> {
  if (!SAFE_REPO.test(repo) || repo.includes("..")) throw new Error(`not a GitHub repo name: ${repo}`);
  const branch = planBranchName(repo, now);
  mkdirSync(root, { recursive: true });
  const dir = join(root, `${repo.replace("/", "__")}-${now.toString(36)}`);
  const exists = await run(["gh", "repo", "view", repo, "--json", "name"]).then(
    () => true,
    () => false
  );
  if (exists) {
    await run(["gh", "repo", "clone", repo, dir, "--", "-q"]);
    // An empty repo has no commit to branch from.
    const empty = await run(["git", "rev-parse", "-q", "--verify", "HEAD"], dir).then(
      () => false,
      () => true
    );
    if (empty) await run(["git", ...NO_HOOKS, "commit", "-q", "--allow-empty", "-m", "Start"], dir);
  } else {
    await run(["gh", "repo", "create", repo, "--private"]);
    await run(["git", "init", "-q", "-b", "main", dir]);
    await run(["git", "remote", "add", "origin", `https://github.com/${repo}.git`], dir);
    await run(["git", ...NO_HOOKS, "commit", "-q", "--allow-empty", "-m", "Start"], dir);
    await run(["git", ...NO_HOOKS, "push", "-q", "-u", "origin", "main"], dir);
  }
  await run(["git", "checkout", "-q", "-b", branch], dir);
  await run(["git", ...NO_HOOKS, "push", "-q", "-u", "origin", branch], dir);
  return { repo, branch, dir, created: !exists };
}

/** The branch as a git bundle (with HEAD, so it clones checked out), for a task's sandbox. */
export async function bundlePlanBranch(pb: PlanBranch, run: Runner = runCommand): Promise<{ path: string; cleanup(): void }> {
  const out = mkdtempSync(join(tmpdir(), "choomfie-bundle-"));
  const path = join(out, `${pb.repo.split("/")[1]}.bundle`);
  await run(["git", "bundle", "create", "-q", path, "HEAD", pb.branch], pb.dir);
  return { path, cleanup: () => rmSync(out, { recursive: true, force: true }) };
}

export interface Landed {
  commitUrl: string;
  /** Set when this landing opened the plan's PR. */
  prOpened?: string;
}

/** Commit a task's patch on the plan branch and push. Throws when it doesn't apply or changes nothing. */
export async function landPatch(
  pb: PlanBranch,
  patch: Uint8Array,
  title: string,
  run: Runner = runCommand
): Promise<Landed> {
  if (!existsSync(pb.dir)) throw new Error(`the plan's clone is gone (${pb.dir})`);
  const tmp = mkdtempSync(join(tmpdir(), "choomfie-land-"));
  try {
    const file = join(tmp, "task.patch");
    writeFileSync(file, patch);
    try {
      await run(["git", "apply", "--index", "--whitespace=nowarn", file], pb.dir);
    } catch (e) {
      // Leave the clone clean for the next task.
      await run(["git", "reset", "-q", "--hard"], pb.dir).catch(() => {});
      throw new Error(
        `the patch doesn't apply to ${pb.branch} — it wasn't built on the branch it was given: ${e instanceof Error ? e.message : e}`
      );
    }
    const changed = await run(["git", "diff", "--cached", "--name-only"], pb.dir);
    if (!changed.trim()) throw new Error("the patch changes nothing");
    await run(["git", ...NO_HOOKS, "commit", "-q", "-m", title.slice(0, 72), "-m", "Written by Waymond, committed from Discord."], pb.dir);
    await run(["git", ...NO_HOOKS, "push", "-q", "origin", pb.branch], pb.dir);
    const sha = await run(["git", "rev-parse", "HEAD"], pb.dir);
    const landed: Landed = { commitUrl: `https://github.com/${pb.repo}/commit/${sha.trim()}` };
    if (!pb.prUrl) {
      const base = await run(["gh", "repo", "view", pb.repo, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"]).catch(() => "main");
      pb.prUrl = (
        await run(
          [
            "gh", "pr", "create", "--repo", pb.repo, "--head", pb.branch, "--base", base.trim() || "main", "--draft",
            "--title", `Plan: ${pb.branch.replace(/^plan\//, "")}`,
            "--body", "Each commit is one task of a Waymond plan, run from Discord. Review before merging.",
          ],
          pb.dir
        )
      ).trim();
      landed.prOpened = pb.prUrl;
    }
    return landed;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The prompt line that tells a task where its repo is. */
export function planBranchNote(pb: PlanBranch, bundleName: string): string {
  return (
    `Your repo: ${pb.repo}, branch ${pb.branch}, with every earlier task's work, is attached as ${bundleName} (it's in run_python's working folder). ` +
    `Run setup on that file instead of the GitHub name: \`bash /tmp/swe.sh setup ${bundleName}\` — the repo is private, so cloning it from GitHub fails. ` +
    `Finish as usual (diff → patch link, \`repo: ${pb.repo}\`); Choomfie commits your patch to the branch, so it must be built on exactly this bundle.`
  );
}
