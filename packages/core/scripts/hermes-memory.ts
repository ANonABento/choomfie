#!/usr/bin/env bun
/**
 * Export Choomfie Claude Code mode memory for curated Hermes import.
 *
 * This is intentionally read-only. It categorizes durable rows into review
 * buckets and renders a markdown draft; it does not write into Hermes memory.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

interface CoreRow {
  key: string;
  value: string;
  updated_at?: string;
}

interface ArchivalRow {
  id: number;
  content: string;
  tags?: string;
  created_at?: string;
}

interface ReminderRow {
  id: number;
  user_id?: string;
  chat_id?: string;
  message: string;
  due_at?: string;
  cron?: string | null;
  timezone?: string | null;
  category?: string | null;
  fired?: number;
  ack?: number;
}

interface BirthdayRow {
  id: number;
  name: string;
  birthday: string;
  year?: number | null;
  notes?: string | null;
}

interface ExportedMemory {
  version: 1;
  source: string;
  exportedAt: string;
  counts: Record<string, number>;
  categories: Record<string, string[]>;
  raw: {
    coreMemory: CoreRow[];
    archivalMemory: ArchivalRow[];
    activeReminders: ReminderRow[];
    birthdays: BirthdayRow[];
  };
}

function usage(): never {
  console.error(`Usage:
  bun packages/core/scripts/hermes-memory.ts export <choomfie.db> <out.json>
  bun packages/core/scripts/hermes-memory.ts draft <memory.json> <out.md>`);
  process.exit(2);
}

function tableExists(db: Database, name: string): boolean {
  const row = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return Boolean(row);
}

function rows<T>(db: Database, table: string, sql: string): T[] {
  if (!tableExists(db, table)) return [];
  return db.query(sql).all() as T[];
}

function add(categories: Record<string, string[]>, name: string, value: string) {
  const trimmed = value.trim();
  if (!trimmed) return;
  categories[name] ??= [];
  categories[name].push(trimmed);
}

function categorizeCore(categories: Record<string, string[]>, row: CoreRow) {
  const key = row.key.toLowerCase();
  const item = `${row.key}: ${row.value}`;
  if (/(name|profile|birthday|timezone|location|language|identity)/.test(key)) {
    add(categories, "profileFacts", item);
  } else if (/(prefer|preference|like|dislike|style|tone|voice)/.test(key)) {
    add(categories, "preferences", item);
  } else if (/(relationship|friend|family|team|coworker|server|discord)/.test(key)) {
    add(categories, "relationshipContext", item);
  } else if (/(workflow|routine|recurring|project|task|goal|bento)/.test(key)) {
    add(categories, "recurringWorkflows", item);
  } else {
    add(categories, "durableNotes", item);
  }
}

function categorizeArchival(categories: Record<string, string[]>, row: ArchivalRow) {
  const haystack = `${row.tags ?? ""} ${row.content}`.toLowerCase();
  const item = row.tags ? `${row.content} [${row.tags}]` : row.content;
  if (/(profile|birthday|timezone|location|language|identity)/.test(haystack)) {
    add(categories, "profileFacts", item);
  } else if (/(prefer|preference|like|dislike|style|tone|voice)/.test(haystack)) {
    add(categories, "preferences", item);
  } else if (/(relationship|friend|family|team|coworker|server|discord)/.test(haystack)) {
    add(categories, "relationshipContext", item);
  } else if (/(workflow|routine|recurring|project|task|goal|bento|remind)/.test(haystack)) {
    add(categories, "recurringWorkflows", item);
  } else {
    add(categories, "durableNotes", item);
  }
}

function exportMemory(dbPath: string, outPath: string) {
  if (!existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }

  const db = new Database(dbPath, { readonly: true });
  const coreMemory = rows<CoreRow>(
    db,
    "core_memory",
    "SELECT key, value, updated_at FROM core_memory ORDER BY updated_at ASC, key ASC"
  );
  const archivalMemory = rows<ArchivalRow>(
    db,
    "archival_memory",
    "SELECT id, content, tags, created_at FROM archival_memory ORDER BY created_at ASC, id ASC"
  );
  const activeReminders = rows<ReminderRow>(
    db,
    "reminders",
    "SELECT id, user_id, chat_id, message, due_at, cron, timezone, category, fired, ack FROM reminders WHERE fired = 0 OR (fired = 1 AND ack = 0) ORDER BY due_at ASC, id ASC"
  );
  const birthdays = rows<BirthdayRow>(
    db,
    "birthdays",
    "SELECT id, name, birthday, year, notes FROM birthdays ORDER BY name COLLATE NOCASE ASC"
  );
  db.close();

  const categories: Record<string, string[]> = {
    profileFacts: [],
    preferences: [],
    relationshipContext: [],
    recurringWorkflows: [],
    durableNotes: [],
  };

  for (const row of coreMemory) categorizeCore(categories, row);
  for (const row of archivalMemory) categorizeArchival(categories, row);
  for (const row of activeReminders) {
    add(
      categories,
      "recurringWorkflows",
      `Reminder #${row.id}: ${row.message} due ${row.due_at ?? "unknown"}${row.cron ? ` cron=${row.cron}` : ""}`
    );
  }
  for (const row of birthdays) {
    add(
      categories,
      "profileFacts",
      `Birthday: ${row.name} ${row.birthday}${row.year ? ` (${row.year})` : ""}${row.notes ? ` - ${row.notes}` : ""}`
    );
  }

  const exported: ExportedMemory = {
    version: 1,
    source: dbPath,
    exportedAt: new Date().toISOString(),
    counts: {
      coreMemory: coreMemory.length,
      archivalMemory: archivalMemory.length,
      activeReminders: activeReminders.length,
      birthdays: birthdays.length,
    },
    categories,
    raw: {
      coreMemory,
      archivalMemory,
      activeReminders,
      birthdays,
    },
  };

  writeFileSync(outPath, `${JSON.stringify(exported, null, 2)}\n`);
  console.log(`Exported Choomfie memory draft data to ${outPath}`);
}

function renderList(items: string[]): string {
  if (!items.length) return "_No candidates._\n";
  return `${items.map((item) => `- ${item}`).join("\n")}\n`;
}

function draftMemory(jsonPath: string, outPath: string) {
  const exported = JSON.parse(readFileSync(jsonPath, "utf-8")) as ExportedMemory;
  const categories = exported.categories ?? {};
  const lines = [
    "# Choomfie Memory Import Draft",
    "",
    `Source: \`${exported.source}\``,
    `Exported: ${exported.exportedAt}`,
    "",
    "Review this file before copying anything into Hermes memory. Delete stale, sensitive, or low-value entries.",
    "",
    "## Profile Facts",
    "",
    renderList(categories.profileFacts ?? []),
    "## Preferences",
    "",
    renderList(categories.preferences ?? []),
    "## Relationship Context",
    "",
    renderList(categories.relationshipContext ?? []),
    "## Recurring Workflows",
    "",
    renderList(categories.recurringWorkflows ?? []),
    "## Durable Notes",
    "",
    renderList(categories.durableNotes ?? []),
    "## Counts",
    "",
    ...Object.entries(exported.counts ?? {}).map(([key, value]) => `- ${key}: ${value}`),
    "",
  ];

  writeFileSync(outPath, lines.join("\n"));
  console.log(`Rendered Choomfie memory import draft to ${outPath}`);
}

const [command, input, output] = process.argv.slice(2);
if (!command || !input || !output) usage();

try {
  if (command === "export") {
    exportMemory(input, output);
  } else if (command === "draft") {
    draftMemory(input, output);
  } else {
    usage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
