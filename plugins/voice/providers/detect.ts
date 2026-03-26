/**
 * Detection utilities for checking provider dependencies.
 */

const DETECT_TIMEOUT = 5_000; // 5s — prevent hanging on unresponsive commands

/** Race a promise against a timeout. Returns false on timeout. */
async function withTimeout(promise: Promise<boolean>): Promise<boolean> {
  return Promise.race([
    promise,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), DETECT_TIMEOUT)),
  ]);
}

/** Check if a binary is available on PATH */
export async function checkBinary(name: string): Promise<boolean> {
  return withTimeout(
    (async () => {
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
    })()
  );
}

/** Check if a Python module is importable */
export async function checkPythonModule(module: string): Promise<boolean> {
  return withTimeout(
    (async () => {
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
    })()
  );
}
