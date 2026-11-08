/**
 * Runs worker.ts as a child process over Bun IPC: spawn, tool calls, restarts,
 * crash backoff. Used by the supervisor (one Claude Code session, MCP over
 * stdio) and by the daemon hub (many Agent SDK sessions, MCP over loopback
 * HTTP), so both own Discord the same way.
 */

import { errorMessage } from "@choomfie/shared";
import type { IpcToolDef, SupervisorMessage, WorkerMessage } from "./ipc-types.ts";
import { waitForPendingToolCalls, type PendingToolCallMap } from "./supervisor-boundary.ts";

const WORKER_PATH = `${import.meta.dir}/../worker.ts`;
const WORKER_READY_TIMEOUT = 30_000;
const TOOL_CALL_TIMEOUT = 120_000;
/** Tools that wait on something slow by design: ask_brain covers a web brain's longest turn (45 min). */
const LONG_TOOL_TIMEOUTS: Record<string, number> = { ask_brain: 50 * 60_000 };
const RESTART_PENDING_DRAIN_TIMEOUT = 5_000;
const MAX_CRASHES = 5;
const CRASH_WINDOW_MS = 60_000;

/** Tool the host itself answers: restart the worker. */
export const RESTART_TOOL: IpcToolDef = {
  name: "restart",
  description:
    "Restart the Choomfie worker process. Reloads all code, config, plugins, and reconnects to Discord. MCP stays alive.",
  inputSchema: {
    type: "object" as const,
    properties: {
      reason: { type: "string", description: "Optional reason for restart (logged to stderr)" },
    },
  },
};

export interface WorkerHostOptions {
  /** Prefix for log lines ("Supervisor", "Hub"). */
  name: string;
  env?: Record<string, string | undefined>;
  /** Script to run instead of worker.ts (tests). */
  workerPath?: string;
  /** Worker sent tools + instructions (first boot and every restart). */
  onReady?: (tools: IpcToolDef[], instructions: string) => void;
  /** MCP notification from the worker (foreground: Discord messages, permission replies). */
  onNotification?: (method: string, params: unknown) => void;
  log?: (message: string) => void;
}

type Child = ReturnType<typeof Bun.spawn>;
type ToolResult = { content: unknown[]; isError?: boolean };

export class WorkerHost {
  tools: IpcToolDef[] = [];
  instructions = "";
  ready = false;
  private child: Child | null = null;
  private pending: PendingToolCallMap = new Map();
  private nextId = 0;
  private intentional = false;
  private crashes = 0;
  private lastCrash = 0;
  private stopped = false;
  private readonly log: (message: string) => void;

  constructor(private readonly opts: WorkerHostOptions) {
    this.log = opts.log ?? ((m) => console.error(`${opts.name}: ${m}`));
  }

  start(): void {
    this.stopped = false;
    this.child = this.spawn();
  }

