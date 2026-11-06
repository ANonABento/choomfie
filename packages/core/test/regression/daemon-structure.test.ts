import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CORE_DIR = join(import.meta.dir, "../..");
const DAEMON_DIR = join(CORE_DIR, "daemon");
const ENTRYPOINT_PATH = join(CORE_DIR, "daemon.ts");

const EXPECTED_FILES = [
  "chat-session.ts",
  "cli.ts",
  "constants.ts",
  "flags.ts",
  "hub.ts",
  "lifecycle.ts",
  "log.ts",
  "message-generator.ts",
  "pid.ts",
  "pool.ts",
  "runtime.ts",
  "seeds.ts",
  "session-core.ts",
  "state-file.ts",
  "types.ts",
];

/**
 * The one daemon module allowed into core's lib/: hub.ts runs the worker
 * (WorkerHost, shared with the supervisor), serves its tools (remote-mcp) and
 * reads chat bindings (ChatStore). Everything else stays independent of it.
 */
const LIB_IMPORTERS = new Set(["hub.ts"]);

function getTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") {
      files.push(...getTsFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("daemon structure regression", () => {
  test("daemon refactor files exist", () => {
    expect(existsSync(DAEMON_DIR)).toBe(true);
    for (const file of EXPECTED_FILES) {
      expect(existsSync(join(DAEMON_DIR, file))).toBe(true);
    }
    expect(existsSync(join(DAEMON_DIR, "index.ts"))).toBe(false);
  });

  test("entrypoint stays thin and does not embed session implementation", () => {
    const content = readFileSync(ENTRYPOINT_PATH, "utf-8");
    const lineCount = content.trim().split("\n").length;

    expect(lineCount).toBeLessThan(120);
    expect(content.includes('@anthropic-ai/claude-agent-sdk')).toBe(false);
    expect(content.includes("function startSession(")).toBe(false);
    expect(content.includes("function cycleSession(")).toBe(false);
    expect(content.includes("createMessageGenerator(")).toBe(false);
  });

  test("daemon modules do not import core lib via relative paths", () => {
    const violations: string[] = [];

    for (const file of getTsFiles(DAEMON_DIR)) {
      if (LIB_IMPORTERS.has(file.slice(DAEMON_DIR.length + 1))) continue;
      const content = readFileSync(file, "utf-8");
      const libImports = content.match(/from\s+["'](?:\.\.\/)+lib\/[^"']+["']/g);
      if (libImports) {
        const relative = file.replace(`${CORE_DIR}/`, "");
        for (const imp of libImports) {
          violations.push(`${relative}: ${imp}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
