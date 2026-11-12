import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { landBundle, type PlanBranch } from "../lib/plan-branch.ts";

const id = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
Object.assign(process.env, id);
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: { ...process.env, ...id } }).toString();

test("landBundle lands a new binary file and an edit as one Task commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "plan-bundle-"));
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const dir = join(root, "clone");
  git(root, "clone", "-q", origin, dir);
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Start");
  git(dir, "checkout", "-qb", "plan/x");
  git(dir, "push", "-q", "-u", "origin", "plan/x");

  // The sandbox side: clone, commit work, bundle BASE..HEAD.
  const box = join(root, "box");
  git(root, "clone", "-q", "-b", "plan/x", origin, box);
  const base = git(box, "rev-parse", "HEAD").trim();
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  writeFileSync(join(box, "sprite.png"), bytes);
  writeFileSync(join(box, "a.txt"), "one\ntwo\n");
  git(box, "add", "-A");
  git(box, "commit", "-qm", "work");
  const bundle = join(root, "task.bundle");
  git(box, "bundle", "create", "-q", bundle, `${base}..HEAD`);

  // prUrl set: no PR is opened (gh isn't needed).
  const pb: PlanBranch = { repo: "o/r", branch: "plan/x", dir, created: false, prUrl: "https://github.com/o/r/pull/1" };
  await landBundle(pb, readFileSync(bundle), "Task 1: sprite");

  const check = join(root, "check");
  git(root, "clone", "-q", "-b", "plan/x", origin, check);
  expect(git(check, "log", "-1", "--format=%s").trim()).toBe("Task 1: sprite");
  expect(readFileSync(join(check, "a.txt"), "utf8")).toBe("one\ntwo\n");
  expect(Buffer.compare(readFileSync(join(check, "sprite.png")), bytes)).toBe(0);
});
