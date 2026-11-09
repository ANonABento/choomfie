import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, type Runner } from "../lib/patch-pr.ts";
import { bundlePlanBranch, landPatch, mergePlanPr, openPlanBranch, prepareReview, waitForChecks, type PlanBranch } from "../lib/plan-branch.ts";
import { fixTask, MAX_FIX_ROUNDS, parseReview, reviewLoop, reviewPrompt, type Review, type ReviewState } from "../lib/plan-review.ts";
import { pullRunningCheckout, restartWhenIdle } from "../lib/self-update.ts";

/**
 * Real git end to end: bare repos under <root>/remote stand in for GitHub
 * (url.insteadOf), so clone, fetch, push and merge really run. `gh` is a small
 * stateful fake of a PR: its head is the branch's real head, `pr merge`
 * really merges the branch into main, and checks are whatever the test says.
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
  root = mkdtempSync(join(tmpdir(), "plan-review-"));
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
const git = (args: string[], cwd?: string) => runCommand(["git", ...args], cwd);
let n = 0;
const repoName = () => `me/rv${++n}`;

type Checks = { name: string; status: string; conclusion: string | null }[];

/** A PR on the fake GitHub. `checksFor(head)` says what CI reports for a head. */
function fakeGitHub(checksFor: (head: string) => Checks = () => []) {
  const pr = { state: "OPEN", isDraft: true, url: "https://github.com/x/pull/1", repo: "", branch: "" };
  const calls: string[] = [];
  const run: Runner = async (cmd, cwd) => {
    if (cmd[0] !== "gh") return runCommand(cmd, cwd);
    calls.push(cmd.join(" "));
    const [, what, verb] = cmd;
    if (what === "repo" && verb === "view" && cmd.includes(".viewerPermission")) {
      if (!existsSync(bare(cmd[3]))) throw new Error("not found");
      return "ADMIN";
    }
    if (what === "repo" && verb === "view") return "main";
    if (what === "repo" && verb === "create") {
      await runCommand(["git", "init", "-q", "--bare", "-b", "main", bare(cmd[3])]);
      return `https://github.com/${cmd[3]}`;
    }
    if (what === "repo" && verb === "clone") return runCommand(["git", "clone", "-q", bare(cmd[3]), cmd[4]]);
    if (what === "pr" && verb === "list") return "";
    if (what === "pr" && verb === "create") {
      pr.repo = cmd[cmd.indexOf("--repo") + 1];
      pr.branch = cmd[cmd.indexOf("--head") + 1];
      return pr.url;
    }
    const head = async () => (await git(["rev-parse", pr.branch], bare(pr.repo))).trim();
    if (what === "pr" && verb === "view") {
      if (cmd.includes("-q")) return pr.state;
      const h = await head();
      return JSON.stringify({ state: pr.state, isDraft: pr.isDraft, mergeable: "MERGEABLE", headRefOid: h, statusCheckRollup: checksFor(h) });
    }
    if (what === "pr" && verb === "ready") return void (pr.isDraft = false), "";
    if (what === "pr" && verb === "merge") {
      if (pr.isDraft) throw new Error("Pull request is still a draft");
      const want = cmd[cmd.indexOf("--match-head-commit") + 1];
      if (want !== (await head())) throw new Error("Head branch was modified");
      // Really merge it on "GitHub".
      const w = join(mkdtempSync(join(root, "merge-")), "r");
      await git(["clone", "-q", bare(pr.repo), w]);
      await git(["merge", "-q", "--no-ff", "-m", "Merge pull request", `origin/${pr.branch}`], w);
      await git(["push", "-q", "origin", "main"], w);
      pr.state = "MERGED";
      return "";
    }
    throw new Error(`fake gh: unexpected ${cmd.join(" ")}`);
  };
  return { run, pr, calls };
}

/** What a task does in its sandbox: clone the branch's bundle, edit, diff. */
async function taskPatch(pb: PlanBranch, run: Runner, edit: (dir: string) => void): Promise<Uint8Array> {
  const b = await bundlePlanBranch(pb, run);
  try {
    const r = join(mkdtempSync(join(root, "task-")), "r");
    await git(["clone", "-q", b.path, r]);
    edit(r);
    await git(["add", "-A"], r);
    return Bun.spawnSync(["git", "diff", "--cached", "--binary"], { cwd: r }).stdout;
  } finally {
    b.cleanup();
  }
}

