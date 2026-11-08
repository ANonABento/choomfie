/**
 * One branch per plan. A plan's repo tasks (Waymond in `code`/`debug` mode)
 * run in sandboxes that keep nothing and can't read a private repo, so this Mac
 * holds the real work: a local clone on `plan/<name>`. Each task gets that
 * branch as a git bundle attachment, works on it, and hands back a patch,
 * which is committed and pushed here. The first commit opens one draft PR for
 * the whole plan.
 *
 * GitHub's copy of the branch is the truth: before every bundle and every
 * commit the clone is reset to it (so a push you made from elsewhere is
 * picked up, and a commit whose push failed never lingers). Git work on one
 * clone runs one at a time.
 *
 * Like patch-pr.ts, nothing from a patch is executed here: `git apply`,
 * commit with hooks off, push. Review and CI happen on the PR.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainFile } from "@choomfie/shared";
import { runCommand, type Runner } from "./patch-pr.ts";

export interface PlanBranch {
  /** `owner/name`. */
  repo: string;
  branch: string;
  /** Local clone, checked out on `branch`. Re-cloned if it goes missing. */
  dir: string;
  /** The repo didn't exist, so it was created (private) for this plan. */
  created: boolean;
  /** The plan's draft PR, once the first task landed. */
  prUrl?: string;
}

const SAFE_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];
const CAN_PUSH = new Set(["ADMIN", "MAINTAIN", "WRITE"]);
/** Above this a bundle carries only the current files, not the history. */
export const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;

/** One git operation per clone at a time (two tasks landing at once share it). */
const locks = new Map<string, Promise<unknown>>();
function locked<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(dir) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(dir, tail);
  void tail.then(() => locks.get(dir) === tail && locks.delete(dir));
  return run;
}

export function planBranchName(repo: string, now = Date.now()): string {
  const name = repo.split("/")[1].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
  return `plan/${name || "work"}-${now.toString(36)}`;
}

const tryRun = (run: Runner, cmd: string[], cwd?: string) => run(cmd, cwd).then((out) => out, () => null);

/**
 * Clone (or create, private) `repo` under `root` and start a plan branch from
 * its default branch, pushed. Refuses a repo you can't push to before any
 * work is done.
 */
