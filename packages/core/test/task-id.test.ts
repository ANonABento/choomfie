import { describe, expect, test } from "bun:test";
import { parseTaskList } from "../../shared/brains";

describe("task ids", () => {
  test("11b keeps its letter; plain numbers have no id", () => {
    const tasks = parseTaskList("Tasks\n11. [code] UE project: x\n11b. [code] Toon shader: y\n12. [code] Pawn: z", ["code"]);
    expect(tasks.map((t) => t.id ?? String(t.n))).toEqual(["11", "11b", "12"]);
    expect(tasks[1].title).toBe("Toon shader");
    expect(tasks[0].id).toBeUndefined();
  });
});