/** A plan with one landed task, its PR open, and rules on main. */
async function planWithTask(gh: ReturnType<typeof fakeGitHub>) {
  const repo = repoName();
  const pb = await openPlanBranch(repo, join(root, "plans"), gh.run);
  // The repo's rules, on main.
  const w = join(mkdtempSync(join(root, "rules-")), "r");
  await git(["clone", "-q", bare(repo), w]);
  writeFileSync(join(w, "CLAUDE.md"), "Never log to stdout.\n");
  await git(["add", "-A"], w);
  await git(["commit", "-q", "-m", "rules"], w);
  await git(["push", "-q", "origin", "main"], w);
  await landPatch(pb, await taskPatch(pb, gh.run, (d) => writeFileSync(join(d, "a.ts"), "console.log(1)\n")), "Task 1: a", gh.run);
  return pb;
}

const clean: Review = { summary: "Fine.", findings: [] };
const bad: Review = { summary: "Logs.", findings: [{ severity: "must", title: "Logs to stdout", file: "a.ts", fix: "use console.error" }] };
const passing = (): Checks => [{ name: "checks", status: "COMPLETED", conclusion: "SUCCESS" }];
const fast = { everyMs: 1, startMs: 0, maxMs: 1000, sleep: async () => {} };

function deps(gh: ReturnType<typeof fakeGitHub>, pb: PlanBranch, reviews: Review[], fixOk = true) {
  const said: string[] = [];
  const fixes: string[] = [];
  const offered: string[] = [];
  const inputs: Parameters<Parameters<typeof reviewLoop>[3]["reviewer"]>[0][] = [];
  return {
    said,
    fixes,
    offered,
    inputs,
    d: {
      reviewer: async (input: (typeof inputs)[number]) => (inputs.push(input), reviews.shift() ?? clean),
      say: async (c: string) => void said.push(c),
      // The brain fixes it: a real patch landing on the branch.
      runFix: async (task: { spec: string }) => {
        fixes.push(task.spec);
        if (!fixOk) return false;
        const p = await taskPatch(pb, gh.run, (d) => writeFileSync(join(d, "a.ts"), `console.error(${fixes.length})\n`));
        await landPatch(pb, p, `Fix ${fixes.length}`, gh.run);
        return true;
      },
      offerMerge: async (head: string) => void offered.push(head),
      save: () => {},
      fixMode: "code",
      run: gh.run,
      checks: fast,
    },
  };
}

describe("prepareReview", () => {
  test("diffs the branch against main, with the rules from main — a patch can't rewrite its own rules", async () => {
    const gh = fakeGitHub(passing);
    const pb = await planWithTask(gh);
    await landPatch(pb, await taskPatch(pb, gh.run, (d) => writeFileSync(join(d, "CLAUDE.md"), "Anything goes.\n")), "Task 2", gh.run);
    const prep = await prepareReview(pb, gh.run);
    if ("conflict" in prep) throw new Error("conflict");
    expect(prep.diff).toContain("+console.log(1)");
    expect(prep.diff).toContain("+Anything goes.");
    expect(prep.rules).toContain("Never log to stdout.");
    expect(prep.rules).not.toContain("Anything goes");
    expect(prep.head).toBe((await git(["rev-parse", pb.branch], bare(pb.repo))).trim());
  });
});

