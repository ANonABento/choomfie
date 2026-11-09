import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, type Runner } from "../lib/patch-pr.ts";
import {
  bundlePlanBranch,
  landFiles,
  landPatch,
  openPlanBranch,
  pickPatch,
  planBranchName,
  planBranchNote,
  planFilesNote,
  pruneClones,
  safeFileName,
  type PlanBranch,
} from "../lib/plan-branch.ts";

/**
 * A local stand-in for GitHub: bare repos under <root>/remote, reached through
 * git's url.insteadOf, so clone/fetch/push really run. Only `gh` is faked.
 */
let root: string;
const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "",
  GIT_CONFIG_VALUE_0: "https://github.com/",
};
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "plan-branch-"));
  ENV.GIT_CONFIG_KEY_0 = `url.${join(root, "remote")}/.insteadOf`;
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

const bare = (repo: string) => join(root, "remote", `${repo}.git`);

function fakeGh(opts: { permission?: string; failPr?: boolean; failPush?: number; prState?: string } = {}) {
  const calls: string[] = [];
  let pushFails = opts.failPush ?? 0;
  const run: Runner = async (cmd, cwd) => {
    const line = cmd.join(" ");
    if (cmd[0] === "gh") {
      calls.push(line);
      const repo = cmd[3];
      if (cmd[1] === "repo" && cmd[2] === "view" && cmd.includes(".viewerPermission")) {
        if (!existsSync(bare(repo))) throw new Error("not found");
        return opts.permission ?? "ADMIN";
      }
      if (cmd[1] === "repo" && cmd[2] === "view") return "main";
      if (cmd[1] === "repo" && cmd[2] === "create") {
        mkdirSync(bare(repo), { recursive: true });
        await runCommand(["git", "init", "-q", "--bare", "-b", "main", bare(repo)]);
        return `https://github.com/${repo}`;
      }
      if (cmd[1] === "repo" && cmd[2] === "clone") return runCommand(["git", "clone", "-q", bare(repo), cmd[4]]);
      if (cmd[1] === "pr" && cmd[2] === "list") return "";
      if (cmd[1] === "pr" && cmd[2] === "view") return opts.prState ?? "OPEN";
      if (cmd[1] === "pr" && cmd[2] === "create") {
        if (opts.failPr) throw new Error("gh pr create failed: no commits between main and branch");
        return "https://github.com/x/y/pull/1";
      }
      return "";
    }
    if (cmd.includes("push") && pushFails > 0) {
      pushFails--;
      throw new Error("git push failed: connection reset");
    }
    return runCommand(cmd, cwd);
  };
  return { run, calls };
}

let n = 0;
const repoName = () => `me/r${++n}`;
const enc = (s: string) => new TextEncoder().encode(s);

/** What a task does in its sandbox: clone the bundle, change files, diff (binary-safe, like swe.sh). */
async function workOn(bundle: string, edit: (dir: string) => void): Promise<Uint8Array> {
  const dir = mkdtempSync(join(root, "task-"));
  const r = join(dir, "r");
  await runCommand(["git", "clone", "-q", bundle, r]);
  // A snapshot bundle has no HEAD: check out its branch, as swe.sh does.
  if (!(await runCommand(["git", "rev-parse", "-q", "--verify", "HEAD"], r).then(() => true, () => false))) {
    const b = (await runCommand(["git", "bundle", "list-heads", bundle])).split(/\s+/)[1].replace("refs/heads/", "");
    await runCommand(["git", "checkout", "-q", "-b", b, `origin/${b}`], r);
  }
  edit(r);
  await runCommand(["git", "add", "-A"], r);
  // Raw bytes: a binary patch needs its trailing blank line.
  return Bun.spawnSync(["git", "diff", "--cached", "--binary"], { cwd: r }).stdout;
}

async function task(pb: PlanBranch, run: Runner, edit: (dir: string) => void): Promise<Uint8Array> {
  const b = await bundlePlanBranch(pb, run);
  try {
    return await workOn(b.path, edit);
  } finally {
    b.cleanup();
  }
}

