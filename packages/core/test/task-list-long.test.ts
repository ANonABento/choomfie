import { expect, test } from "bun:test";
import { parseTaskList } from "@choomfie/shared";

test("11b doesn't end the list, and 27 tasks all parse", () => {
  const lines = ["Tasks"];
  for (let n = 1; n <= 26; n++) {
    lines.push(`${n}. [code] Task ${n}: do thing ${n}. Done when: ok`);
    if (n === 11) lines.push("11b. [code] Toon shader: outline. Done when: ok");
  }
  const tasks = parseTaskList(lines.join("\n"), ["code", "research"]);
  expect(tasks.length).toBe(27);
  expect(tasks[11].title).toBe("Toon shader");
  expect(tasks[26].n).toBe(26);
});