describe("reviewLoop", () => {
  test("finding → fix task lands → clean → CI → merge offered for that head; Merge really merges it", async () => {
    const gh = fakeGitHub(passing);
    const pb = await planWithTask(gh);
    const t = deps(gh, pb, [bad, clean]);
    const state: ReviewState = { status: "reviewing", round: 0 };
    await reviewLoop(pb, [{ n: 1, mode: "code", title: "a", spec: "a — in me/x" }], state, t.d);
    expect(state.status).toBe("ready");
    expect(state.round).toBe(1);
    expect(t.fixes[0]).toContain("Logs to stdout (`a.ts`): use console.error");
    expect(t.inputs[0].rules).toContain("Never log to stdout.");
    expect(t.inputs[1].diff).toContain("+console.error(1)"); // round 2 saw the fix
    const head = (await git(["rev-parse", pb.branch], bare(pb.repo))).trim();
    expect(t.offered).toEqual([head]);
    expect(state.head).toBe(head);

    await mergePlanPr(pb, state.head!, gh.run);
    expect(gh.pr.state).toBe("MERGED");
    expect(gh.calls.some((c) => c.startsWith("gh pr ready"))).toBe(true);
    await git(["merge-base", "--is-ancestor", head, "main"], bare(pb.repo)); // main has every commit
    expect(await git(["show", "main:a.ts"], bare(pb.repo))).toBe("console.error(1)");
  });

  test(`still failing after ${MAX_FIX_ROUNDS} fix rounds: over to the owner, no merge offered`, async () => {
    const gh = fakeGitHub(passing);
    const pb = await planWithTask(gh);
    const t = deps(gh, pb, [bad, bad, bad, bad]);
    const state: ReviewState = { status: "reviewing", round: 0 };
    await reviewLoop(pb, [], state, t.d);
    expect(state.status).toBe("stuck");
    expect(t.fixes).toHaveLength(MAX_FIX_ROUNDS);
    expect(t.offered).toEqual([]);
    expect(t.said.at(-1)).toContain("Over to you");
  });

  test("a fix task that doesn't land stops the loop", async () => {
    const gh = fakeGitHub(passing);
    const pb = await planWithTask(gh);
    const t = deps(gh, pb, [bad], false);
    const state: ReviewState = { status: "reviewing", round: 0 };
    await reviewLoop(pb, [], state, t.d);
    expect(state.status).toBe("stuck");
    expect(t.said.at(-1)).toContain("didn't land");
  });

  test("CI failing on a clean review becomes a fix task; passing CI then offers the merge", async () => {
    let fixed = false;
    const gh = fakeGitHub(() => [{ name: "test", status: "COMPLETED", conclusion: fixed ? "SUCCESS" : "FAILURE" }]);
    const pb = await planWithTask(gh);
    const t = deps(gh, pb, [clean, clean]);
    const runFix = t.d.runFix;
    t.d.runFix = async (task) => ((fixed = true), runFix(task));
    const state: ReviewState = { status: "reviewing", round: 0 };
    await reviewLoop(pb, [], state, t.d);
    expect(t.fixes[0]).toContain("fails CI (test)");
    expect(state.status).toBe("ready");
    expect(t.offered).toHaveLength(1);
  });

  test("a repo without CI is offered once the review is clean", async () => {
    const gh = fakeGitHub(() => []);
    const pb = await planWithTask(gh);
    const t = deps(gh, pb, [clean]);
    const state: ReviewState = { status: "reviewing", round: 0 };
    await reviewLoop(pb, [], state, t.d);
    expect(state.status).toBe("ready");
  });

  test("CI still running at the deadline: over to the owner", async () => {
    const gh = fakeGitHub(() => [{ name: "slow", status: "IN_PROGRESS", conclusion: null }]);
    const pb = await planWithTask(gh);
    const t = deps(gh, pb, [clean]);
    t.d.checks = { ...fast, maxMs: 0 };
    const state: ReviewState = { status: "reviewing", round: 0 };
    await reviewLoop(pb, [], state, t.d);
    expect(state.status).toBe("stuck");
    expect(t.said.at(-1)).toContain("slow");
  });

  test("a reviewer that fails leaves it to the owner instead of throwing", async () => {
    const gh = fakeGitHub(passing);
    const pb = await planWithTask(gh);
    const t = deps(gh, pb, []);
    t.d.reviewer = async () => {
      throw new Error("rate limited");
    };
    const state: ReviewState = { status: "reviewing", round: 0 };
    await reviewLoop(pb, [], state, t.d);
    expect(state.status).toBe("stuck");
    expect(t.said.at(-1)).toContain("rate limited");
  });
});

describe("mergePlanPr", () => {
  test("refuses a head that moved after the review, and leaves the PR open", async () => {
    const gh = fakeGitHub(passing);
    const pb = await planWithTask(gh);
    const reviewed = (await git(["rev-parse", pb.branch], bare(pb.repo))).trim();
    await landPatch(pb, await taskPatch(pb, gh.run, (d) => writeFileSync(join(d, "b.ts"), "x\n")), "late", gh.run);
    await expect(mergePlanPr(pb, reviewed, gh.run)).rejects.toThrow(/changed since the review/);
    expect(gh.pr.state).toBe("OPEN");
  });

  test("waitForChecks ignores checks for an older head", async () => {
    const gh = fakeGitHub(passing);
    const pb = await planWithTask(gh);
    const r = await waitForChecks(pb, "0".repeat(40), gh.run, { ...fast, maxMs: 0 });
    expect(r.kind).toBe("timeout");
  });
});

