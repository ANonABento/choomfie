import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPatch, namedPatch, openDraftPr, runCommand, taskBranch, validBranch, type Runner } from "../lib/patch-pr.ts";
import { researchOutcome } from "../lib/brain-router.ts";

const f = (name: string, data = new Uint8Array()) => ({ name, data });
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "t";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "t@t";

/** A local "GitHub": a bare origin with edit.txt, gone.txt; plus a patch editing/adding/deleting/binary. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "relay-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, work]);
  writeFileSync(join(work, "edit.txt"), "one\n");
  writeFileSync(join(work, "gone.txt"), "bye\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "base");
  git(work, "push", "-q", "origin", "HEAD:main");
  writeFileSync(join(work, "edit.txt"), "two\n");
  writeFileSync(join(work, "added.txt"), "new\n");
  unlinkSync(join(work, "gone.txt"));
  writeFileSync(join(work, "img.bin"), Buffer.from([0, 1, 2, 255, 0, 9]));
  git(work, "add", "-A");
  const patch = execFileSync("git", ["diff", "--cached", "--binary"], { cwd: work });
  // A run that maps gh to the local origin; git runs for real.
  const run: Runner = async (cmd, cwd) => {
    if (cmd[0] !== "gh") return runCommand(cmd, cwd);
    if (cmd[2] === "clone") return runCommand(["git", "clone", "-q", origin, cmd[4]]);
    return cmd[1] === "pr" ? "https://github.com/a/b/pull/1" : "";
  };
  return { root, origin, patch: new Uint8Array(patch), run };
}

describe("relay picks the patch by name", () => {
  test("the named patch is used; a second patch in the folder is ignored", () => {
    const files = [f("chunk-fences.patch"), f("relay.patch")];
    expect(findPatch("Done.\n[relay.patch](/x)\nrepo: a/b", files)?.file.name).toBe("relay.patch");
    expect(findPatch("Done.\n[chunk-fences.patch](/x)\nrepo: a/b", [...files].reverse())?.file.name).toBe("chunk-fences.patch");
  });

  test("an unnamed or missing patch is rejected with a reason", () => {
    expect(findPatch("Done.\nrepo: a/b", [f("a.patch")])).toBeNull();
    expect(namedPatch([f("a.patch")], "Done.")).toEqual({ error: expect.stringMatching(/doesn't name its patch/) });
    expect(namedPatch([f("a.patch")], "see b.patch")).toEqual({ error: expect.stringMatching(/names b\.patch, but no such patch/) });
    expect(namedPatch([], "x")).toEqual({ error: "no .patch/.diff came back" });
  });
});

describe("task branch names", () => {
  test("a fix/, feat/ or waymond/ branch from the task is used; bad prefixes and main are refused", () => {
    expect(taskBranch("on a new branch `fix/relay-patch-select` with a PR")).toBe("fix/relay-patch-select");
    expect(taskBranch("branch: feat/x")).toBe("feat/x");
    expect(taskBranch("on branch `main`")).toBeUndefined();
    expect(taskBranch("on branch `hotfix/x`")).toBeUndefined();
    expect(validBranch("main")).toBe(false);
    expect(validBranch("fix/a..b")).toBe(false);
    expect(validBranch("fix/dev", "fix/dev")).toBe(false);
    expect(findPatch("Done. branch `fix/y`\n[p.patch](/x)\nrepo: a/b", [f("p.patch")])?.branch).toBe("fix/y");
    expect(findPatch("Done. branch `main`\n[p.patch](/x)\nrepo: a/b", [f("p.patch")])?.branch).toBeUndefined();
  });
});

describe("openDraftPr with real git", () => {
  test("an edit, an add, a delete and a binary file land in one commit on the task's branch", async () => {
    const { root, origin, patch, run } = fixture();
    try {
      const offer = { repo: "a/b", file: f("x.patch", patch), title: "Relay", body: "b", branch: "fix/relay" };
      expect((await openDraftPr(offer, run)).url).toBe("https://github.com/a/b/pull/1");
      expect(git(origin, "rev-list", "--count", "main..fix/relay")).toBe("1");
      const names = git(origin, "diff", "--name-status", "main", "fix/relay").split("\n").sort();
      expect(names).toEqual(["A\tadded.txt", "A\timg.bin", "D\tgone.txt", "M\tedit.txt"]);
      expect([...execFileSync("git", ["show", "fix/relay:img.bin"], { cwd: origin })]).toEqual([0, 1, 2, 255, 0, 9]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("without a valid task branch the generated waymond/ name is used, never main", async () => {
    const { root, origin, patch, run } = fixture();
    try {
      await openDraftPr({ repo: "a/b", file: f("x.patch", patch), title: "Relay", body: "b", branch: "main" }, run);
      expect(git(origin, "rev-list", "--count", "main")).toBe("1");
      expect(git(origin, "branch", "--list", "waymond/relay-*")).toMatch(/waymond\/relay-/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a patch that doesn't apply cleanly is rejected and nothing is pushed", async () => {
    const { root, origin, patch, run } = fixture();
    try {
      const stale = new TextDecoder().decode(patch).replace("-one", "-uno");
      await expect(openDraftPr({ repo: "a/b", file: f("x.patch", new TextEncoder().encode(stale)), title: "R", body: "b", branch: "fix/r" }, run)).rejects.toThrow(/doesn't apply/);
      expect(git(origin, "branch", "--list", "fix/r")).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("research task status", () => {
  const spec = "[research] Audit. Write research/push/report.md.";
  test("done when the named report exists and isn't empty, even with no files back", () => {
    expect(researchOutcome(spec, "", (p) => (p === "research/push/report.md" ? "# Report" : undefined))).toEqual({ ok: true, path: "research/push/report.md" });
  });
  test("failed when the report is missing or empty", () => {
    expect(researchOutcome(spec, "", () => undefined).ok).toBe(false);
    expect(researchOutcome(spec, "", () => "\n").ok).toBe(false);
  });
});
