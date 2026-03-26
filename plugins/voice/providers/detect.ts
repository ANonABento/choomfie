/**
 * Detection utilities for checking provider dependencies.
 */

import type { Subprocess } from "bun";

const DETECT_TIMEOUT = 5_000; // 5s — prevent hanging on unresponsive commands

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
  const result = await spawnWithTimeout(["python3", "-c", `import ${module}`]);
  return result.exitCode === 0;
}
