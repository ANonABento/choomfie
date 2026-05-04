/**
 * LocalRuntime — orchestrates Choomfie when running fully local (Ollama only,
 * no Anthropic / no Claude Code MCP). Wires the chat provider, registry,
 * router, idle monitor, and background worker into one always-on loop.
 *
 * Initialization order:
 *   1. ping Ollama (fail fast if not running)
 *   2. discover models, prewarm chat + coding
 *   3. start background worker (polls bento-ya when idle)
 *   4. caller wires `replyToDiscord` into the Discord MessageCreate handler
 */

import { OllamaProvider, type ChatProvider } from "./chat-provider.ts";
import {
  ModelRegistry,
  type ModelMetadata,
  type ModelSelection,
} from "./model-registry.ts";
import { ModelRouter, type RouteDecision, type RoutingHints } from "./model-router.ts";
import { IdleMonitor } from "./idle-monitor.ts";
import { BackgroundWorker } from "./background-worker.ts";

export interface LocalRuntimeConfig {
  ollamaUrl: string;
  chatModel: string;
  codingModel: string;
  backgroundTasks: {
    enabled: boolean;
    idleThresholdMs: number;
    bentoyaApiUrl: string;
  };
  resourceManagement: {
    vramBudgetGB: number;
    pauseWhenGpuBusy: boolean;
  };
}

export const DEFAULT_LOCAL_CONFIG: LocalRuntimeConfig = {
  ollamaUrl: "http://localhost:11434",
  chatModel: "llama3.1:8b",
  codingModel: "qwen2.5-coder:32b",
  backgroundTasks: {
    enabled: true,
    idleThresholdMs: 5 * 60_000,
    bentoyaApiUrl: "http://localhost:0/api",
  },
  resourceManagement: {
    vramBudgetGB: 24,
    pauseWhenGpuBusy: true,
  },
};

export interface LocalReplyOptions {
  /** Persona description prepended as system prompt */
  personaPrompt?: string;
  /** Prior conversation messages (already trimmed) */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** Additional routing hints */
  hints?: RoutingHints;
  /** Streaming callback — called with each chunk as it arrives */
  onChunk?: (chunk: string) => void;
  /** Cancellation signal */
  signal?: AbortSignal;
}

export interface LocalReplyResult {
  text: string;
  decision: RouteDecision;
  tps: number | null;
  firstTokenMs: number | null;
  totalMs: number;
}

export class LocalRuntime {
  readonly provider: ChatProvider;
  readonly registry: ModelRegistry;
  readonly router: ModelRouter;
  readonly idle: IdleMonitor;
  readonly background: BackgroundWorker;

  private started = false;

  constructor(public readonly config: LocalRuntimeConfig) {
    this.provider = new OllamaProvider(config.ollamaUrl);
    this.registry = new ModelRegistry(this.provider, {
      chat: config.chatModel,
      coding: config.codingModel,
    });
    this.router = new ModelRouter(this.registry);
    this.idle = new IdleMonitor({
      idleThresholdMs: config.backgroundTasks.idleThresholdMs,
      pauseWhenGpuBusy: config.resourceManagement.pauseWhenGpuBusy,
    });
    this.background = new BackgroundWorker(this.provider, this.registry, this.idle, {
      enabled: config.backgroundTasks.enabled,
      apiUrl: config.backgroundTasks.bentoyaApiUrl,
    });
  }

  /** Verify Ollama, discover models, prewarm chat + coding, start background worker. */
  async start(): Promise<void> {
    if (this.started) return;
    if (!(await this.provider.ping())) {
      throw new Error(
        `Ollama unreachable at ${this.config.ollamaUrl}. ` +
          "Install + start it (https://ollama.com) before launching local mode.",
      );
    }

    const available = await this.registry.list(true);

    // Resource manager: if the configured pick exceeds the VRAM budget,
    // downgrade to the largest model that fits. This prevents OOM.
    await this.applyVramBudget(available);

    // Validate selection — fall back to a capability-matched model if pick
    // is missing locally. We prefer a model whose inferred capability matches
    // the role (chat-only for chat, coding for coding); otherwise any model.
    await this.applyMissingFallback(available, "chat");
    await this.applyMissingFallback(available, "coding");

    await this.registry.prewarm();
    this.background.start();
    this.started = true;
    const finalSel = this.registry.getSelection();
    console.error(
      `[local] runtime started — chat=${finalSel.chat} coding=${finalSel.coding} ` +
        `bg=${this.background.isRunning() ? "on" : "off"}`,
    );
  }

  async stop(): Promise<void> {
    this.background.stop();
    this.started = false;
  }

  /** Generate a Discord reply for an incoming user message. */
  async reply(userText: string, options: LocalReplyOptions = {}): Promise<LocalReplyResult> {
    this.idle.noteActivity();
    const decision = this.router.decide(userText, options.hints);

    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
    if (options.personaPrompt) {
      messages.push({ role: "system", content: options.personaPrompt });
    }
    if (options.history && options.history.length > 0) {
      messages.push(...options.history);
    }
    messages.push({ role: "user", content: userText });

    let text = "";
    const stream = this.provider.chatStream({
      model: decision.model,
      messages,
      signal: options.signal,
    });
    let result = await stream.next();
    while (!result.done) {
      const chunk = result.value as string;
      text += chunk;
      options.onChunk?.(chunk);
      result = await stream.next();
    }
    const final = result.value;

    return {
      text,
      decision,
      tps: final.tps,
      firstTokenMs: final.firstTokenMs,
      totalMs: final.totalMs,
    };
  }

  /** Quick benchmark — short prompt, returns TPS + latencies. */
  async benchmark(model: string, signal?: AbortSignal): Promise<LocalReplyResult> {
    const decision: RouteDecision = { route: "chat", model, reason: "benchmark" };
    const start = performance.now();
    const res = await this.provider.chat({
      model,
      messages: [{ role: "user", content: "Say 'ok' in one word." }],
      numPredict: 8,
      signal,
    });
    return {
      text: res.text,
      decision,
      tps: res.tps,
      firstTokenMs: res.firstTokenMs,
      totalMs: res.totalMs > 0 ? res.totalMs : performance.now() - start,
    };
  }

  getSelection(): ModelSelection {
    return this.registry.getSelection();
  }

  private async applyVramBudget(available: ModelMetadata[]): Promise<void> {
    const budget = this.config.resourceManagement.vramBudgetGB;
    if (!budget || budget <= 0) return;

    for (const role of ["chat", "coding"] as const) {
      const sel = this.registry.getSelection();
      const picked = available.find((m) => m.name === sel[role]);
      if (!picked || picked.vramGB === null) continue;
      if (picked.vramGB <= budget) continue;
      const fallback = this.registry.pickWithinBudget(role, budget);
      if (fallback && fallback !== sel[role]) {
        console.error(
          `[local] ${role} model '${sel[role]}' (~${picked.vramGB}GB) exceeds VRAM budget ${budget}GB — swapping to '${fallback}'`,
        );
        await this.registry.swap(role, fallback);
      }
    }
  }

  private async applyMissingFallback(
    available: ModelMetadata[],
    role: "chat" | "coding",
  ): Promise<void> {
    const sel = this.registry.getSelection();
    if (this.registry.has(sel[role])) return;
    if (available.length === 0) return;
    // Prefer a model whose capabilities match the role.
    const matched = available.find((m) => m.capabilities.includes(role));
    const fallback = matched ?? available[0];
    console.error(
      `[local] ${role} model '${sel[role]}' not pulled — falling back to '${fallback.name}'`,
    );
    await this.registry.swap(role, fallback.name);
  }
}
