import { describe, expect, test } from "bun:test";
import {
  classifySpeedTier,
  enrich,
  estimateVramGB,
  inferCapabilities,
  parseParamsB,
} from "../lib/orchestrator/model-registry.ts";
import { ModelRegistry } from "../lib/orchestrator/model-registry.ts";
import { ModelRouter } from "../lib/orchestrator/model-router.ts";
import { IdleMonitor } from "../lib/orchestrator/idle-monitor.ts";
import { isUsableApiUrl } from "../lib/orchestrator/background-worker.ts";
import { LocalRuntime } from "../lib/orchestrator/local-runtime.ts";
import type { ChatProvider, ModelInfo } from "../lib/orchestrator/chat-provider.ts";

describe("model-registry helpers", () => {
  test("parseParamsB handles B and M suffixes and decimals", () => {
    expect(parseParamsB("7B")).toBe(7);
    expect(parseParamsB("32B")).toBe(32);
    expect(parseParamsB("1.5B")).toBe(1.5);
    expect(parseParamsB("500M")).toBe(0.5);
    expect(parseParamsB(undefined)).toBeNull();
    expect(parseParamsB("garbage")).toBeNull();
  });

  test("classifySpeedTier groups by parameter count", () => {
    expect(classifySpeedTier(7)).toBe("fast");
    expect(classifySpeedTier(13)).toBe("balanced");
    expect(classifySpeedTier(70)).toBe("slow");
    expect(classifySpeedTier(null)).toBe("balanced");
  });

  test("estimateVramGB scales with quantization", () => {
    const q4 = estimateVramGB(7, "Q4_0");
    const q8 = estimateVramGB(7, "Q8_0");
    const fp16 = estimateVramGB(7, "F16");
    expect(q4).toBeGreaterThan(0);
    expect(q8).toBeGreaterThan(q4!);
    expect(fp16).toBeGreaterThan(q8!);
    expect(estimateVramGB(null, "Q4_0")).toBeNull();
  });

  test("inferCapabilities flags coding and embedding models", () => {
    expect(inferCapabilities("qwen2.5-coder:32b")).toContain("coding");
    expect(inferCapabilities("nomic-embed-text")).toContain("embedding");
    expect(inferCapabilities("llama3.1:8b")).toContain("chat");
    expect(inferCapabilities("llama3.1:8b")).not.toContain("coding");
  });

  test("enrich pulls everything together", () => {
    const meta = enrich({
      name: "qwen2.5-coder:32b",
      size: 1234,
      digest: "abc",
      paramSize: "32B",
      quant: "Q4_0",
    });
    expect(meta.paramsB).toBe(32);
    expect(meta.speedTier).toBe("slow");
    expect(meta.capabilities).toContain("coding");
    expect(meta.vramGB).toBeGreaterThan(0);
  });
});

class StubProvider implements ChatProvider {
  readonly kind = "stub" as const;
  constructor(private models: ModelInfo[]) {}
  listModels() { return Promise.resolve(this.models); }
  chat(): never { throw new Error("not used"); }
  async *chatStream(): AsyncGenerator<string, any> {
    yield "" as string;
    return { text: "", tps: null, firstTokenMs: null, totalMs: 0, model: "" };
  }
  prewarm() { return Promise.resolve(); }
  ping() { return Promise.resolve(true); }
}

describe("ModelRouter", () => {
  test("routes coding signals to the coding model", async () => {
    const provider = new StubProvider([
      { name: "llama3.1:8b", size: 1, digest: "1", paramSize: "8B", quant: "Q4_0" },
      { name: "qwen2.5-coder:32b", size: 1, digest: "2", paramSize: "32B", quant: "Q4_0" },
    ]);
    const registry = new ModelRegistry(provider, {
      chat: "llama3.1:8b",
      coding: "qwen2.5-coder:32b",
    });
    await registry.refresh();
    const router = new ModelRouter(registry);

    expect(router.decide("hi how's it going").route).toBe("chat");
    expect(router.decide("```\nconst x = 1\n```").route).toBe("coding");
    expect(
      router.decide("can you help me debug this traceback in foo/bar.ts?").route,
    ).toBe("coding");
    expect(router.decide("anything", { background: true }).route).toBe("coding");
    expect(router.decide("anything", { forceRoute: "chat" }).route).toBe("chat");
  });

  test("pickWithinBudget downgrades to a smaller coding model", async () => {
    const provider = new StubProvider([
      { name: "qwen2.5-coder:7b", size: 1, digest: "1", paramSize: "7B", quant: "Q4_0" },
      { name: "qwen2.5-coder:32b", size: 1, digest: "2", paramSize: "32B", quant: "Q4_0" },
    ]);
    const registry = new ModelRegistry(provider, {
      chat: "qwen2.5-coder:7b",
      coding: "qwen2.5-coder:32b",
    });
    await registry.refresh();
    const fallback = registry.pickWithinBudget("coding", 10);
    expect(fallback).toBe("qwen2.5-coder:7b");
  });
});

