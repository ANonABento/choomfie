/**
 * Patch → draft pull request. A brain working in its own sandbox (Waymond in
 * `/mode code`) hands back a `.patch` file and a `repo: owner/name` line; the
 * answer then carries an "Open draft PR" button for the owner.
 *
 * Opening the PR runs on this Mac, so it does as little as possible with
 * outside input: a fresh shallow clone in a temp dir, `git apply`, commit,
 * push to a new branch, `gh pr create --draft`. Nothing from the patch is
 * executed — no tests, no install, and git hooks are off — and nothing lands
 * on the default branch: review and CI happen on the PR.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainFile } from "@choomfie/shared";
import { which } from "./which.ts";

export interface PatchOffer {
  /** `owner/name` on GitHub. */
  repo: string;
  file: BrainFile;
  /** PR title, from the answer's first line. */
  title: string;
  /** PR body: the answer, as the brain wrote it. */
  body: string;
  /** Branch the task asked for (`fix/`, `feat/` or `waymond/`), else a generated `waymond/<slug>-<ts>`. */
  branch?: string;
}

const PATCH_FILE = /\.(patch|diff)$/i;
const base = (name: string) => name.split(/[\\/]/).pop()!;

/**
 * The patch a reply names, by file name - never by position. Patch files the
 * text doesn't name are ignored; when it names several, the last non-wip one
 * wins. No named patch, or a name with no such file, is an error.
 */
export function namedPatch(files: BrainFile[] | undefined, text: string): { file: BrainFile } | { error: string } {
  const patches = (files ?? []).filter((f) => PATCH_FILE.test(f.name));
  const at = (f: BrainFile) => text.lastIndexOf(base(f.name));
  const named = patches.filter((f) => at(f) >= 0).sort((a, b) => at(a) - at(b));
  const final = named.filter((f) => !/(^|[^a-z])wip([^a-z]|$)/i.test(base(f.name)));
  const file = (final.length ? final : named).at(-1);
  if (file) return { file };
  const said = text.match(/[\w.-]+\.(?:patch|diff)\b/i)?.[0];
  if (said) return { error: `the reply names ${said}, but no such patch came back` };
  return {
    error: patches.length
      ? `the reply doesn't name its patch (got ${patches.map((f) => base(f.name)).join(", ")}; patches aren't picked by position)`
      : "no .patch/.diff came back",
  };
}

const BRANCH_OK = /^(fix|feat|waymond)\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** A task-given branch name is used only under fix/, feat/ or waymond/ - never main or the default branch. */
export function validBranch(name: string, defaultBranch = "main"): boolean {
  return BRANCH_OK.test(name) && !name.includes("..") && !name.endsWith(".lock") && name !== defaultBranch && name !== "main";
}

