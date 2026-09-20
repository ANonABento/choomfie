/**
 * Regression tests for crash-safe file writes.
 *
 * Every JSON file Choomfie owns used to be written by truncating the target and
 * streaming into it, so a crash mid-write left a truncated file. For config.json
 * that loses personas and settings; for access.json, the owner id and allowlist.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SECRET_FILE_MODE,
  writeFileAtomicSync,
  writeJsonAtomicSync,
  writeSecretFileSync,
} from "@choomfie/shared";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "choomfie-atomic-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("atomic writes", () => {
  test("writes contents and creates missing parent directories", () => {
    const path = join(tempDir(), "nested", "deeper", "config.json");
    writeJsonAtomicSync(path, { activePersona: "choomfie" });
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      activePersona: "choomfie",
    });
  });

  test("replaces existing contents completely, never appending", () => {
    const dir = tempDir();
    const path = join(dir, "config.json");
    writeJsonAtomicSync(path, { personas: { a: 1, b: 2, c: 3 } });
    writeJsonAtomicSync(path, { personas: { a: 1 } });
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ personas: { a: 1 } });
  });

  test("a shorter write does not leave trailing bytes of the longer one", () => {
    // The failure mode of truncate-and-stream: overwriting a big file with a
    // small one used to risk a mix of both if the write was interrupted.
    const dir = tempDir();
    const path = join(dir, "config.json");
    writeFileAtomicSync(path, "x".repeat(5000));
    writeFileAtomicSync(path, "short");
    expect(readFileSync(path, "utf-8")).toBe("short");
  });

  test("leaves no temp files behind", () => {
    const dir = tempDir();
    writeJsonAtomicSync(join(dir, "config.json"), { a: 1 });
    writeJsonAtomicSync(join(dir, "config.json"), { a: 2 });
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
    expect(readdirSync(dir)).toEqual(["config.json"]);
  });

  test("an existing file survives a failed write", () => {
    const dir = tempDir();
    const path = join(dir, "config.json");
    writeJsonAtomicSync(path, { keep: "me" });

    // A value JSON.stringify cannot serialize throws mid-write.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => writeJsonAtomicSync(path, circular)).toThrow();

    // The original is intact and no debris was left next to it.
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ keep: "me" });
    expect(readdirSync(dir)).toEqual(["config.json"]);
  });

  test("applies the requested mode, including over a pre-existing loose file", () => {
    const dir = tempDir();
    const path = join(dir, "access.json");
    // Pre-create world-readable, the case writeSecretFile exists to fix.
    writeFileSync(path, "{}", { mode: 0o644 });

    writeSecretFileSync(path, JSON.stringify({ owner: "123" }));

    expect(statSync(path).mode & 0o777).toBe(SECRET_FILE_MODE);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ owner: "123" });
  });

  test("secret writes accept bytes as well as strings", () => {
    const path = join(tempDir(), "access.json");
    writeSecretFileSync(path, new TextEncoder().encode('{"owner":"456"}'));
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ owner: "456" });
  });
});
