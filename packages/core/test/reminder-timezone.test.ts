import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeSnoozeDueDate } from "../lib/handlers/reminder-buttons.ts";
import { MemoryStore } from "../lib/memory.ts";
import { getNextCronDate } from "../lib/reminders.ts";
import { dateToSQLite, fromSQLiteDatetime } from "../lib/time.ts";
import { reminderTools } from "../lib/tools/reminder-tools.ts";
import type { AppContext } from "../lib/types.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {}))
  );
});

async function makeMemory() {
  const dir = await mkdtemp(join(tmpdir(), "choomfie-reminder-tz-"));
  tempDirs.push(dir);
  return {
    memory: new MemoryStore(join(dir, "choomfie.db")),
    path: join(dir, "choomfie.db"),
  };
}

function fakeContext(memory: MemoryStore): AppContext {
  return {
    memory,
    reminderScheduler: {
      scheduleReminder() {},
      clearTimer() {},
      clearNagTimer() {},
    },
  } as unknown as AppContext;
}

function tool(name: string) {
  const found = reminderTools.find((t) => t.definition.name === name);
  expect(found).toBeDefined();
  return found!;
}

function resultText(result: Awaited<ReturnType<(typeof reminderTools)[number]["handler"]>>): string {
  return result.content[0]?.text ?? "";
}

test("MemoryStore persists reminder timezone across reopen", async () => {
  const { memory, path } = await makeMemory();

  const id = memory.addReminder("u1", "c1", "standup", "2026-04-25 13:00:00", {
    timezone: "America/New_York",
  });
  expect(memory.getReminder(id)?.timezone).toBe("America/New_York");
  memory.close();

  const reopened = new MemoryStore(path);
  expect(reopened.getReminder(id)?.timezone).toBe("America/New_York");
  reopened.close();
});

test("set_reminder parses local wall-clock input with timezone into UTC storage", async () => {
  const { memory } = await makeMemory();
  const result = await tool("set_reminder").handler(
    {
      user_id: "u1",
      chat_id: "c1",
      message: "coffee",
      due_at: "2026-04-25 09:00",
      timezone: "America/New_York",
    },
    fakeContext(memory)
  );

  expect(result.isError).toBeUndefined();
  expect(resultText(result)).toContain("Timezone: America/New_York");

  const reminder = memory.getActiveReminders("u1")[0];
  expect(reminder.dueAt).toBe("2026-04-25 13:00:00");
  expect(reminder.timezone).toBe("America/New_York");
  memory.close();
});

test("set_reminder rejects invalid timezone names", async () => {
  const { memory } = await makeMemory();
  const result = await tool("set_reminder").handler(
    {
      user_id: "u1",
      chat_id: "c1",
      message: "coffee",
      due_at: "2026-04-25 09:00",
      timezone: "Mars/Base",
    },
    fakeContext(memory)
  );

  expect(result.isError).toBe(true);
  expect(memory.getActiveReminders("u1")).toHaveLength(0);
  memory.close();
});

test("set_reminder treats blank timezone as omitted", async () => {
  const { memory } = await makeMemory();
  const result = await tool("set_reminder").handler(
    {
      user_id: "u1",
      chat_id: "c1",
      message: "coffee",
      due_at: "2026-04-25 09:00",
      timezone: "  ",
    },
    fakeContext(memory)
  );

  expect(result.isError).toBeUndefined();
  const reminder = memory.getActiveReminders("u1")[0];
  expect(reminder.dueAt).toBe("2026-04-25 09:00:00");
  expect(reminder.timezone).toBeNull();
  memory.close();
});

test("set_reminder rejects invalid cron patterns", async () => {
  const { memory } = await makeMemory();
  const result = await tool("set_reminder").handler(
    {
      user_id: "u1",
      chat_id: "c1",
      message: "coffee",
      due_at: "2026-04-25 09:00",
      cron: "every weekday",
    },
    fakeContext(memory)
  );

  expect(result.isError).toBe(true);
  expect(memory.getActiveReminders("u1")).toHaveLength(0);
  memory.close();
});

test("set_reminder stores exact ISO instants without timezone reinterpretation", async () => {
  const { memory } = await makeMemory();
  const result = await tool("set_reminder").handler(
    {
      user_id: "u1",
      chat_id: "c1",
      message: "exact",
      due_at: "2026-04-25T14:30:00Z",
      timezone: "America/New_York",
    },
    fakeContext(memory)
  );

  expect(result.isError).toBeUndefined();
  const reminder = memory.getActiveReminders("u1")[0];
  expect(reminder.dueAt).toBe("2026-04-25 14:30:00");
  memory.close();
});

test("snooze_reminder parses local wall-clock input with timezone", async () => {
  const { memory } = await makeMemory();
  const id = memory.addReminder("u1", "c1", "later", "2026-04-25 12:00:00");

  const result = await tool("snooze_reminder").handler(
    {
      id,
      due_at: "2026-04-25 09:00",
      timezone: "America/New_York",
    },
    fakeContext(memory)
  );

  expect(result.isError).toBeUndefined();
  const reminder = memory.getReminder(id)!;
  expect(reminder.dueAt).toBe("2026-04-25 13:00:00");
  expect(reminder.timezone).toBe("America/New_York");
  memory.close();
});

test("existing UTC reminders without timezone still parse from SQLite as UTC", async () => {
  const { memory } = await makeMemory();
  const id = memory.addReminder("u1", "c1", "utc", "2026-04-25 12:00:00");
  const reminder = memory.getReminder(id)!;

  expect(reminder.timezone).toBeNull();
  expect(fromSQLiteDatetime(reminder.dueAt).toISOString()).toBe(
    "2026-04-25T12:00:00.000Z"
  );
  memory.close();
});

test("daily recurrence with timezone preserves local wall-clock time across DST", () => {
  const first = new Date("2026-03-07T14:00:00Z");
  const next = getNextCronDate("daily", first, "America/New_York");

  expect(dateToSQLite(next!)).toBe("2026-03-08 13:00:00");
});

test("timezone Tomorrow button snooze uses click time local calendar day", () => {
  const clickedAt = new Date("2026-03-07T17:00:00Z"); // noon in New York before DST starts
  const next = computeSnoozeDueDate(
    "tomorrow",
    { timezone: "America/New_York" },
    clickedAt
  );

  expect(dateToSQLite(next!)).toBe("2026-03-08 16:00:00");
});

test("Tomorrow button snooze without timezone keeps 24 hour fallback", () => {
  const clickedAt = new Date("2026-03-07T17:00:00Z");
  const next = computeSnoozeDueDate("tomorrow", { timezone: null }, clickedAt);

  expect(dateToSQLite(next!)).toBe("2026-03-08 17:00:00");
});

test("set_reminder from a /choomfie chat goes to the user's DM, since that chat can't receive it", async () => {
  const { memory } = await makeMemory();
  const ctx = {
    ...fakeContext(memory),
    discord: { users: { fetch: async (id: string) => ({ createDM: async () => ({ id: `dm-${id}` }) }) } },
  } as unknown as AppContext;
  const result = await tool("set_reminder").handler(
    { user_id: "u1", chat_id: "ask:999", message: "stretch", due_at: "in 1h" },
    ctx
  );
  expect(result.isError).toBeUndefined();
  expect(resultText(result)).toContain("Delivered by DM");
  expect(memory.getActiveReminders().find((r) => r.message === "stretch")?.chatId).toBe("dm-u1");
  memory.close();
});
