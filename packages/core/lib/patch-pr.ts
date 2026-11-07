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

export interface PatchOffer {
  /** `owner/name` on GitHub. */
  repo: string;
  file: BrainFile;
  /** PR title, from the answer's first line. */
  title: string;
  /** PR body: the answer, as the brain wrote it. */
  body: string;
}

const REPO_LINE = /^[\s>*_-]*repo:?\**\s*`?(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?`?\s*$/im;
const SAFE_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A patch the answer offers, or null: needs both a `.patch`/`.diff` file and a `repo:` line. */
export function findPatch(text: string, files: BrainFile[] | undefined): PatchOffer | null {
  const file = files?.find((f) => /\.(patch|diff)$/i.test(f.name));
  const repo = REPO_LINE.exec(text)?.[1];
  if (!file || !repo || !SAFE_REPO.test(repo) || repo.includes("..")) return null;
  const first = text
    .split("\n")
    .map((l) => l.replace(/[*_`#>]/g, "").trim())
    .find((l) => l && !/^repo:/i.test(l));
  const title = (first ?? file.name.replace(/\.(patch|diff)$/i, "")).slice(0, 72);
  return { repo, file, title, body: text };
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
  const proc = Bun.spawn(cmd, {
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

/** Apply the patch on a new branch and open a draft PR. Returns the PR URL. */
export async function openDraftPr(offer: PatchOffer, run: Runner = runCommand): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "choomfie-pr-"));
  const repoDir = join(dir, "repo");
  const patchPath = join(dir, "change.patch");
  const noHooks = ["-c", "core.hooksPath=/dev/null"];
  try {
    writeFileSync(patchPath, offer.file.data);
    await run(["gh", "repo", "clone", offer.repo, repoDir, "--", "--depth", "1", "-q"]);
    const branch = branchName(offer.title);
    await run(["git", "checkout", "-q", "-b", branch], repoDir);
    try {
      await run(["git", "apply", "--index", "--whitespace=nowarn", patchPath], repoDir);
    } catch (e) {
      throw new Error(`the patch doesn't apply to ${offer.repo}'s default branch (it may have moved on): ${e instanceof Error ? e.message : e}`);
    }
    await run(["git", ...noHooks, "commit", "-q", "-m", offer.title, "-m", "Patch written by Waymond, opened from Discord."], repoDir);
    await run(["git", ...noHooks, "push", "-q", "-u", "origin", branch], repoDir);
    const body = `${offer.body.slice(0, 60_000)}\n\n---\nWritten by Waymond in its sandbox and opened from Discord as a draft. Review before merging.`;
    return await run(
      ["gh", "pr", "create", "--repo", offer.repo, "--head", branch, "--draft", "--title", offer.title, "--body", body],
      repoDir
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
