import { describe, expect, test } from "bun:test";
import { parseTaskList } from "@choomfie/shared";

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

  test("a task line that names its repo carries it", () => {
    const t = parseTaskList(
      "Tasks\n1. [code] Fast mode — in ANonABento/rs3m-twin: `model.build(\"fast\")`. Done when: pytest passes\n2. [code] a/b — Scaffold: x\n3. [code] Docs — in the README: y",
      modes
    );
    expect(t.map((x) => x.repo)).toEqual(["ANonABento/rs3m-twin", "a/b", undefined]);
  });
});
