import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

/** `swe-push.sh` against a local bare repo, with a fake `gh` that logs its args. */
const SWE = resolve(import.meta.dir, "../../../plugins/waymond/tools/swe-push.sh");
const TOKEN = "github_pat_SECRET123";
let root: string;
const git = (cwd: string, ...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, ...ID } });
const ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function push(dir: string, branch: string, env: Record<string, string> = { GH_TOKEN: TOKEN }) {
  const r = spawnSync("bash", [SWE, branch, "Add thing"], {
    encoding: "utf8",
    env: { ...ID, PATH: `${root}/bin:${process.env.PATH}`, HOME: root, SWE_REPO_DIR: dir, GH_LOG: `${root}/gh.log`, ...env },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "swe-push-"));
  mkdirSync(join(root, "bin"));
  const gh = join(root, "bin", "gh");
  writeFileSync(gh, `#!/bin/bash\necho "$*" >> "$GH_LOG"\n[ "$1 $2" = "pr view" ] && { [ -f "${root}/pr-exists" ] || exit 1; }\nexit 0\n`);
  chmodSync(gh, 0o755);
  git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(root, "clone", "-q", "origin.git", "seed");
  writeFileSync(join(root, "seed", "a.txt"), "a\n");
  git(join(root, "seed"), "add", "-A");
  git(join(root, "seed"), "commit", "-qm", "base");
  git(join(root, "seed"), "push", "-q", "origin", "HEAD:main");
  git(root, "clone", "-q", "origin.git", "work");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("swe-push.sh", () => {
  test("needs GH_TOKEN", () => {
    const r = push(join(root, "work"), "feat/x", {});
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("GH_TOKEN");
  });

  test("refuses main and the default branch", () => {
    for (const b of ["main", "master"]) {
      const r = push(join(root, "work"), b);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("refusing");
    }
    expect(git(root, "--git-dir=origin.git", "log", "--oneline", "main").stdout.trim().split("\n").length).toBe(1);
  });

  test("commits, pushes the branch, opens a PR, then updates it — and never prints the token", () => {
    const dir = join(root, "work");
    writeFileSync(join(dir, "b.txt"), "b\n");
    const r = push(dir, "feat/x");
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(TOKEN);
    expect(git(root, "--git-dir=origin.git", "show", "feat/x:b.txt").stdout).toBe("b\n");
    let log = readFileSync(join(root, "gh.log"), "utf8");
    expect(log).toContain("auth setup-git");
    expect(log).toMatch(/pr create --base main --head feat\/x/);
    writeFileSync(join(root, "pr-exists"), "");
    writeFileSync(join(dir, "c.txt"), "c\n");
    expect(push(dir, "feat/x").code).toBe(0);
    log = readFileSync(join(root, "gh.log"), "utf8");
    expect(log).toContain("pr edit feat/x");
    expect(existsSync(join(root, "origin.git"))).toBe(true);
    expect(git(root, "--git-dir=origin.git", "show", "feat/x:c.txt").stdout).toBe("c\n");
  });
});