/** The branch a task's text asks for ("branch `fix/x`"), if it is a valid one. */
export function taskBranch(text: string): string | undefined {
  const m = text.match(/\bbranch\b[^`\n]{0,24}`([^`\s]+)`/i) ?? text.match(/\bbranch:?\s+((?:fix|feat|waymond)\/[\w.\/-]+)/i);
  const name = m?.[1].replace(/[.,;:]+$/, "");
  return name && validBranch(name) ? name : undefined;
}

const REPO_LINE = /^[\s>*_-]*repo:?\**\s*`?(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?`?\s*$/im;
const SAFE_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A patch the answer offers, or null: needs both a `.patch`/`.diff` file and a `repo:` line. */
export function findPatch(text: string, files: BrainFile[] | undefined): PatchOffer | null {
  const picked = namedPatch(files, text);
  const file = "file" in picked ? picked.file : undefined;
  const repo = REPO_LINE.exec(text)?.[1];
  if (!file || !repo || !SAFE_REPO.test(repo) || repo.includes("..")) return null;
  const first = text
    .split("\n")
    .map((l) => l.replace(/[*_`#>]/g, "").trim())
    .find((l) => l && !/^repo:/i.test(l));
  const title = (first ?? file.name.replace(/\.(patch|diff)$/i, "")).slice(0, 72);
  const branch = taskBranch(text);
  return { repo, file, title, body: text, ...(branch ? { branch } : {}) };
}

/** Button message id → the patch it offers. In memory: a restart expires them. */
const pending = new Map<string, PatchOffer>();

export function offerPatch(messageId: string, offer: PatchOffer): void {
  pending.set(messageId, offer);
}

export function takePatch(messageId: string): PatchOffer | undefined {
  const p = pending.get(messageId);
  pending.delete(messageId);
  return p;
}

/** Run a command; throws with its output on failure. Injected in tests. */
export type Runner = (cmd: string[], cwd?: string) => Promise<string>;

export const runCommand: Runner = async (cmd, cwd) => {
  const proc = Bun.spawn([which(cmd[0]), ...cmd.slice(1)], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const timer = setTimeout(() => proc.kill(), 90_000);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed: ${(err || out).trim().slice(-400)}`);
  return out.trim();
};

export function branchName(title: string, now = Date.now()): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `waymond/${slug || "patch"}-${now.toString(36)}`;
}

export interface Opened {
  url: string;
  /** "pr": a draft PR on an existing repo. "repo": the repo didn't exist, so it was created private with the patch as its first commit. */
  kind: "pr" | "repo";
}

/**
 * Apply the patch on a new branch and open a draft PR. A repo that doesn't
 * exist yet (a plan's new project) is created private, with the patch as its
 * first commit on main — there is nothing to open a PR against. All or
 * nothing: the repo is created only once the patch has committed locally, and
 * a pushed branch is deleted again if the PR can't be opened.
 */
export async function openDraftPr(offer: PatchOffer, run: Runner = runCommand): Promise<Opened> {
  const dir = mkdtempSync(join(tmpdir(), "choomfie-pr-"));
  const repoDir = join(dir, "repo");
  const patchPath = join(dir, "change.patch");
  const noHooks = ["-c", "core.hooksPath=/dev/null"];
  const apply = async () => {
    try {
      await run(["git", "apply", "--index", "--binary", "--whitespace=nowarn", patchPath], repoDir);
    } catch (e) {
      throw new Error(
        `the patch doesn't apply to ${offer.repo}'s default branch — it may build on an earlier task's PR (merge that first): ${e instanceof Error ? e.message : e}`
      );
    }
  };
  try {
    writeFileSync(patchPath, offer.file.data);
    const exists = await run(["gh", "repo", "view", offer.repo, "--json", "name"]).then(
      () => true,
      () => false
    );
    if (!exists) {
      // Commit locally first: a patch that doesn't apply must not leave an empty repo on GitHub.
      await run(["git", "init", "-q", "-b", "main", repoDir]);
      await apply();
      await run(["git", ...noHooks, "commit", "-q", "-m", offer.title, "-m", "Written by Waymond, opened from Discord."], repoDir);
      const url = await run(["gh", "repo", "create", offer.repo, "--private"]);
      await run(["git", "remote", "add", "origin", `https://github.com/${offer.repo}.git`], repoDir);
      await run(["git", ...noHooks, "push", "-q", "-u", "origin", "main"], repoDir);
      return { url: url.trim() || `https://github.com/${offer.repo}`, kind: "repo" };
    }
    await run(["gh", "repo", "clone", offer.repo, repoDir, "--", "--depth", "1", "-q"]);
    const branch = offer.branch && validBranch(offer.branch) ? offer.branch : branchName(offer.title);
    await run(["git", "checkout", "-q", "-b", branch], repoDir);
    await apply();
    await run(["git", ...noHooks, "commit", "-q", "-m", offer.title, "-m", "Patch written by Waymond, opened from Discord."], repoDir);
    await run(["git", ...noHooks, "push", "-q", "-u", "origin", branch], repoDir);
    const body = `${offer.body.slice(0, 60_000)}\n\n---\nWritten by Waymond in its sandbox and opened from Discord as a draft. Review before merging.`;
    try {
      const url = await run(
        ["gh", "pr", "create", "--repo", offer.repo, "--head", branch, "--draft", "--title", offer.title, "--body", body],
        repoDir
      );
      return { url, kind: "pr" };
    } catch (e) {
      // All or nothing: don't leave a pushed branch with no PR behind.
      await run(["git", ...noHooks, "push", "-q", "origin", "--delete", branch], repoDir).catch(() => {});
      throw e;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