export async function openPlanBranch(repo: string, root: string, run: Runner = runCommand, now = Date.now()): Promise<PlanBranch> {
  if (!SAFE_REPO.test(repo) || repo.includes("..")) throw new Error(`not a GitHub repo name: ${repo}`);
  const branch = planBranchName(repo, now);
  mkdirSync(root, { recursive: true });
  const dir = join(root, `${repo.replace("/", "__")}-${now.toString(36)}`);
  const view = await tryRun(run, ["gh", "repo", "view", repo, "--json", "viewerPermission", "-q", ".viewerPermission"]);
  const exists = view !== null;
  if (exists && !CAN_PUSH.has(view.trim())) {
    throw new Error(`your GitHub account can't push to ${repo} (permission: ${view.trim() || "none"}) — fork it and name the fork in the plan`);
  }
  if (exists) {
    await run(["gh", "repo", "clone", repo, dir, "--", "-q"]);
    // An empty repo has no commit to branch from, and no default branch for the PR.
    if ((await tryRun(run, ["git", "rev-parse", "-q", "--verify", "HEAD"], dir)) === null) {
      await run(["git", ...NO_HOOKS, "commit", "-q", "--allow-empty", "-m", "Start"], dir);
      await run(["git", ...NO_HOOKS, "push", "-q", "-u", "origin", "HEAD"], dir);
    }
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

/** Make the clone match GitHub's branch exactly, re-cloning it if it's gone. */
async function syncClone(pb: PlanBranch, run: Runner): Promise<void> {
  if (!existsSync(join(pb.dir, ".git"))) {
    rmSync(pb.dir, { recursive: true, force: true });
    await run(["gh", "repo", "clone", pb.repo, pb.dir, "--", "-q"]);
  }
  try {
    await run(["git", "fetch", "-q", "origin", `+refs/heads/${pb.branch}:refs/remotes/origin/${pb.branch}`], pb.dir);
  } catch (e) {
    throw new Error(`couldn't fetch ${pb.branch} from ${pb.repo} (deleted on GitHub?): ${e instanceof Error ? e.message : e}`);
  }
  await run(["git", "checkout", "-q", "-B", pb.branch, `origin/${pb.branch}`], pb.dir);
  await run(["git", "reset", "-q", "--hard", `origin/${pb.branch}`], pb.dir);
  await run(["git", "clean", "-qfdx"], pb.dir);
}

/**
 * The branch as a git bundle for a task's sandbox. With history when it's
 * small; a big repo gets one commit holding the current files (the task's
 * patch applies the same either way).
 */
export async function bundlePlanBranch(
  pb: PlanBranch,
  run: Runner = runCommand,
  maxBytes = MAX_BUNDLE_BYTES
): Promise<{ path: string; snapshot: boolean; cleanup(): void }> {
  return locked(pb.dir, async () => {
    await syncClone(pb, run);
    const out = mkdtempSync(join(tmpdir(), "choomfie-bundle-"));
    const cleanup = () => rmSync(out, { recursive: true, force: true });
    try {
      const path = join(out, `${pb.repo.split("/")[1]}.bundle`);
      await run(["git", "bundle", "create", "-q", path, "HEAD", pb.branch], pb.dir);
      if (statSync(path).size <= maxBytes) return { path, snapshot: false, cleanup };
      const snap = (await run(["git", "commit-tree", "HEAD^{tree}", "-m", `${pb.branch} as of now`], pb.dir)).trim();
      const ref = "refs/heads/choomfie-snapshot";
      await run(["git", "update-ref", ref, snap], pb.dir);
      try {
        rmSync(path);
        await run(["git", "bundle", "create", "-q", path, ref], pb.dir);
      } finally {
        await tryRun(run, ["git", "update-ref", "-d", ref], pb.dir);
      }
      return { path, snapshot: true, cleanup };
    } catch (e) {
      cleanup();
      throw e;
    }
  });
}

export interface Landed {
  commitUrl: string;
  /** Set when this landing opened the plan's PR. */
  prOpened?: string;
  /** The commit landed, but the PR couldn't be opened (said, not thrown). */
  prError?: string;
}

/**
 * Stage a change on the synced clone (`stage` does `git add` itself), commit
 * and push it. Throws when staging fails, nothing changed, or it won't push —
 * and then the clone is back on GitHub's branch, as if nothing happened.
 */
async function landChange(
  pb: PlanBranch,
  title: string,
  run: Runner,
  stage: (tmp: string) => Promise<void>,
  nothing: string
): Promise<Landed> {
  return locked(pb.dir, async () => {
    await syncClone(pb, run);
    const tmp = mkdtempSync(join(tmpdir(), "choomfie-land-"));
    try {
      await stage(tmp);
      if (!(await run(["git", "diff", "--cached", "--name-only"], pb.dir)).trim()) throw new Error(nothing);
      await run(["git", ...NO_HOOKS, "commit", "-q", "-m", title.slice(0, 72), "-m", "Written by Waymond, committed from Discord."], pb.dir);
      const push = () => run(["git", ...NO_HOOKS, "push", "-q", "origin", `HEAD:refs/heads/${pb.branch}`], pb.dir);
      try {
        await push();
      } catch {
        await push(); // one retry: a dropped connection
      }
      await run(["git", "fetch", "-q", "origin", `+refs/heads/${pb.branch}:refs/remotes/origin/${pb.branch}`], pb.dir);
      const sha = (await run(["git", "rev-parse", "HEAD"], pb.dir)).trim();
      const landed: Landed = { commitUrl: `https://github.com/${pb.repo}/commit/${sha}` };
      if (!pb.prUrl) {
        try {
          pb.prUrl = await openPlanPr(pb, run);
          landed.prOpened = pb.prUrl;
        } catch (e) {
          landed.prError = e instanceof Error ? e.message : String(e);
        }
      }
      return landed;
    } catch (e) {
      await tryRun(run, ["git", "reset", "-q", "--hard", `origin/${pb.branch}`], pb.dir);
      await tryRun(run, ["git", "clean", "-qfdx"], pb.dir);
      throw e;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

/** Commit a task's patch on the plan branch and push. Throws when it doesn't apply, changes nothing, or won't push. */
export function landPatch(pb: PlanBranch, patch: Uint8Array, title: string, run: Runner = runCommand): Promise<Landed> {
  return landChange(
    pb,
    title,
    run,
    async (tmp) => {
      if (!patch.length) throw new Error("the patch is empty");
      const file = join(tmp, "task.patch");
      writeFileSync(file, patch);
      try {
        await run(["git", "apply", "--index", "--binary", "--whitespace=nowarn", file], pb.dir);
      } catch (e) {
        throw new Error(`the patch doesn't apply to ${pb.branch} — it wasn't built on the branch it was given: ${e instanceof Error ? e.message : e}`);
      }
    },
    "the patch changes nothing"
  );
}

/** Previews and renders: kept apart from the part files. */
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

/** A file name that's safe to write into the repo: its last path part, no dot files or traversal. */
export function safeFileName(name: string): string | null {
  const base = name.split(/[\\/]/).pop()!.trim();
  return base && !base.startsWith(".") && /^[\w .()+-]+$/.test(base) ? base : null;
}

/**
 * Commit a CAD / 3D task's files into `folder/` on the plan branch (renders
 * in `folder/renders/`); a file of the same name is replaced. Throws when
 * there is nothing to commit.
 */
export function landFiles(pb: PlanBranch, files: BrainFile[], folder: string, title: string, run: Runner = runCommand): Promise<Landed> {
  return landChange(
    pb,
    title,
    run,
    async () => {
      const written: string[] = [];
      for (const f of files) {
        const name = safeFileName(f.name);
        if (!name || /\.(patch|diff)$/i.test(name)) continue;
        const rel = IMAGE.test(name) ? join(folder, "renders", name) : join(folder, name);
        mkdirSync(join(pb.dir, rel, ".."), { recursive: true });
        writeFileSync(join(pb.dir, rel), f.data);
        written.push(rel);
      }
      if (!written.length) throw new Error("no files came back to commit");
      // The repo's .gitignore wins (it may keep STLs out on purpose).
      const ignored = new Set(((await tryRun(run, ["git", "check-ignore", "--", ...written], pb.dir)) ?? "").split("\n").filter(Boolean));
      const keep = written.filter((f) => !ignored.has(f));
      if (!keep.length) throw new Error(`the repo's .gitignore excludes every file that came back (${written.join(", ")})`);
      await run(["git", "add", "--", ...keep], pb.dir);
    },
    "the files are the same as on the branch already"
  );
}

/**
 * Delete plan clones nothing uses any more: not in `keep` and untouched for
 * a day (so a branch being opened right now is left alone). A clone is only
 * a cache — the branch on GitHub is the work.
 */
export function pruneClones(root: string, keep: Set<string>, now = Date.now(), minAgeMs = 24 * 3600_000): string[] {
  if (!existsSync(root)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      if (keep.has(dir) || now - statSync(dir).mtimeMs < minAgeMs) continue;
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // gone already, or not ours to read
    }
  }
  return removed;
}

/** The plan's draft PR: an open one for the branch if there is one, else a new one. */
async function openPlanPr(pb: PlanBranch, run: Runner): Promise<string> {
  const open = (await tryRun(run, ["gh", "pr", "list", "--repo", pb.repo, "--head", pb.branch, "--state", "open", "--json", "url", "-q", ".[0].url"]))?.trim();
  if (open) return open;
  const base = (await tryRun(run, ["gh", "repo", "view", pb.repo, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"]))?.trim() || "main";
  const url = await run(
    [
      "gh", "pr", "create", "--repo", pb.repo, "--head", pb.branch, "--base", base, "--draft",
      "--title", `Plan: ${pb.branch.replace(/^plan\//, "")}`,
      "--body", "Each commit is one task of a Waymond plan, run from Discord. Review before merging.",
    ],
    pb.dir
  );
  return url.trim();
}

/**
 * The patch a reply hands back: a `.patch`/`.diff`, preferring the final one
 * over a saved work-in-progress (`wip.patch`), and the last one named.
 */
export function pickPatch(files: BrainFile[] | undefined): BrainFile | undefined {
  const patches = (files ?? []).filter((f) => /\.(patch|diff)$/i.test(f.name));
  const final = patches.filter((f) => !/(^|[^a-z])wip([^a-z]|$)/i.test(f.name));
  return (final.length ? final : patches).at(-1);
}

/** The prompt line for a CAD / 3D task in a plan with a repo: where its files go, and the repo if it needs earlier ones. */
export function planFilesNote(pb: PlanBranch, bundleName: string, folder: string): string {
  return (
    `This plan's repo is ${pb.repo} (branch ${pb.branch}); every file you link in your reply is committed to its ${folder}/ folder ` +
    `(images to ${folder}/renders/), replacing files of the same name — so link the source and exports, not scratch files. ` +
    `The repo so far is attached as ${bundleName} in run_python's working folder; if you need earlier files (to edit a part, or fit to one), ` +
    `apt-get install -y git and git clone ${bundleName} /tmp/repo — keep an edited file's name.`
  );
}

/** The prompt line that tells a task where its repo is. */
export function planBranchNote(pb: PlanBranch, bundleName: string, snapshot = false): string {
  return (
    `Your repo: ${pb.repo}, branch ${pb.branch}, with every earlier task's work${snapshot ? " (current files only, no history: the repo is large)" : ""}, ` +
    `is attached as ${bundleName} (it's in run_python's working folder). ` +
    `Run setup on that file instead of the GitHub name: \`bash /tmp/swe.sh setup ${bundleName}\` — the repo is private, so cloning it from GitHub fails. ` +
    `Finish as usual (diff → patch link, \`repo: ${pb.repo}\`); Choomfie commits your patch to the branch, so it must be built on exactly this bundle.`
  );
}
