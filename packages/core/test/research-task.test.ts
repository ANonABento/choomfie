import { describe, expect, test } from "bun:test";
import { landingFor, researchOutcome } from "../lib/brain-router.ts";

const spec = "Find CAD sources. Write research/cad-sources/report.md. Done when: report exists.";

describe("research plan tasks", () => {
  test("a reply naming the task's report path is done", () => {
    expect(researchOutcome(spec, "Answer...\nReport saved: research/cad-sources/report.md")).toEqual({ ok: true, path: "research/cad-sources/report.md" });
  });
  test("no report line, or the wrong path, fails with 'no report saved'", () => {
    const none = researchOutcome(spec, "Here is what I found.");
    expect(none.ok).toBe(false);
    expect(!none.ok && none.reason).toContain("no report saved");
    const wrong = researchOutcome(spec, "Report saved: research/other/report.md");
    expect(wrong.ok).toBe(false);
    expect(!wrong.ok && wrong.reason).toContain("no report saved");
  });
  test("with workspace access the report must exist and be non-empty", () => {
    expect(researchOutcome(spec, "", (p) => (p === "research/cad-sources/report.md" ? "# R" : undefined)).ok).toBe(true);
    expect(researchOutcome(spec, "Report saved: research/cad-sources/report.md", () => "  ").ok).toBe(false);
    expect(researchOutcome(spec, "", () => undefined).ok).toBe(false);
  });
  test("files a research task sends back are never committed; code tasks still are", async () => {
    const { registerBrain, unregisterBrain } = await import("@choomfie/shared");
    registerBrain({
      id: "rbrain",
      label: "R",
      send: async () => ({ text: "" }),
      modes: [
        { id: "code", label: "Code", description: "", repo: true },
        { id: "research", label: "Research", description: "", files: "research" },
      ],
    });
    try {
      const f = (name: string) => ({ name, data: new Uint8Array() });
      const board = {
        brainId: "rbrain",
        tasks: [
          { n: 1, mode: "code", title: "A", spec: "", repo: "me/r" },
          { n: 2, mode: "research", title: "B", spec },
        ],
      };
      expect(landingFor(board, 1, [f("report.md")])).toBeUndefined();
      expect(landingFor(board, 0, [f("a.patch")], "a.patch")).toEqual({ kind: "patch", files: [f("a.patch")] });
    } finally {
      unregisterBrain("rbrain");
    }
  });
});