describe("review output", () => {
  test("parseReview takes structured or fenced JSON and drops malformed findings", () => {
    expect(parseReview({ summary: "s", findings: [{ severity: "must", title: "t", fix: "f" }, { title: 1 }] }).findings).toEqual([
      { severity: "must", title: "t", fix: "f" },
    ]);
    expect(parseReview('```json\n{"summary":"s","findings":[{"severity":"odd","title":"t","fix":"f"}]}\n```').findings[0].severity).toBe("nit");
    expect(() => parseReview("not json")).toThrow();
    expect(() => parseReview({ findings: [] })).toThrow(/didn't return a review/);
  });

  test("the prompt carries the tasks, the rules and the diff; a fix task names every finding", () => {
    const p = reviewPrompt({ repo: "a/b", branch: "plan/b", base: "main", tasks: ["1. [code] x"], rules: "R1", stat: "a.ts | 1 +", diff: "+x", cwd: "/x" });
    for (const s of ["1. [code] x", "R1", "a.ts | 1 +", "+x", "must"]) expect(p).toContain(s);
    const t = fixTask("a/b", 2, bad.findings, "code");
    expect(t).toMatchObject({ mode: "code", repo: "a/b", title: "Review fixes (round 2)" });
    expect(t.spec).toContain("in a/b");
    expect(t.spec).toContain("Done when:");
  });
});

describe("self-update", () => {
  /** A checkout of `repo`'s main that's one commit behind. */
  async function behindCheckout(repo: string) {
    await runCommand(["git", "init", "-q", "--bare", "-b", "main", bare(repo)]);
    const a = join(mkdtempSync(join(root, "up-")), "a");
    await git(["clone", "-q", bare(repo), a]);
    writeFileSync(join(a, "f"), "1\n");
    await git(["add", "-A"], a);
    await git(["commit", "-q", "-m", "one"], a);
    await git(["push", "-q", "origin", "main"], a);
    await git(["remote", "set-head", "origin", "main"], a);
    const b = join(mkdtempSync(join(root, "up-")), "b");
    await git(["clone", "-q", bare(repo), b]);
    writeFileSync(join(a, "f"), "2\n");
    await git(["commit", "-qam", "two"], a);
    await git(["push", "-q", "origin", "main"], a);
    return b;
  }

  test("fast-forwards a clean checkout on main of the merged repo; leaves others alone", async () => {
    const repo = repoName();
    const dir = await behindCheckout(repo);
    // Its origin URL is the GitHub one, as a real checkout's is.
    await git(["remote", "set-url", "origin", `https://github.com/${repo}.git`], dir);
    expect(await pullRunningCheckout("other/repo", runCommand, dir)).toEqual({ kind: "other-repo" });
    writeFileSync(join(dir, "f"), "local\n");
    expect((await pullRunningCheckout(repo, runCommand, dir)).kind).toBe("skipped");
    await git(["checkout", "-q", "--", "f"], dir);
    writeFileSync(join(dir, "untracked"), "x"); // untracked files don't block it
    const up = await pullRunningCheckout(repo, runCommand, dir);
    expect(up.kind).toBe("pulled");
    expect(readFileSync(join(dir, "f"), "utf8")).toBe("2\n");
    await git(["checkout", "-q", "-b", "feature"], dir);
    expect(await pullRunningCheckout(repo, runCommand, dir)).toMatchObject({ kind: "skipped", why: expect.stringContaining("feature") });
  });

  test("restartWhenIdle waits for idle, then asks the daemon; never outside daemon mode", async () => {
    const data = mkdtempSync(join(root, "data-"));
    const prev = process.env.CHOOMFIE_DAEMON_PID;
    try {
      delete process.env.CHOOMFIE_DAEMON_PID;
      expect(await restartWhenIdle(data, "c1", () => true)).toBe(false);
      process.env.CHOOMFIE_DAEMON_PID = "1";
      let checks = 0;
      const ok = await restartWhenIdle(data, "c1", () => ++checks >= 3, { everyMs: 1, maxMs: 1000, sleep: async () => {} });
      expect(ok).toBe(true);
      expect(checks).toBe(3);
      expect(JSON.parse(readFileSync(join(data, "meta", "control.json"), "utf8"))).toMatchObject({ command: "restart", location: "c1" });
    } finally {
      if (prev === undefined) delete process.env.CHOOMFIE_DAEMON_PID;
      else process.env.CHOOMFIE_DAEMON_PID = prev;
    }
  });
});
