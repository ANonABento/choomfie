import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BirthdayScheduler,
  getBirthdayOccurrence,
  parseBirthdayInput,
  sortBirthdayOccurrences,
} from "../lib/birthdays.ts";
import { MemoryStore } from "../lib/memory.ts";
import { birthdayTools } from "../lib/tools/birthday-tools.ts";
import { getAllTools } from "../lib/tools/index.ts";
import type { AppContext, ToolResult } from "../lib/types.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {}))
  );
});

async function makeMemory(): Promise<MemoryStore> {
  const dir = await mkdtemp(join(tmpdir(), "choomfie-birthdays-"));
  tempDirs.push(dir);
  return new MemoryStore(join(dir, "choomfie.db"));
}

function fakeContext(memory: MemoryStore): AppContext {
  return { memory } as unknown as AppContext;
}

function tool(name: string): (typeof birthdayTools)[number] {
  const found = birthdayTools.find((t) => t.definition.name === name);
  expect(found).toBeDefined();
  return found!;
}

function resultText(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}

test("parseBirthdayInput accepts MM-DD and YYYY-MM-DD", () => {
  expect(parseBirthdayInput("4-5")).toEqual({ birthday: "04-05", year: null });
  expect(parseBirthdayInput("1990-04-05")).toEqual({ birthday: "04-05", year: 1990 });
  expect(parseBirthdayInput("02-29")).toEqual({ birthday: "02-29", year: null });
  expect(parseBirthdayInput("02-30")).toBeNull();
  expect(parseBirthdayInput("2023-02-29")).toBeNull();
});

test("MemoryStore adds, updates, and removes birthdays case-insensitively", async () => {
  const memory = await makeMemory();

  const id = memory.addBirthday("Ada", "12-10", { year: 1815, notes: "math" });
  expect(memory.getBirthdayByName("ada")?.id).toBe(id);
  expect(memory.getBirthdayByName("ADA")?.notes).toBe("math");

  const updatedId = memory.addBirthday("ADA", "12-10", {
    userId: "123",
    year: 1815,
  });
  expect(updatedId).toBe(id);
  expect(memory.listBirthdays()).toHaveLength(1);
  expect(memory.getBirthdayByName("Ada")?.userId).toBe("123");

  expect(memory.removeBirthday("ada")).toBe(true);
  expect(memory.listBirthdays()).toHaveLength(0);
  memory.close();
});

test("birthdays persist across SQLite reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "choomfie-birthdays-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "choomfie.db");

  const first = new MemoryStore(dbPath);
  const id = first.addBirthday("Ada", "12-10", { year: 1815, notes: "math" });
  first.close();

  const second = new MemoryStore(dbPath);
  const saved = second.getBirthdayByName("ada");
  expect(saved?.id).toBe(id);
  expect(saved?.birthday).toBe("12-10");
  expect(saved?.year).toBe(1815);
  expect(saved?.notes).toBe("math");
  second.close();
});

test("birthday occurrence sorting uses next local calendar occurrence", async () => {
  const memory = await makeMemory();
  memory.addBirthday("Soon", "04-27");
  memory.addBirthday("Today", "04-25", { year: 2000 });
  memory.addBirthday("Past", "04-24");

  const from = new Date(2026, 3, 25, 12, 0, 0);
  const sorted = sortBirthdayOccurrences(memory.listBirthdays(), from);

  expect(sorted.map((item) => item.birthday.name)).toEqual(["Today", "Soon", "Past"]);
  expect(sorted[0].daysUntil).toBe(0);
  expect(sorted[0].turningAge).toBe(26);
  expect(sorted[2].nextDate).toBe("2027-04-24");
  memory.close();
});

test("leap day birthdays use the next real leap-day occurrence", async () => {
  const memory = await makeMemory();
  memory.addBirthday("Leap", "02-29", { year: 2000 });

  const saved = memory.getBirthdayByName("Leap")!;
  const occurrence = getBirthdayOccurrence(saved, new Date(2026, 0, 1, 12, 0, 0));
  expect(occurrence.nextDate).toBe("2028-02-29");
  expect(occurrence.turningAge).toBe(28);
  memory.close();
});

test("birthday_add stores inferred year and upcoming filters by day range", async () => {
  const memory = await makeMemory();
  const ctx = fakeContext(memory);

  const add = await tool("birthday_add").handler(
    {
      name: "Grace",
      birthday: "1906-12-09",
      user_id: "42",
      notes: "compiler cake",
    },
    ctx
  );
  expect(add.isError).toBeUndefined();
  expect(resultText(add)).toContain("Year: 1906");

  const saved = memory.getBirthdayByName("grace")!;
  expect(saved.birthday).toBe("12-09");
  expect(saved.year).toBe(1906);
  expect(saved.userId).toBe("42");

  const occurrence = getBirthdayOccurrence(saved, new Date(2026, 11, 1, 12, 0, 0));
  expect(occurrence.daysUntil).toBe(8);
  expect(occurrence.turningAge).toBe(120);
  memory.close();
});

test("birthday_remove reports missing names", async () => {
  const memory = await makeMemory();
  const result = await tool("birthday_remove").handler({ name: "Nobody" }, fakeContext(memory));

  expect(result.isError).toBe(true);
  expect(resultText(result)).toContain("No birthday found");
  memory.close();
});

test("core tool registry includes birthday tools", async () => {
  const memory = await makeMemory();
  const names = getAllTools({
    memory,
    plugins: [],
  } as unknown as AppContext).map((item) => item.definition.name);

  expect(names).toContain("birthday_add");
  expect(names).toContain("birthday_remove");
  expect(names).toContain("birthday_list");
  expect(names).toContain("birthday_upcoming");
  memory.close();
});

test("BirthdayScheduler sends today's birthday reminder once and skips upcoming-only reminders", async () => {
  const memory = await makeMemory();
  memory.addBirthday("Today", "04-25", { year: 2000 });
  memory.addBirthday("Tomorrow", "04-26");
  const sent: string[] = [];
  const ctx = {
    memory,
    ownerUserId: "owner",
    messageStats: { sent: 0 },
    discord: {
      users: {
        fetch: async (id: string) => {
          expect(id).toBe("owner");
          return {
            send: async (message: string) => {
              sent.push(message);
            },
          };
        },
      },
    },
  } as unknown as AppContext;

  const scheduler = new BirthdayScheduler(ctx);
  await scheduler.runDailyCheck(new Date(2026, 3, 25, 1, 0, 0));
  await scheduler.runDailyCheck(new Date(2026, 3, 25, 12, 0, 0));

  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("Today");
  expect(sent[0]).not.toContain("Tomorrow");
  expect(ctx.messageStats.sent).toBe(1);

  const today = memory.getBirthdayByName("Today");
  const tomorrow = memory.getBirthdayByName("Tomorrow");
  expect(today?.lastRemindedOn).toBe("2026-04-25");
  expect(tomorrow?.lastRemindedOn).toBeNull();
  memory.close();
});
