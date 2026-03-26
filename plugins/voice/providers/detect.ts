/**
 * Detection utilities for checking provider dependencies.
 */

/** Check if a binary is available on PATH */
export async function checkBinary(name: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", name], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

/** Check if a Python module is importable */
export async function checkPythonModule(module: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(
      ["python3", "-c", `import ${module}`],
      { stdout: "pipe", stderr: "pipe" }
    );
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}