const head = (dir: string, ref = "HEAD") => runCommand(["git", "rev-parse", ref], dir);

describe("plan branch", () => {
  test("a new repo is created private; each task builds on the last; one PR for the plan", async () => {
    const { run, calls } = fakeGh();
    const repo = repoName();
    const pb = await openPlanBranch(repo, join(root, "plans"), run, 1000);
    expect(pb.branch).toBe(`plan/${repo.split("/")[1]}-rs`);
    expect(calls).toContain(`gh repo create ${repo} --private`);

    const l1 = await landPatch(pb, await task(pb, run, (d) => writeFileSync(join(d, "a.py"), "x = 1\n")), "Task 1: scaffold", run);
    expect(l1.prOpened).toBe("https://github.com/x/y/pull/1");
    const p2 = await task(pb, run, (d) => {
      expect(readFileSync(join(d, "a.py"), "utf8")).toBe("x = 1\n");
      writeFileSync(join(d, "a.py"), "x = 2\n");
      writeFileSync(join(d, "mesh.stl"), Buffer.from([0, 1, 2, 255]));
    });
    const l2 = await landPatch(pb, p2, "Task 2: more", run);
    expect(l2.prOpened).toBeUndefined();
    expect(calls.filter((c) => c.startsWith("gh pr create"))).toHaveLength(1);
    const remote = await runCommand(["git", "log", "--format=%s", pb.branch], bare(repo));
    expect(remote).toBe("Task 2: more\nTask 1: scaffold\nStart");
    expect([...readFileSync(join(pb.dir, "mesh.stl"))]).toEqual([0, 1, 2, 255]);
  });

  test("a task's own branch is opened, and picked up again if it's already on GitHub", async () => {
    const { run } = fakeGh();
    const repo = repoName();
    const pb = await openPlanBranch(repo, join(root, "plans"), run, 2000, "feat/thing");
    expect(pb.branch).toBe("feat/thing");
    await landPatch(pb, await task(pb, run, (d) => writeFileSync(join(d, "t.txt"), "t\n")), "Task 1: thing", run);
    const again = await openPlanBranch(repo, join(root, "plans"), run, 3000, "feat/thing");
    expect(again.branch).toBe("feat/thing");
    expect(readFileSync(join(again.dir, "t.txt"), "utf8")).toBe("t\n");
  });

  test("a task's branch that is the default branch falls back to a plan branch", async () => {
    const { run } = fakeGh();
    const repo = repoName();
    const pb = await openPlanBranch(repo, join(root, "plans"), run, 4000, "main");
    expect(pb.branch).toBe(`plan/${repo.split("/")[1]}-${(4000).toString(36)}`);
  });

  test("a patch not built on the branch fails and leaves the clone on GitHub's branch", async () => {
    const { run } = fakeGh();
    const pb = await openPlanBranch(repoName(), join(root, "plans"), run);
    const stale = enc("diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-x = 1\n+x = 2\n");
    await expect(landPatch(pb, stale, "t", run)).rejects.toThrow(/doesn't apply/);
    await expect(landPatch(pb, new Uint8Array(), "t", run)).rejects.toThrow(/empty/);
    expect(await runCommand(["git", "status", "--porcelain"], pb.dir)).toBe("");
    expect(await head(pb.dir)).toBe(await head(pb.dir, `origin/${pb.branch}`));
  });

  test("a push from elsewhere is picked up before the next task", async () => {
    const { run } = fakeGh();
    const repo = repoName();
    const pb = await openPlanBranch(repo, join(root, "plans"), run);
    // The owner commits to the branch from another clone.
    const other = join(mkdtempSync(join(root, "other-")), "r");
    await runCommand(["git", "clone", "-q", "-b", pb.branch, bare(repo), other]);
    writeFileSync(join(other, "notes.md"), "by hand\n");
    await runCommand(["git", "add", "-A"], other);
    await runCommand(["git", "commit", "-q", "-m", "by hand"], other);
    await runCommand(["git", "push", "-q"], other);

    const p = await task(pb, run, (d) => {
      expect(readFileSync(join(d, "notes.md"), "utf8")).toBe("by hand\n");
      writeFileSync(join(d, "b.py"), "y = 1\n");
    });
    await landPatch(pb, p, "Task 1", run);
    expect(await runCommand(["git", "log", "--format=%s", pb.branch], bare(repo))).toBe("Task 1\nby hand\nStart");
  });

  /** Commit straight to the repo's main, as an approval card or a hotfix does. */
  async function commitToMain(repo: string, file: string, body: string) {
    const other = join(mkdtempSync(join(root, "main-")), "r");
    await runCommand(["git", "clone", "-q", "-b", "main", bare(repo), other]);
    writeFileSync(join(other, file), body);
    await runCommand(["git", "add", "-A"], other);
    await runCommand(["git", "commit", "-q", "-m", `main: ${file}`], other);
    await runCommand(["git", "push", "-q"], other);
  }

  test("work that reached main another way comes into the branch before the next task", async () => {
    const { run } = fakeGh({ prState: "MERGED" });
    const repo = repoName();
    const pb = await openPlanBranch(repo, join(root, "plans"), run);
    await landPatch(pb, await task(pb, run, (d) => writeFileSync(join(d, "a.py"), "x = 1\n")), "Task 1", run);
    const firstPr = pb.prUrl;
    await commitToMain(repo, "visual.py", "stickerless\n");

    const b = await bundlePlanBranch(pb, run);
    try {
      expect(b.caughtUp).toEqual({ merged: 1, base: "main" });
      const p = await workOn(b.path, (d) => {
        expect(readFileSync(join(d, "visual.py"), "utf8")).toBe("stickerless\n");
        writeFileSync(join(d, "a.py"), "x = 2\n");
      });
      const landed = await landPatch(pb, p, "Task 2", run);
      // The first PR was merged: this commit gets a PR of its own.
      expect(landed.prOpened).toBeDefined();
      expect(firstPr).toBeDefined();
    } finally {
      b.cleanup();
    }
    expect(await runCommand(["git", "log", "--first-parent", "--format=%s", pb.branch], bare(repo))).toBe("Task 2\nBring in main\nTask 1\nStart");
    await runCommand(["git", "merge-base", "--is-ancestor", "main", pb.branch], bare(repo));
    // Already up to date: nothing to bring in.
    const again = await bundlePlanBranch(pb, run);
    again.cleanup();
    expect(again.caughtUp).toBeNull();
  });

  test("main conflicting with the branch is reported, and the branch is left as it was", async () => {
    const { run } = fakeGh();
    const repo = repoName();
    const pb = await openPlanBranch(repo, join(root, "plans"), run);
    await landPatch(pb, await task(pb, run, (d) => writeFileSync(join(d, "p.py"), "branch\n")), "Task 1", run);
    await commitToMain(repo, "p.py", "main\n");
    const before = await head(pb.dir, `origin/${pb.branch}`);
    const b = await bundlePlanBranch(pb, run);
    b.cleanup();
    expect(b.caughtUp && "conflict" in b.caughtUp ? b.caughtUp.conflict : "").toContain("p.py");
    expect(await head(pb.dir)).toBe(before);
    expect(await runCommand(["git", "rev-parse", pb.branch], bare(repo))).toBe(before);
    expect(await runCommand(["git", "status", "--porcelain"], pb.dir)).toBe("");
  });

  test("a push that keeps failing leaves no local commit behind", async () => {
    const ok = fakeGh();
    const pb = await openPlanBranch(repoName(), join(root, "plans"), ok.run);
    const p = await task(pb, ok.run, (d) => writeFileSync(join(d, "c.py"), "z = 1\n"));
    const failing = fakeGh({ failPush: 2 });
    await expect(landPatch(pb, p, "t", failing.run)).rejects.toThrow(/push failed/);
    expect(await head(pb.dir)).toBe(await head(pb.dir, `origin/${pb.branch}`));
    // One dropped connection is retried.
    const flaky = fakeGh({ failPush: 1 });
    expect((await landPatch(pb, p, "t", flaky.run)).commitUrl).toContain("/commit/");
  });

  test("the commit counts even when the PR can't be opened", async () => {
    const { run } = fakeGh({ failPr: true });
    const pb = await openPlanBranch(repoName(), join(root, "plans"), run);
    const landed = await landPatch(pb, await task(pb, run, (d) => writeFileSync(join(d, "d.py"), "1\n")), "t", run);
    expect(landed.prError).toContain("no commits");
    expect(pb.prUrl).toBeUndefined();
  });

  test("a deleted clone is cloned again from the branch", async () => {
    const { run } = fakeGh();
    const pb = await openPlanBranch(repoName(), join(root, "plans"), run);
    await landPatch(pb, await task(pb, run, (d) => writeFileSync(join(d, "e.py"), "1\n")), "Task 1", run);
    rmSync(pb.dir, { recursive: true, force: true });
    const p = await task(pb, run, (d) => {
      expect(existsSync(join(d, "e.py"))).toBe(true);
      writeFileSync(join(d, "f.py"), "2\n");
    });
    await landPatch(pb, p, "Task 2", run);
    expect(await runCommand(["git", "log", "--format=%s"], pb.dir)).toStartWith("Task 2\nTask 1");
  });

  test("two tasks landing at once take turns", async () => {
    const { run } = fakeGh();
    const pb = await openPlanBranch(repoName(), join(root, "plans"), run);
    const [p1, p2] = await Promise.all([
      task(pb, run, (d) => writeFileSync(join(d, "g.py"), "1\n")),
      task(pb, run, (d) => writeFileSync(join(d, "h.py"), "2\n")),
    ]);
    await Promise.all([landPatch(pb, p1, "A", run), landPatch(pb, p2, "B", run)]);
    expect((await runCommand(["git", "log", "--format=%s"], pb.dir)).split("\n").slice(0, 2).sort()).toEqual(["A", "B"]);
  });

  test("a big repo goes as a snapshot of its files", async () => {
    const { run } = fakeGh();
    const pb = await openPlanBranch(repoName(), join(root, "plans"), run);
    await landPatch(pb, await task(pb, run, (d) => writeFileSync(join(d, "i.py"), "1\n")), "Task 1", run);
    const b = await bundlePlanBranch(pb, run, 1);
    try {
      expect(b.snapshot).toBe(true);
      const p = await workOn(b.path, (d) => {
        expect(readFileSync(join(d, "i.py"), "utf8")).toBe("1\n");
        writeFileSync(join(d, "i.py"), "2\n");
      });
      await landPatch(pb, p, "Task 2", run);
    } finally {
      b.cleanup();
    }
    expect(await runCommand(["git", "show", "HEAD:i.py"], pb.dir)).toBe("2");
  });

  test("a repo you can't push to is refused before any work", async () => {
    const { run } = fakeGh();
    const repo = repoName();
    await openPlanBranch(repo, join(root, "plans"), run); // exists now
    await expect(openPlanBranch(repo, join(root, "plans"), fakeGh({ permission: "READ" }).run)).rejects.toThrow(/can't push/);
    await expect(openPlanBranch("a/b; rm -rf /", join(root, "plans"), run)).rejects.toThrow(/not a GitHub repo/);
  });

  test("names, the task note, and which patch counts", () => {
    expect(planBranchName("ANonABento/RS3M_Twin", 0)).toBe("plan/rs3m-twin-0");
    const note = planBranchNote({ repo: "a/b", branch: "plan/b-1", dir: "/x", created: true }, "b.bundle");
    expect(note).toContain("swe.sh setup b.bundle");
    expect(note).toContain("repo: a/b");
    const f = (name: string) => ({ name, data: new Uint8Array() });
    expect(pickPatch([f("wip.patch"), f("fast-mode.patch"), f("notes.md")])?.name).toBe("fast-mode.patch");
    expect(pickPatch([f("wip.patch")])?.name).toBe("wip.patch");
    expect(pickPatch([f("a.patch"), f("b.diff")])?.name).toBe("b.diff");
    expect(pickPatch([f("x.md")])).toBeUndefined();
  });

  test("a CAD task's files go in its folder, renders apart; same name replaces; .gitignore and unsafe names respected", async () => {
    const { run } = fakeGh();
    const pb = await openPlanBranch(repoName(), join(root, "plans"), run);
    const f = (name: string, data = "x") => ({ name, data: enc(data) });
    await landFiles(pb, [f("mount.scad", "cube(10);"), f("mount.stl"), f("mount_iso.png"), f("wip.patch"), f(".env"), f("../evil.sh")], "cad", "Task 1: mount", run);
    expect(readFileSync(join(pb.dir, "cad/mount.scad"), "utf8")).toBe("cube(10);");
    expect(existsSync(join(pb.dir, "cad/renders/mount_iso.png"))).toBe(true);
    expect(existsSync(join(pb.dir, "cad/wip.patch"))).toBe(false);
    expect(existsSync(join(pb.dir, "cad/.env"))).toBe(false);
    expect(existsSync(join(pb.dir, "cad/evil.sh"))).toBe(true); // its name only, inside cad/
    expect(existsSync(join(pb.dir, "../evil.sh"))).toBe(false);

    // A later task edits the part: same name, replaced.
    await landFiles(pb, [f("mount.scad", "cube(12);")], "cad", "Task 2: bigger", run);
    expect(await runCommand(["git", "show", "HEAD:cad/mount.scad"], pb.dir)).toBe("cube(12);");
    await expect(landFiles(pb, [f("mount.scad", "cube(12);")], "cad", "t", run)).rejects.toThrow(/same as on the branch/);

    // The repo keeps STLs out: they're skipped, the rest lands.
    await landPatch(pb, await task(pb, run, (d) => writeFileSync(join(d, ".gitignore"), "*.stl\n")), "ignore stl", run);
    await landFiles(pb, [f("arm.scad", "a"), f("arm.stl")], "cad", "Task 3: arm", run);
    expect(await runCommand(["git", "ls-files", "cad"], pb.dir)).not.toContain("arm.stl");
    await expect(landFiles(pb, [f("only.stl")], "cad", "t", run)).rejects.toThrow(/\.gitignore excludes/);
    await expect(landFiles(pb, [f("x.patch")], "cad", "t", run)).rejects.toThrow(/no files/);
    expect(await runCommand(["git", "status", "--porcelain"], pb.dir)).toBe("");
  });

  test("safe file names, and the CAD task note", () => {
    expect(safeFileName("a/b/part v2.scad")).toBe("part v2.scad");
    expect(safeFileName(".bashrc")).toBeNull();
    expect(safeFileName("x;rm -rf.scad")).toBeNull();
    const note = planFilesNote({ repo: "a/b", branch: "plan/b-1", dir: "/x", created: false }, "b.bundle", "cad");
    expect(note).toContain("cad/ folder");
    expect(note).toContain("git clone b.bundle");
  });

  test("old clones nothing uses are removed; kept and recent ones stay", () => {
    const plans = mkdtempSync(join(root, "prune-"));
    for (const d of ["old", "kept", "new"]) mkdirSync(join(plans, d));
    const old = (Date.now() - 3 * 24 * 3600_000) / 1000;
    utimesSync(join(plans, "old"), old, old);
    utimesSync(join(plans, "kept"), old, old);
    expect(pruneClones(plans, new Set([join(plans, "kept")]))).toEqual([join(plans, "old")]);
    expect(existsSync(join(plans, "kept")) && existsSync(join(plans, "new"))).toBe(true);
    expect(pruneClones(join(root, "nope"), new Set())).toEqual([]);
  });
});
