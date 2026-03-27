/**
 * Detection utilities for checking provider dependencies.
 */

import type { Subprocess } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DETECT_TIMEOUT = 5_000; // 5s — prevent hanging on unresponsive commands

/** Path to the project .venv python, if it exists */
// import.meta.dir = plugins/voice/providers/ — go up 3 levels to project root
const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..");
const VENV_PYTHON = join(PROJECT_ROOT, ".venv", "bin", "python3");

/** Get the best python3 binary — prefer project .venv, fall back to system */
export function getPython(): string {
  return existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";
}

/** Run a spawned process with a timeout. Kills the process if it exceeds the limit. */
async function spawnWithTimeout(
  cmd: string[],
): Promise<{ exitCode: number | null }> {
  let proc: Subprocess;
  try {
    proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  } catch {
    return { exitCode: 1 };
  }

  const timer = setTimeout(() => {
    try { proc.kill(); } catch { /* already dead */ }
  }, DETECT_TIMEOUT);

  try {
    await proc.exited;
    return { exitCode: proc.exitCode };
  } catch {
    return { exitCode: 1 };
  } finally {
    clearTimeout(timer);
  }
}

/** Check if a binary is available on PATH */
export async function checkBinary(name: string): Promise<boolean> {
  const result = await spawnWithTimeout(["which", name]);
  return result.exitCode === 0;
}

/** Check if a Python module is importable */
export async function checkPythonModule(module: string): Promise<boolean> {
  const result = await spawnWithTimeout([getPython(), "-c", `import ${module}`]);
  return result.exitCode === 0;
}
