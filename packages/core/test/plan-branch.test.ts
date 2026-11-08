import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, type Runner } from "../lib/patch-pr.ts";
import { bundlePlanBranch, landPatch, openPlanBranch, planBranchName, planBranchNote } from "../lib/plan-branch.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "plan-branch-"));
  dirs.push(d);
  return d;
};

/** Real git; GitHub (gh, push) faked and recorded. */
function fakeGithub(exists = false) {
  const calls: string[] = [];
  const env = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  Object.assign(process.env, env);
  const run: Runner = async (cmd, cwd) => {
    const line = cmd.join(" ");
    if (cmd[0] === "gh") {
      calls.push(line);
      if (cmd[1] === "repo" && cmd[2] === "view" && cmd.includes("--json") && cmd.includes("name")) {
        if (!exists) throw new Error("not found");
        return "{}";
      }
      if (cmd[1] === "pr") return "https://github.com/a/b/pull/1";
      if (cmd[2] === "view") return "main";
      return "";
    }
    if (cmd.includes("push")) {
      calls.push(`push ${cmd.at(-1)}`);
      return "";
    }
    return runCommand(cmd, cwd);
  };
  return { run, calls };
}

/** What a task does in its sandbox: clone the bundle, change files, diff. */
async function workOn(bundle: string, edit: (dir: string) => void): Promise<Uint8Array> {
  const dir = join(temp(), "repo");
  await runCommand(["git", "clone", "-q", bundle, dir]);
  edit(dir);
  await runCommand(["git", "add", "-A"], dir);
  return new TextEncoder().encode(await runCommand(["git", "diff", "--cached"], dir) + "\n");
}

describe("plan branch", () => {
  test("a new repo is created private; each task builds on the last; the first commit opens one PR", async () => {
    const { run, calls } = fakeGithub(false);
    const pb = await openPlanBranch("a/b", temp(), run, 1000);
    expect(pb.branch).toBe("plan/b-rs");
    expect(pb.created).toBe(true);
    expect(calls).toContain("gh repo create a/b --private");

    const b1 = await bundlePlanBranch(pb, run);
    const p1 = await workOn(b1.path, (d) => writeFileSync(join(d, "a.py"), "x = 1\n"));
    b1.cleanup();
    const l1 = await landPatch(pb, p1, "Task 1: scaffold", run);
    expect(l1.prOpened).toBe("https://github.com/a/b/pull/1");

    // Task 2 gets task 1's work in its bundle.
    const b2 = await bundlePlanBranch(pb, run);
    const p2 = await workOn(b2.path, (d) => {
      expect(readFileSync(join(d, "a.py"), "utf8")).toBe("x = 1\n");
      writeFileSync(join(d, "a.py"), "x = 2\n");
    });
    b2.cleanup();
    const l2 = await landPatch(pb, p2, "Task 2: more", run);
    expect(l2.prOpened).toBeUndefined();
    expect(calls.filter((c) => c.startsWith("gh pr create"))).toHaveLength(1);
    expect(await runCommand(["git", "log", "--format=%s"], pb.dir)).toBe("Task 2: more\nTask 1: scaffold\nStart");
    expect(calls.filter((c) => c === `push ${pb.branch}`).length).toBeGreaterThanOrEqual(3);
  });

  test("a patch not built on the branch fails and leaves the clone clean", async () => {
    const { run } = fakeGithub(false);
    const pb = await openPlanBranch("a/b", temp(), run);
    const stale = new TextEncoder().encode("diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-x = 1\n+x = 2\n");
    await expect(landPatch(pb, stale, "t", run)).rejects.toThrow(/doesn't apply/);
    expect(await runCommand(["git", "status", "--porcelain"], pb.dir)).toBe("");
    await expect(landPatch(pb, new Uint8Array(), "t", run)).rejects.toThrow();
  });

  test("names and the task note", () => {
    expect(planBranchName("ANonABento/RS3M_Twin", 0)).toBe("plan/rs3m-twin-0");
    const note = planBranchNote({ repo: "a/b", branch: "plan/b-1", dir: "/x", created: true }, "b.bundle");
    expect(note).toContain("swe.sh setup b.bundle");
    expect(note).toContain("repo: a/b");
  });

  test("refuses a repo name that isn't one", async () => {
    await expect(openPlanBranch("a/b; rm -rf /", temp(), fakeGithub().run)).rejects.toThrow(/not a GitHub repo/);
  });
});
