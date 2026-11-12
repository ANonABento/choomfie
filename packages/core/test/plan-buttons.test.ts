import { describe, expect, test } from "bun:test";
import { landLabel, planOwnsPatch } from "../lib/brain-router";

const f = (name: string) => ({ name, data: new Uint8Array() }) as any;

describe("plan task hand-back", () => {
  test("a bundle is labelled as a bundle, never 'file for undefined/'", () => {
    const label = landLabel({ kind: "bundle", files: [f("task.bundle")], patch: f("x.patch") });
    expect(label).toContain("task.bundle");
    expect(label).not.toContain("undefined");
  });
  test("patch and files labels unchanged", () => {
    expect(landLabel({ kind: "patch", files: [f("a.patch")] })).toBe("Patch (`a.patch`)");
    expect(landLabel({ kind: "files", files: [f("a.stl")], folder: "cad" })).toBe("1 file for cad/");
  });
  test("no Open draft PR offer in a plan task with a repo", () => {
    const board = { tasks: [{ n: 1, title: "t", mode: "code", repo: "o/r" }] } as any;
    expect(planOwnsPatch(board, 0, { kind: "bundle", files: [f("task.bundle")] })).toBe(true);
    expect(planOwnsPatch(board, 0, undefined)).toBe(true);
    const noRepo = { tasks: [{ n: 1, title: "t", mode: "research" }] } as any;
    expect(planOwnsPatch(noRepo, 0, undefined)).toBe(false);
  });
});
