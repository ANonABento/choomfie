import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "../lib/which.ts";

test("which finds a tool outside PATH in the usual spots, else returns the name", () => {
  const dir = mkdtempSync(join(tmpdir(), "which-"));
  try {
    const tool = join(dir, "choomfie-test-tool-xyz");
    writeFileSync(tool, "#!/bin/sh\n");
    chmodSync(tool, 0o755);
    expect(which("choomfie-test-tool-xyz", [dir])).toBe(tool);
    expect(which("choomfie-missing-tool-xyz", [dir])).toBe("choomfie-missing-tool-xyz");
    expect(which("git")).toMatch(/\/git$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