describe("IdleMonitor", () => {
  test("noteActivity resets idle timer", async () => {
    const monitor = new IdleMonitor({ idleThresholdMs: 60_000 });
    monitor.noteActivity(Date.now() - 90_000);
    const stale = await monitor.snapshot();
    expect(stale.isIdle).toBe(true);
    monitor.noteActivity();
    const fresh = await monitor.snapshot();
    expect(fresh.isIdle).toBe(false);
  });
});

describe("isUsableApiUrl", () => {
  test("rejects placeholder and malformed URLs", () => {
    expect(isUsableApiUrl(undefined)).toBe(false);
    expect(isUsableApiUrl("")).toBe(false);
    expect(isUsableApiUrl("not a url")).toBe(false);
    expect(isUsableApiUrl("http://localhost:0/api")).toBe(false);
  });
  test("accepts realistic endpoints", () => {
    expect(isUsableApiUrl("http://localhost:3000/api")).toBe(true);
    expect(isUsableApiUrl("https://bentoya.example.com/api")).toBe(true);
  });
});

describe("LocalRuntime.start()", () => {
  test("downgrades when configured pick exceeds VRAM budget", async () => {
    const provider = new StubProvider([
      { name: "qwen2.5-coder:7b", size: 1, digest: "1", paramSize: "7B", quant: "Q4_0" },
      { name: "qwen2.5-coder:32b", size: 1, digest: "2", paramSize: "32B", quant: "Q4_0" },
    ]);
    const runtime = new LocalRuntime({
      ollamaUrl: "http://stub",
      chatModel: "qwen2.5-coder:7b",
      codingModel: "qwen2.5-coder:32b",
      backgroundTasks: {
        enabled: false,
        idleThresholdMs: 60_000,
        bentoyaApiUrl: "http://localhost:0/api",
      },
      resourceManagement: { vramBudgetGB: 10, pauseWhenGpuBusy: false },
    });
    // Swap in our stub provider + registry pointing at it.
    (runtime as unknown as { provider: ChatProvider }).provider = provider;
    (runtime as unknown as { registry: ModelRegistry }).registry = new ModelRegistry(
      provider,
      { chat: "qwen2.5-coder:7b", coding: "qwen2.5-coder:32b" },
    );
    await runtime.start();
    const sel = runtime.getSelection();
    // 32b would not fit a 10GB budget; 7b should.
    expect(sel.coding).toBe("qwen2.5-coder:7b");
  });

  test("falls back to a capability-matched model when configured pick is missing", async () => {
    const provider = new StubProvider([
      // chat-only and coding-only — both pulled, but neither is the configured pick.
      { name: "llama3.1:8b", size: 1, digest: "1", paramSize: "8B", quant: "Q4_0" },
      { name: "qwen2.5-coder:7b", size: 1, digest: "2", paramSize: "7B", quant: "Q4_0" },
    ]);
    const runtime = new LocalRuntime({
      ollamaUrl: "http://stub",
      chatModel: "mistral:7b",
      codingModel: "deepseek-coder:33b",
      backgroundTasks: {
        enabled: false,
        idleThresholdMs: 60_000,
        bentoyaApiUrl: "http://localhost:0/api",
      },
      resourceManagement: { vramBudgetGB: 0, pauseWhenGpuBusy: false },
    });
    (runtime as unknown as { provider: ChatProvider }).provider = provider;
    (runtime as unknown as { registry: ModelRegistry }).registry = new ModelRegistry(
      provider,
      { chat: "mistral:7b", coding: "deepseek-coder:33b" },
    );
    await runtime.start();
    const sel = runtime.getSelection();
    expect(sel.coding).toBe("qwen2.5-coder:7b"); // capability-matched
    // chat slot prefers chat-capable; both qualify but llama3.1 has no "coding" tag.
    expect(["llama3.1:8b", "qwen2.5-coder:7b"]).toContain(sel.chat);
  });
});
