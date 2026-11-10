/**
 * Runs pipeline commands as jobs: one at a time per pipeline (they usually
 * share the GPU), the rest queued in order. Each job's stderr goes to a log;
 * its stdout is read as the tool's JSON result when the pipeline has `json`.
 *
 * Jobs live in memory (the last MAX_JOBS); a restart forgets them, and stops
 * the ones running. Whoever starts a job decides what happens when it ends
 * (`onFinish`): post it, note it for the brain.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PipelineConfig } from "./config.ts";

export type JobState = "queued" | "running" | "done" | "failed" | "stopped";

export interface Job {
  id: string;
  pipeline: string;
  /** What the caller passed (without the program and the json flag). */
  args: string[];
  argv: string[];
  chatId: string;
  state: JobState;
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  exitCode?: number;
  /** The tool's JSON result, when it printed one. */
  result?: Record<string, unknown>;
  /** Why it failed, in one line. */
  error?: string;
  logPath: string;
  /** Set once the caller stopped waiting: the job's end is announced. */
  background?: boolean;
  /** The caller can't relay the result to the chat (a remote brain whose turn ends at an approval): post it. */
  postResult?: boolean;
}

const MAX_JOBS = 100;
const MAX_LOGS = 50;
const LOG_TAIL = 2000;

type Finished = (job: Job) => void | Promise<void>;

export class PipelineRunner {
  private jobs = new Map<string, Job>();
  private queues = new Map<string, Job[]>();
  private running = new Map<string, { job: Job; proc: Bun.Subprocess }>();
  private waiters = new Map<string, (() => void)[]>();
  private configs = new Map<string, PipelineConfig>();
  private seq = 0;

  constructor(private readonly logDir: string, private readonly onFinish: Finished = () => {}) {}

  /** Queue a job; it starts when its pipeline is free. */
  start(p: PipelineConfig, argv: string[], args: string[], chatId: string, id = this.newId(p.name), opts: { postResult?: boolean } = {}): Job {
    const dir = join(this.logDir, p.name);
    mkdirSync(dir, { recursive: true });
    const job: Job = { id, pipeline: p.name, args, argv, chatId, state: "queued", queuedAt: Date.now(), logPath: join(dir, `${id}.log`), ...opts };
    this.jobs.set(id, job);
    this.configs.set(p.name, p);
    this.queues.set(p.name, [...(this.queues.get(p.name) ?? []), job]);
    this.trim();
    this.next(p.name);
    return job;
  }

  /** A fresh job id, for callers that need it before starting (a files folder named after it). */
  newId(pipeline: string): string {
    return `${pipeline}-${Date.now().toString(36)}${(++this.seq).toString(36)}`;
  }

  /**
   * True if the job ended (and its `onFinish` ran) within `ms`. Otherwise the
   * job goes to the background, marked in the same tick, so its end is always
   * announced. A job that ended but is still finishing counts as ended.
   */
  wait(job: Job, ms: number): Promise<boolean> {
    if (this.ended(job) && !this.waiters.has(job.id)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.ended(job)) return resolve(true);
        job.background = true;
        resolve(false);
      }, ms);
      this.waiters.set(job.id, [...(this.waiters.get(job.id) ?? []), () => (clearTimeout(timer), resolve(true))]);
    });
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Newest first. */
  list(): Job[] {
    return [...this.jobs.values()].reverse();
  }

  /** Stop a queued or running job. False if it had already ended. */
  stop(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || this.ended(job)) return false;
    const queue = this.queues.get(job.pipeline) ?? [];
    if (queue.includes(job)) {
      this.queues.set(job.pipeline, queue.filter((j) => j !== job));
      void this.finish(job, "stopped");
      return true;
    }
    job.state = "stopped";
    this.running.get(job.pipeline)?.proc.kill();
    return true;
  }

  /** Stop everything (shutdown). */
  stopAll(): void {
    for (const { proc } of this.running.values()) proc.kill();
  }

  /** The end of a job's log, for status and errors. */
  logTail(job: Job, chars = LOG_TAIL): string {
    try {
      const text = readFileSync(job.logPath, "utf-8");
      return text.length > chars ? `…${text.slice(-chars)}` : text;
    } catch {
      return "";
    }
  }

  /** stop() marks a running job before killing it; read through a call, since it changes while run() awaits. */
  private stopRequested(job: Job): boolean {
    return job.state === "stopped";
  }

  private ended(job: Job): boolean {
    return job.state === "done" || job.state === "failed" || job.state === "stopped";
  }

  private next(pipeline: string): void {
    if (this.running.has(pipeline)) return;
    const queue = this.queues.get(pipeline) ?? [];
    const job = queue.shift();
    if (!job) return;
    this.queues.set(pipeline, queue);
    void this.run(job, this.configs.get(pipeline)!);
  }

  private async run(job: Job, p: PipelineConfig): Promise<void> {
    job.state = "running";
    job.startedAt = Date.now();
    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn(job.argv, { cwd: p.dir, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (e) {
      job.error = `couldn't start: ${e instanceof Error ? e.message : String(e)}`;
      return this.finish(job, "failed");
    }
    this.running.set(p.name, { job, proc });
    const log = Bun.file(job.logPath).writer();
    const drain = async () => {
      for await (const chunk of proc.stderr) log.write(chunk);
    };
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), drain()]);
    job.exitCode = await proc.exited;
    await log.end();
    this.running.delete(p.name);
    if (p.json) job.result = parseResult(stdout);
    else if (stdout.trim()) Bun.write(`${job.logPath}.out`, stdout);
    if (this.stopRequested(job)) return this.finish(job, "stopped");  // stop() killed it
    const ok = job.exitCode === 0 && job.result?.ok !== false;
    if (!ok) {
      const problem = typeof job.result?.problem === "string" ? job.result.problem : undefined;
      job.error = problem ?? (this.logTail(job, 300).trim().split("\n").at(-1) || `exit code ${job.exitCode}`);
    }
    return this.finish(job, ok ? "done" : "failed");
  }

  /** Waiters wake after onFinish, so a caller's answer comes after the job's pictures are posted. */
  private async finish(job: Job, state: JobState): Promise<void> {
    job.state = state;
    job.endedAt = Date.now();
    this.next(job.pipeline);
    try {
      await this.onFinish(job);
    } catch (e) {
      console.error(`[pipelines] after ${job.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const wake of this.waiters.get(job.id) ?? []) wake();
    this.waiters.delete(job.id);
  }

  private trim(): void {
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= MAX_JOBS) break;
      if (this.ended(job)) this.jobs.delete(id);
    }
    try {
      for (const name of readdirSync(this.logDir)) {
        const dir = join(this.logDir, name);
        const logs = readdirSync(dir)
          .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
          .sort((a, b) => b.t - a.t);
        for (const { f } of logs.slice(MAX_LOGS)) rmSync(join(dir, f), { force: true });
      }
    } catch {
      // logs are a convenience
    }
  }
}

/** The tool's JSON result: the whole of stdout, or failing that its last line that parses. */
export function parseResult(stdout: string): Record<string, unknown> | undefined {
  const text = stdout.trim();
  if (!text) return undefined;
  const asObject = (s: string) => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  return asObject(text) ?? text.split("\n").reverse().map(asObject).find(Boolean);
}
