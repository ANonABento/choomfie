import { describe, expect, test } from "bun:test";
import { parseTaskList, taskRepo } from "@choomfie/shared";

const modes = ["code", "cad", "plan"];

describe("parseTaskList", () => {
  test("reads the list after a Tasks line, with title and full spec", () => {
    const text = [
      "Here's the plan: [plan.md](x)",
      "",
      "**Tasks**",
      "1. [cad] Motor mount — 40 x 30 plate. Done when: cad_check passes",
      "2) [code] Servo driver: add PWM to ANonABento/robot. Done when: tests pass",
      "",
      "Shall I start?",
    ].join("\n");
    expect(parseTaskList(text, modes)).toEqual([
      { n: 1, mode: "cad", title: "Motor mount", spec: "Motor mount — 40 x 30 plate. Done when: cad_check passes" },
      { n: 2, mode: "code", title: "Servo driver", spec: "Servo driver: add PWM to ANonABento/robot. Done when: tests pass" },
    ]);
  });

  test("no Tasks line, unknown modes, or text after the list are ignored", () => {
    expect(parseTaskList("1. [cad] x — y", modes)).toEqual([]);
    expect(parseTaskList("Tasks\n1. [paint] x — y\n2. [cad] z — w", modes).map((t) => t.n)).toEqual([2]);
    expect(parseTaskList("## Tasks:\n1. [cad] a — b\nNotes\n3. [cad] c — d", modes).map((t) => t.n)).toEqual([1]);
    expect(parseTaskList("Tasks\n" + Array.from({ length: 30 }, (_, i) => `${i + 1}. [code] t${i} — s`).join("\n"), modes)).toHaveLength(25);
  });

  test("a task's sub-lines stay in its spec (a task once went out as just its heading)", () => {
    const text = [
      "Tasks",
      "1. [code] Atomic multi-file commits — in ANonABento/choomfie, on a new branch `fix/atomic-commit`:",
      "   - **Find the commit step.** Replace it with the Git Data API:",
      "     - Create one commit whose parent is the head.",
      "   - **Tests.** Mock the GitHub API.",
      "2. [paint] Skipped — x:",
      "   - not part of task 3",
      "3. [cad] Mount — plate:",
      "- 40 x 30",
      "",
      "Shall I start?",
    ].join("\n");
    const t = parseTaskList(text, modes);
    expect(t.map((x) => x.n)).toEqual([1, 3]);
    expect(t[0].spec).toBe(
      "Atomic multi-file commits — in ANonABento/choomfie, on a new branch `fix/atomic-commit`:\n" +
        "   - Find the commit step. Replace it with the Git Data API:\n" +
        "     - Create one commit whose parent is the head.\n" +
        "   - Tests. Mock the GitHub API."
    );
    expect(t[0]).toMatchObject({ title: "Atomic multi-file commits", repo: "ANonABento/choomfie" });
    expect(t[1].spec).toBe("Mount — plate:\n- 40 x 30");
    // A bullet after a line that doesn't introduce a list is not the task's.
    expect(parseTaskList("Tasks\n1. [cad] a — b\n- Risk: c", modes)[0].spec).toBe("a — b");
  });

  test("a task line that names its repo carries it", () => {
    const t = parseTaskList(
      "Tasks\n1. [code] Fast mode — in ANonABento/rs3m-twin: `model.build(\"fast\")`. Done when: pytest passes\n2. [code] a/b — Scaffold: x\n3. [code] Docs — in the README: y",
      modes
    );
    expect(t.map((x) => x.repo)).toEqual(["ANonABento/rs3m-twin", "a/b", undefined]);
  });

  test("taskRepo finds the repo however the line puts it (lines seen 2026-11-08), and not file paths", () => {
    expect(taskRepo("Scaffold + params + geometry: in ANonABento/rs3m-twin (new repo), create the Python package")).toBe("ANonABento/rs3m-twin");
    expect(taskRepo("Fast mode turning: in ANonABento/rs3m-twin, add 6 face hinges")).toBe("ANonABento/rs3m-twin");
    expect(taskRepo("Fix it in `a/b`.")).toBe("a/b");
    expect(taskRepo("Edit the loader in rs3m_twin/params.py, then test")).toBeUndefined();
    expect(taskRepo("Put it in src/index.ts")).toBeUndefined();
    expect(taskRepo("Plain task with no repo")).toBeUndefined();
  });
});
