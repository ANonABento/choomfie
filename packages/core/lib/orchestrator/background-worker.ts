/**
 * BackgroundWorker — pulls bento-ya pipeline tasks while Discord is idle and
 * runs them through the coding model. Polls a thin HTTP API rather than
 * sharing a database with bento-ya so we stay decoupled.
 */

import type { ChatProvider } from "./chat-provider.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { IdleMonitor } from "./idle-monitor.ts";

export interface BentoyaTask {
  id: string;
  title: string;
  prompt: string;
  context?: string;
}

export interface BackgroundWorkerOptions {
  enabled: boolean;
  apiUrl: string;
  /** Poll interval when idle (ms) */
  pollIntervalMs?: number;
  /** Max concurrent tasks (almost always 1) */
  concurrency?: number;
  /** Per-task hard timeout (ms) */
  taskTimeoutMs?: number;
  /** Logger, defaults to console.error */
  log?: (msg: string) => void;
}

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_TASK_TIMEOUT_MS = 5 * 60_000;

export class BackgroundWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = 0;
  private stopped = true;
  private inFlight = new Set<AbortController>();

  constructor(
    private provider: ChatProvider,
    private registry: ModelRegistry,
    private idle: IdleMonitor,
    private options: BackgroundWorkerOptions,
  ) {}

  start(): void {
    if (!this.options.enabled || !this.stopped) return;
    if (!isUsableApiUrl(this.options.apiUrl)) {
      this.log(
        `background worker disabled: bentoyaApiUrl='${this.options.apiUrl}' is a placeholder. ` +
          `Set local.backgroundTasks.bentoyaApiUrl to your bento-ya endpoint to enable.`,
      );
      return;
    }
    this.stopped = false;
    this.scheduleNext(1000);
    this.log("background worker started");
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();
    this.log("background worker stopped");
  }

  isRunning(): boolean {
    return !this.stopped;
  }

  status(): { running: boolean; inFlight: number; apiUrl: string } {
    return {
      running: !this.stopped,
      inFlight: this.running,
      apiUrl: this.options.apiUrl,
    };
  }

  private scheduleNext(ms: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.tick().catch((e) => this.log(`tick error: ${e}`));
    }, ms);
  }

  private async tick() {
    if (this.stopped) return;
    const interval = this.options.pollIntervalMs ?? DEFAULT_POLL_MS;
    const concurrency = this.options.concurrency ?? 1;

    if (this.running >= concurrency) {
      this.scheduleNext(interval);
      return;
    }

    const status = await this.idle.canRunBackground();
    if (!status.ok) {
      this.scheduleNext(interval);
      return;
    }

    let task: BentoyaTask | null = null;
    try {
      task = await this.fetchNextTask();
    } catch (e) {
      this.log(`fetchNextTask failed: ${e}`);
      this.scheduleNext(interval);
      return;
    }

    if (!task) {
      this.scheduleNext(interval);
      return;
    }

    this.runTask(task).finally(() => {
      this.scheduleNext(1000);
    });
  }

  private async fetchNextTask(): Promise<BentoyaTask | null> {
    const url = joinUrl(this.options.apiUrl, "/tasks/next");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worker: "choomfie-local" }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 204 || res.status === 404) return null;
    if (!res.ok) throw new Error(`tasks/next ${res.status}`);
    const data = (await res.json()) as Partial<BentoyaTask> | null;
    if (!data?.id || !data.prompt) return null;
    return {
      id: data.id,
      title: data.title ?? data.id,
      prompt: data.prompt,
      context: data.context,
    };
  }

  private async runTask(task: BentoyaTask): Promise<void> {
    this.running++;
    const controller = new AbortController();
    this.inFlight.add(controller);
    const timeoutMs = this.options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const codingModel = this.registry.getSelection().coding;

    this.log(`task ${task.id} → ${codingModel}: ${task.title}`);
    try {
      const res = await this.provider.chat({
        model: codingModel,
        signal: controller.signal,
        messages: [
          {
            role: "system",
            content:
              "You are a background coding assistant. Be terse, return only the deliverable.",
          },
          ...(task.context
            ? [{ role: "user" as const, content: `Context:\n${task.context}` }]
            : []),
          { role: "user", content: task.prompt },
        ],
      });
      await this.reportResult(task.id, "ok", res.text);
      this.log(
        `task ${task.id} done in ${(res.totalMs / 1000).toFixed(1)}s` +
          (res.tps ? ` @ ${res.tps.toFixed(1)} tok/s` : ""),
      );
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      await this.reportResult(task.id, "error", message).catch(() => {});
      this.log(`task ${task.id} failed: ${message}`);
    } finally {
      clearTimeout(timer);
      this.inFlight.delete(controller);
      this.running--;
    }
  }

  private async reportResult(
    id: string,
    status: "ok" | "error",
    output: string,
  ): Promise<void> {
    const url = joinUrl(this.options.apiUrl, `/tasks/${encodeURIComponent(id)}/result`);
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, output }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }

  private log(msg: string) {
    (this.options.log ?? ((m: string) => console.error(`[bg] ${m}`)))(msg);
  }
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`);
}

/**
 * The default config ships `http://localhost:0/api` as a placeholder so the
 * user can see how to wire bento-ya. Port 0 is not a valid client port — if
 * we leave the worker enabled with that URL we spam errors every 30s. Detect
 * obvious placeholders (port 0, missing host) and skip polling instead.
 */
export function isUsableApiUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return false;
    if (parsed.port === "0") return false;
    return true;
  } catch {
    return false;
  }
}