  /** Resolves true once ready, false on timeout. */
  waitReady(timeoutMs = WORKER_READY_TIMEOUT): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.ready) return resolve(true);
      const deadline = Date.now() + timeoutMs;
      const poll = setInterval(() => {
        if (this.ready || Date.now() >= deadline) {
          clearInterval(poll);
          resolve(this.ready);
        }
      }, 100);
    });
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  private spawn(): Child {
    this.log("spawning worker");
    this.ready = false;
    const child = Bun.spawn(["bun", this.opts.workerPath ?? WORKER_PATH], {
      // Not stdin/stdout: in the supervisor those are the MCP stdio transport.
      stdio: ["ignore", "ignore", "inherit"],
      ipc: (msg: WorkerMessage) => this.onMessage(msg),
      env: { ...process.env, ...this.opts.env },
    });
    child.exited.then((code) => this.onExit(child, code));
    return child;
  }

  private onExit(child: Child, code: number | null) {
    this.log(`worker exited (code ${code})`);
    // A restart's old worker exiting must not touch the new one's state.
    if (this.child !== child) return;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Worker exited during tool call"));
      this.pending.delete(id);
    }
    this.ready = false;
    if (this.stopped || this.intentional || code === 0 || code === null) return;

    const now = Date.now();
    if (now - this.lastCrash > CRASH_WINDOW_MS) this.crashes = 0;
    this.lastCrash = now;
    this.crashes++;
    if (this.crashes >= MAX_CRASHES) {
      this.log(`worker crashed ${this.crashes} times in ${CRASH_WINDOW_MS / 1000}s, giving up`);
      return;
    }
    const delay = Math.min(1000 * 2 ** (this.crashes - 1), 15_000);
    this.log(`worker crashed (${this.crashes}/${MAX_CRASHES}), respawning in ${delay}ms...`);
    setTimeout(() => {
      if (!this.stopped) this.child = this.spawn();
    }, delay);
  }

  private onMessage(msg: WorkerMessage) {
    try {
      switch (msg.type) {
        case "ready":
          this.tools = msg.tools;
          this.instructions = msg.instructions;
          this.ready = true;
          this.log(`worker ready (${this.tools.length} tools)`);
          this.opts.onReady?.(this.tools, this.instructions);
          break;
        case "tool_result": {
          const p = this.pending.get(msg.id);
          if (p) {
            clearTimeout(p.timer);
            p.resolve(msg.result);
            this.pending.delete(msg.id);
          }
          break;
        }
        case "notification":
          this.opts.onNotification?.(msg.method, msg.params);
          break;
        case "request_restart":
          // Let the tool_result sent after requestRestart reach Claude first.
          setTimeout(() => void this.restartAndConfirm(msg.reason, msg.chat_id), 100);
          break;
        case "log":
          this.log(`worker: ${msg.message}`);
          break;
      }
    } catch (e) {
      this.log(`IPC message handler error: ${errorMessage(e)}`);
    }
  }

  private async restartAndConfirm(reason: string, chatId?: string) {
    try {
      const { timedOut } = await this.restart(reason);
      if (chatId && !timedOut) {
        // Give the new Discord client a moment to fill its cache.
        setTimeout(() => this.send({ type: "restart_confirmation", reason, chat_id: chatId }), 1000);
      }
    } catch (e) {
      this.log(`worker-requested restart failed: ${errorMessage(e)}`);
    }
  }

  send(msg: SupervisorMessage): boolean {
    if (!this.child) return false;
    try {
      this.child.send(msg);
      return true;
    } catch {
      return false;
    }
  }

  /** Run a worker tool. Rejects if the worker isn't ready or doesn't answer in time. */
  call(name: string, args: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ready || !this.child) return reject(new Error("Worker not ready"));
      const id = String(++this.nextId);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Tool call timed out: ${name}`));
      }, LONG_TOOL_TIMEOUTS[name] ?? TOOL_CALL_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.send({ type: "tool_call", id, name, args })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("Failed to send tool call to worker"));
      }
    });
  }

  /** A tool call as an MCP result: the restart tool, or the worker's tools with errors as text. */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (name === RESTART_TOOL.name) {
      const reason = (args.reason as string) || "manual restart";
      const { timedOut } = await this.restart(reason);
      return {
        content: [
          {
            type: "text",
            text: timedOut
              ? `Worker spawned but not ready yet (still starting). Reason: ${reason}`
              : `Restarted successfully. (${reason})`,
          },
        ],
      };
    }
    if (!this.ready) return { content: [{ type: "text", text: "Worker is starting up, please wait..." }], isError: true };
    try {
      return (await this.call(name, args)) as ToolResult;
    } catch (e) {
      return { content: [{ type: "text", text: `Tool error: ${errorMessage(e)}` }], isError: true };
    }
  }

  /** Every tool a session sees: restart plus the worker's. */
  listTools(): IpcToolDef[] {
    return [RESTART_TOOL, ...this.tools];
  }

  async restart(reason: string): Promise<{ timedOut: boolean }> {
    this.log(`restarting worker — ${reason}`);
    this.intentional = true;
    if ((await waitForPendingToolCalls(this.pending, RESTART_PENDING_DRAIN_TIMEOUT)) === "timed_out") {
      this.log(`restarting with ${this.pending.size} pending tool call(s) after drain timeout`);
    }
    await this.shutdownChild();
    this.intentional = false;
    this.crashes = 0;
    this.child = this.spawn();
    return { timedOut: !(await this.waitReady()) };
  }

  /** Ask the worker to exit, kill it after 5s. */
  private async shutdownChild() {
    const child = this.child;
    if (!child) return;
    this.send({ type: "shutdown" });
    await Promise.race([child.exited, new Promise((r) => setTimeout(r, 5000))]);
    try {
      child.kill();
    } catch {}
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.shutdownChild();
    this.child = null;
    this.ready = false;
  }
}
