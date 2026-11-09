import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatchStrict, commitStagedViaApi, type GitApi } from "../lib/git-data.ts";
import { runCommand as run } from "../lib/patch-pr.ts";
import { pickPatch } from "../lib/plan-branch.ts";

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
let dir: string;
let head: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  dir = mkdtempSync(join(tmpdir(), "git-data-"));
  await run(["git", "init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "edit.txt"), "one\n");
  writeFileSync(join(dir, "gone.txt"), "bye\n");
  await run(["git", "add", "-A"], dir);
  await run(["git", "commit", "-q", "-m", "base"], dir);
  head = (await run(["git", "rev-parse", "HEAD"], dir)).trim();
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
});

/** Build a binary patch of an edit, an add, a delete and a binary file, then undo it in the tree. */
async function makePatch(): Promise<string> {
  writeFileSync(join(dir, "edit.txt"), "two\n");
  writeFileSync(join(dir, "new.txt"), "hi\n");
  unlinkSync(join(dir, "gone.txt"));
  writeFileSync(join(dir, "img.bin"), Buffer.from([0, 1, 2, 255, 0, 9]));
  await run(["git", "add", "-A"], dir);
  const file = join(dir, "..", `t-${Date.now()}.patch`);
  await run(["git", "diff", "--cached", "--binary", `--output=${file}`], dir);
  await run(["git", "reset", "-q", "--hard", head], dir);
  return file;
}

/** A fake GitHub: records calls; update-ref answers 422 `conflicts` times first. */
function fakeApi(conflicts = 0) {
  const calls: { method: string; path: string; body?: any }[] = [];
  let n = 0;
  const api: GitApi = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.endsWith("/blobs")) return { status: 201, data: { sha: `blob${++n}` } };
    if (path.endsWith("/trees")) return { status: 201, data: { sha: "tree1" } };
    if (path.includes("/commits/")) return { status: 200, data: { tree: { sha: "basetree" } } };
    if (path.endsWith("/commits")) return { status: 201, data: { sha: `commit${++n}` } };
    if (path.includes("/ref/heads/")) return { status: 200, data: { object: { sha: "moved" } } };
    if (method === "PATCH") return conflicts-- > 0 ? { status: 422, data: {} } : { status: 200, data: {} };
    return { status: 404, data: null };
  };
  return { api, calls };
}

describe("Git Data API relay", () => {
  test("an edit, an add, a delete and a binary file land as one commit, never forced", async () => {
    await applyPatchStrict(dir, await makePatch(), run);
    const { api, calls } = fakeApi();
    const sha = await commitStagedViaApi(dir, "o/r", "plan/x", "Task 1", api, run);
    await run(["git", "reset", "-q", "--hard", head], dir);
    expect(sha).toMatch(/^commit/);
    const tree = calls.find((c) => c.path.endsWith("/trees"))!.body;
    const byPath = Object.fromEntries(tree.tree.map((e: { path: string; sha: string | null }) => [e.path, e.sha]));
    expect(byPath["gone.txt"]).toBeNull();
    expect(Object.keys(byPath).sort()).toEqual(["edit.txt", "gone.txt", "img.bin", "new.txt"]);
    const bin = calls.find((c) => c.path.endsWith("/blobs") && Buffer.from(c.body.content, "base64")[3] === 255);
    expect(bin?.body.encoding).toBe("base64");
    expect(calls.filter((c) => c.path.endsWith("/commits")).length).toBe(1);
    const upd = calls.find((c) => c.method === "PATCH")!;
    expect(upd.path).toBe("/repos/o/r/git/refs/heads/plan/x");
    expect(upd.body.force).toBe(false);
  });

  test("a 422 on update-ref (branch moved) fails at once, never rebuilds", async () => {
    await applyPatchStrict(dir, await makePatch(), run);
    const moved = fakeApi(1);
    await expect(commitStagedViaApi(dir, "o/r", "b", "m", moved.api, run)).rejects.toThrow("branch moved, re-run the task");
    expect(moved.calls.filter((c) => c.method === "PATCH").length).toBe(1);
    expect(moved.calls.some((c) => c.method === "GET" && c.path.includes("/ref/heads/"))).toBe(false);
    await run(["git", "reset", "-q", "--hard", head], dir);
  });

  test("a stale patch is rejected and nothing is staged", async () => {
    const file = await makePatch();
    writeFileSync(join(dir, "edit.txt"), "changed elsewhere\n");
    await run(["git", "commit", "-qam", "moved on"], dir);
    await expect(applyPatchStrict(dir, file, run)).rejects.toThrow(/doesn't apply cleanly/);
    expect((await run(["git", "diff", "--cached", "--name-only"], dir)).trim()).toBe("");
    await run(["git", "reset", "-q", "--hard", head], dir);
  });
});

describe("pickPatch by name", () => {
  const f = (name: string) => ({ name, data: new Uint8Array() });
  test("only the patch the result names; a second patch in the folder is ignored", () => {
    const files = [f("chunk-fences.patch"), f("agent-push.patch")];
    expect(pickPatch(files, "patch: [agent-push.patch](/x)")?.name).toBe("agent-push.patch");
    expect(pickPatch(files, "no patch named here")).toBeUndefined();
    expect(pickPatch([f("wip.patch"), f("a.patch")], "a.patch (earlier: wip.patch)")?.name).toBe("a.patch");
  });
});
