/** One harness run: spawn the CLI, no shell, stdin closed, killed on stop or timeout. */

export interface RunOutput {
  stdout: string;
  stderr: string;
  code: number | null;
  /** Killed by the signal or the timeout. */
  killed?: "stopped" | "timeout";
}

export type Spawner = (cmd: string[], opts: { cwd: string; signal: AbortSignal; timeoutMs: number }) => Promise<RunOutput>;

export const spawnCli: Spawner = async (cmd, { cwd, signal, timeoutMs }) => {
  const proc = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  let killed: RunOutput["killed"];
  const kill = (why: "stopped" | "timeout") => {
    killed ??= why;
    proc.kill();
  };
  const onAbort = () => kill("stopped");
  if (signal.aborted) onAbort();
  signal.addEventListener("abort", onAbort);
  const timer = setTimeout(() => kill("timeout"), timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    return { stdout, stderr, code, ...(killed ? { killed } : {}) };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
};
