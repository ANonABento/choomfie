#!/usr/bin/env bun
/**
 * Wipe Choomfie state from the SQLite database.
 *
 * Usage:
 *   bun packages/core/scripts/reset.ts            # interactive scope picker
 *   bun packages/core/scripts/reset.ts <scope>    # non-interactive
 *
 * Scopes: core | archival | memory | reminders | birthdays | webhooks | all
 */

import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const DATA_DIR =
  process.env.CHOOMFIE_DATA_DIR ||
  `${process.env.HOME}/.claude/plugins/data/choomfie-inline`;
const DB_PATH = `${DATA_DIR}/choomfie.db`;
const SUPERVISOR_PID_PATH = `${DATA_DIR}/choomfie.pid`;
const DAEMON_PID_PATH = `${DATA_DIR}/meta/meta.pid`;

type ScopeKey =
  | "core"
  | "archival"
  | "memory"
  | "reminders"
  | "birthdays"
  | "webhooks"
  | "all";

type Scope = {
  key: ScopeKey;
  label: string;
  description: string;
  tables: string[];
  wipeFile?: boolean;
};

const SCOPES: Scope[] = [
  {
    key: "core",
    label: "Core memory",
    description:
      "Always-in-context facts (user prefs, active persona personality, project notes). Keeps archival, reminders, birthdays.",
    tables: ["core_memory"],
  },
  {
    key: "archival",
    label: "Archival memory",
    description:
      "Long-term searchable memory + embeddings (conversation summaries, learnings). Keeps core, reminders, birthdays.",
    tables: ["archival_memory_embeddings", "archival_memory"],
  },
  {
    key: "memory",
    label: "All memory (core + archival)",
    description:
      "Wipes core_memory, archival_memory, and embeddings. Keeps reminders, birthdays, allowlist.",
    tables: ["core_memory", "archival_memory_embeddings", "archival_memory"],
  },
  {
    key: "reminders",
    label: "Reminders",
    description:
      "Cancels all scheduled and historical reminders. Memory untouched.",
    tables: ["reminders"],
  },
  {
    key: "birthdays",
    label: "Birthdays",
    description: "Removes saved birthdays. Memory and reminders untouched.",
    tables: ["birthdays"],
  },
  {
    key: "webhooks",
    label: "Incoming webhooks",
    description:
      "Clears the incoming_webhooks queue. Memory, reminders, birthdays untouched.",
    tables: ["incoming_webhooks"],
  },
  {
    key: "all",
    label: "Everything (nuke DB file)",
    description:
      "Deletes choomfie.db and WAL/SHM files. Schema auto-recreates on next start. Allowlist (access.json) and config.json are preserved.",
    tables: [],
    wipeFile: true,
  },
];

function pickByArg(arg: string | undefined): Scope | null {
  if (!arg) return null;
  const norm = arg.toLowerCase();
  return SCOPES.find((s) => s.key === norm) ?? null;
}

async function pickInteractive(): Promise<Scope | null> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    console.log("Choomfie reset — pick what to wipe:\n");
    SCOPES.forEach((s, i) => {
      console.log(`  ${i + 1}. ${s.label} (${s.key})`);
      console.log(`     ${s.description}\n`);
    });
    const answer = (
      await rl.question(`Enter number 1-${SCOPES.length} (or 'q' to cancel): `)
    ).trim();
    if (!answer || answer.toLowerCase() === "q") return null;
    const idx = Number.parseInt(answer, 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= SCOPES.length) {
      console.error(`Invalid choice: ${answer}`);
      return null;
    }
    return SCOPES[idx]!;
  } finally {
    rl.close();
  }
}

