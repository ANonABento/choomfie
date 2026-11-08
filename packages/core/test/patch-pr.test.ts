import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { branchName, findPatch, openDraftPr, type PatchOffer, type Runner } from "../lib/patch-pr.ts";

const file = (name = "fix.patch") => ({ name, data: new TextEncoder().encode("diff --git a/x b/x\n") });

describe("findPatch", () => {
  test("needs a patch file and a repo line; takes the title from the first line", () => {
    const text = "**Code blocks now survive chunking.**\nrepo: `ANonABento/choomfie`\n```\n 1 pass\n```";
    expect(findPatch(text, [file()])).toMatchObject({ repo: "ANonABento/choomfie", title: "Code blocks now survive chunking." });
    expect(findPatch("repo: https://github.com/a/b.git", [file("x.diff")])?.repo).toBe("a/b");
    expect(findPatch("- **repo:** a/b", [file()])?.repo).toBe("a/b");
    expect(findPatch(text, [file("notes.md")])).toBeNull();
    expect(findPatch("no repo here", [file()])).toBeNull();
    expect(findPatch("repo: a/b; rm -rf /", [file()])).toBeNull();
    expect(findPatch("repo: ../b", [file()])).toBeNull();
  });
});

test("branchName is a safe slug under waymond/", () => {
  expect(branchName("Fix: chunk `code` blocks!", 0)).toBe("waymond/fix-chunk-code-blocks-0");
  expect(branchName("***", 35)).toBe("waymond/patch-z");
});

describe("openDraftPr", () => {
  const offer: PatchOffer = { repo: "a/b", file: file(), title: "Fix it", body: "Fixed.\nrepo: a/b" };

  test("clone → branch → apply → commit and push without hooks → draft PR; temp dir removed", async () => {
    const calls: string[][] = [];
    let dir = "";
    const run: Runner = async (cmd, cwd) => {
      calls.push(cmd);
      if (cwd) dir = cwd;
      return cmd[1] === "pr" ? "https://github.com/a/b/pull/7" : "";
    };
    expect(await openDraftPr(offer, run)).toEqual({ url: "https://github.com/a/b/pull/7", kind: "pr" });
    expect(calls.map((c) => c.slice(0, 3).join(" "))).toEqual([
      "gh repo view",
      "gh repo clone",
      "git checkout -q",
      "git apply --index",
      "git -c core.hooksPath=/dev/null",
      "git -c core.hooksPath=/dev/null",
      "gh pr create",
    ]);
    expect(calls[6]).toContain("--draft");
    expect(existsSync(dir)).toBe(false);
  });

  test("a patch that doesn't apply says so, and nothing is pushed", async () => {
    const calls: string[] = [];
    const run: Runner = async (cmd) => {
      calls.push(cmd.slice(0, 2).join(" "));
      if (cmd[1] === "apply") throw new Error("patch does not apply");
      return "";
    };
    await expect(openDraftPr(offer, run)).rejects.toThrow(/doesn't apply to a\/b/);
    expect(calls).not.toContain("git -c");
  });

  test("a repo that doesn't exist yet is created private, with the patch as its first commit on main", async () => {
    const calls: string[][] = [];
    const run: Runner = async (cmd) => {
      calls.push(cmd);
      if (cmd.join(" ").startsWith("gh repo view")) throw new Error("not found");
      return cmd[2] === "create" ? "https://github.com/a/b" : "";
    };
    expect(await openDraftPr(offer, run)).toEqual({ url: "https://github.com/a/b", kind: "repo" });
    expect(calls.find((c) => c[2] === "create")).toEqual(["gh", "repo", "create", "a/b", "--private"]);
    expect(calls.at(-1)).toEqual(["git", "-c", "core.hooksPath=/dev/null", "push", "-q", "-u", "origin", "main"]);
    expect(calls.some((c) => c[1] === "pr")).toBe(false);
  });

  test("a new repo isn't created when the patch doesn't apply", async () => {
    const calls: string[][] = [];
    const run: Runner = async (cmd) => {
      calls.push(cmd);
      if (cmd.join(" ").startsWith("gh repo view")) throw new Error("not found");
      if (cmd[1] === "apply") throw new Error("patch does not apply");
      return "";
    };
    await expect(openDraftPr(offer, run)).rejects.toThrow(/doesn't apply/);
    expect(calls.some((c) => c[2] === "create")).toBe(false);
  });

  test("the pushed branch is deleted again when the PR can't be opened", async () => {
    const calls: string[][] = [];
    const run: Runner = async (cmd) => {
      calls.push(cmd);
      if (cmd[1] === "pr") throw new Error("gh pr create failed");
      return "";
    };
    await expect(openDraftPr(offer, run)).rejects.toThrow("gh pr create failed");
    const del = calls.at(-1)!;
    expect(del.slice(3, 7)).toEqual(["push", "-q", "origin", "--delete"]);
    expect(del[7]).toStartWith("waymond/fix-it-");
  });
});