async function readPid(pidPath: string): Promise<number | null> {
  if (!existsSync(pidPath)) return null;
  try {
    const raw = await Bun.file(pidPath).text();
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function getProcessCommand(pid: number): Promise<string | null> {
  try {
    const proc = Bun.spawn(["ps", "-p", String(pid), "-o", "command="], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const command = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return command || null;
  } catch {
    return null;
  }
}

function isSupervisorCommand(command: string): boolean {
  return (
    command.includes("choomfie") ||
    command.includes("server.ts") ||
    command.includes("supervisor.ts")
  );
}

function isDaemonCommand(command: string): boolean {
  return command.includes("daemon.ts") || command.includes("choomfie-claude-code");
}

async function stopProcessIfRunning(opts: {
  pidPath: string;
  label: string;
  isExpectedCommand: (command: string) => boolean;
}): Promise<number | null> {
  const pid = await readPid(opts.pidPath);
  if (!pid) return null;

  let command: string | null = null;
  try {
    process.kill(pid, 0);
  } catch {
    await unlink(opts.pidPath).catch(() => {});
    return null;
  }

  command = await getProcessCommand(pid);
  if (!command) {
    return null;
  }

  if (!opts.isExpectedCommand(command)) {
    console.warn(
      `Skipping ${opts.label} pid ${pid}: process command does not look like Choomfie (${command})`
    );
    return null;
  }

  console.log(`Stopping ${opts.label} (pid ${pid})...`);
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    console.warn(`Could not signal pid ${pid}: ${(err as Error).message}`);
    return null;
  }
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      process.kill(pid, 0);
    } catch {
      return pid;
    }
  }
  console.warn(
    `${opts.label} pid ${pid} still alive after 3s — continuing anyway. SQLite WAL may briefly conflict.`
  );
  return pid;
}

async function stopRuntimeProcesses(): Promise<string[]> {
  const stopped: string[] = [];

  const daemonPid = await stopProcessIfRunning({
    pidPath: DAEMON_PID_PATH,
    label: "daemon",
    isExpectedCommand: isDaemonCommand,
  });
  if (daemonPid) stopped.push(`daemon pid ${daemonPid}`);

  const supervisorPid = await stopProcessIfRunning({
    pidPath: SUPERVISOR_PID_PATH,
    label: "Claude Code supervisor",
    isExpectedCommand: isSupervisorCommand,
  });
  if (supervisorPid) stopped.push(`supervisor pid ${supervisorPid}`);

  return stopped;
}

function wipeTables(tables: string[]): Record<string, number> {
  if (!existsSync(DB_PATH)) {
    console.log("No database file yet — nothing to wipe.");
    return {};
  }
  const db = new Database(DB_PATH);
  const counts: Record<string, number> = {};
  try {
    db.exec("PRAGMA foreign_keys = ON");
    for (const table of tables) {
      try {
        const row = db
          .query(`SELECT COUNT(*) as c FROM ${table}`)
          .get() as { c: number } | null;
        const before = row?.c ?? 0;
        db.exec(`DELETE FROM ${table}`);
        counts[table] = before;
      } catch (err) {
        console.warn(
          `  ! ${table}: ${(err as Error).message} (table may not exist yet — skipped)`
        );
      }
    }
    try {
      db.exec("VACUUM");
    } catch (err) {
      console.warn(
        `  · VACUUM skipped (${(err as Error).message}) — rows are deleted, DB just isn't compacted.`
      );
    }
  } finally {
    db.close();
  }
  return counts;
}

function nukeDbFile(): boolean {
  let removed = false;
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) {
      rmSync(p, { force: true });
      removed = true;
    }
  }
  return removed;
}

async function main() {
  const scopeArg = process.argv[2];
  if (scopeArg && !pickByArg(scopeArg)) {
    console.error(
      `Unknown scope: '${scopeArg}'. Valid: ${SCOPES.map((s) => s.key).join(", ")}.`
    );
    process.exit(2);
  }
  const scope = pickByArg(scopeArg) ?? (await pickInteractive());
  if (!scope) {
    console.log("Cancelled.");
    process.exit(0);
  }

  const stoppedProcesses = await stopRuntimeProcesses();

  console.log(`\nWiping: ${scope.label} (${scope.key})`);

  if (scope.wipeFile) {
    const removed = nukeDbFile();
    console.log(removed ? "  ✓ Database file removed." : "  · No DB file present.");
  } else {
    const counts = wipeTables(scope.tables);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    for (const [t, n] of Object.entries(counts)) {
      console.log(`  ✓ ${t}: cleared ${n} row${n === 1 ? "" : "s"}`);
    }
    if (total === 0) console.log("  · Nothing to delete (already empty).");
  }

  if (stoppedProcesses.length > 0) {
    console.log(
      `\nStopped ${stoppedProcesses.join(", ")}. Run 'choomfie claude-code' (or your usual launch) to restart it.`
    );
  } else {
    console.log("\nDone. Next start will pick up the cleared state.");
  }
}

main().catch((err) => {
  console.error(`Reset failed: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
