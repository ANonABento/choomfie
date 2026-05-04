/**
 * ModelRegistry — discovers locally-available Ollama models, classifies them
 * by speed-tier, and tracks the active chat/coding selections.
 */

import type { ChatProvider, ModelInfo } from "./chat-provider.ts";

export type SpeedTier = "fast" | "balanced" | "slow";
export type Capability = "chat" | "coding" | "embedding";

export interface ModelMetadata extends ModelInfo {
  /** Approximate parameter count in billions (parsed from paramSize when possible) */
  paramsB: number | null;
  /** Heuristic speed-tier based on params and quantization */
  speedTier: SpeedTier;
  /** Inferred capabilities from name/family */
  capabilities: Capability[];
  /** Approximate VRAM cost in GB if loaded */
  vramGB: number | null;
}

const CODING_NAME_HINTS = [
  "coder",
  "code",
  "codestral",
  "deepseek",
  "starcoder",
  "wizardcoder",
  "magicoder",
];

const EMBEDDING_NAME_HINTS = ["embed", "embedding", "bge-", "nomic-embed"];

/** Parse an Ollama parameter size string ("7B", "32B", "1.5B") into billions. */
export function parseParamsB(size: string | undefined): number | null {
  if (!size) return null;
  const match = size.trim().match(/^(\d+(?:\.\d+)?)\s*([BM])$/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  return unit === "B" ? value : value / 1000;
}

/** Rough VRAM estimate (GB) from params + quant. Conservative — pads 20%. */
export function estimateVramGB(paramsB: number | null, quant?: string): number | null {
  if (!paramsB) return null;
  // Bytes per parameter by quantization label.
  const bpp =
    !quant ? 2.0
    : /Q2/i.test(quant) ? 0.5
    : /Q3/i.test(quant) ? 0.5
    : /Q4/i.test(quant) ? 0.6
    : /Q5/i.test(quant) ? 0.75
    : /Q6/i.test(quant) ? 0.875
    : /Q8/i.test(quant) ? 1.1
    : /F16|FP16/i.test(quant) ? 2.0
    : /F32|FP32/i.test(quant) ? 4.0
    : 1.0;
  return Math.round(paramsB * bpp * 1.2 * 10) / 10;
}

export function classifySpeedTier(paramsB: number | null): SpeedTier {
  if (paramsB === null) return "balanced";
  if (paramsB <= 9) return "fast";
  if (paramsB <= 20) return "balanced";
  return "slow";
}

export function inferCapabilities(name: string, family?: string): Capability[] {
  const lower = name.toLowerCase();
  const fam = (family ?? "").toLowerCase();
  const caps: Capability[] = [];
  if (EMBEDDING_NAME_HINTS.some((h) => lower.includes(h))) caps.push("embedding");
  if (CODING_NAME_HINTS.some((h) => lower.includes(h) || fam.includes(h))) caps.push("coding");
  if (caps.length === 0 || caps.includes("coding")) caps.push("chat");
  return caps;
}

export function enrich(info: ModelInfo): ModelMetadata {
  const paramsB = parseParamsB(info.paramSize);
  return {
    ...info,
    paramsB,
    speedTier: classifySpeedTier(paramsB),
    capabilities: inferCapabilities(info.name, info.family),
    vramGB: estimateVramGB(paramsB, info.quant),
  };
}

export interface ModelSelection {
  chat: string;
  coding: string;
}

export class ModelRegistry {
  private models = new Map<string, ModelMetadata>();
  private lastDiscovery = 0;
  private discoveryTtlMs = 30_000;
  private selection: ModelSelection;

  constructor(
    private provider: ChatProvider,
    initial: ModelSelection,
  ) {
    this.selection = { ...initial };
  }

  /** Force-refresh the model list. */
  async refresh(): Promise<ModelMetadata[]> {
    const list = await this.provider.listModels();
    this.models.clear();
    for (const info of list) this.models.set(info.name, enrich(info));
    this.lastDiscovery = Date.now();
    return [...this.models.values()];
  }

  /** Cached refresh — only hits Ollama if cache is stale. */
  async list(force = false): Promise<ModelMetadata[]> {
    if (force || Date.now() - this.lastDiscovery > this.discoveryTtlMs) {
      await this.refresh();
    }
    return [...this.models.values()];
  }

  has(name: string): boolean {
    return this.models.has(name);
  }

  get(name: string): ModelMetadata | undefined {
    return this.models.get(name);
  }

  getSelection(): ModelSelection {
    return { ...this.selection };
  }

  /**
   * Swap the chat or coding model. Returns true if the model is locally
   * available; false if not pulled (caller should reject).
   */
  async swap(role: "chat" | "coding", model: string): Promise<boolean> {
    await this.list();
    if (!this.has(model)) return false;
    this.selection = { ...this.selection, [role]: model };
    return true;
  }

  /** Pre-warm the active chat and coding models in parallel. */
  async prewarm(): Promise<void> {
    const targets = new Set([this.selection.chat, this.selection.coding]);
    await Promise.allSettled(
      [...targets].map((m) => this.provider.prewarm(m).catch(() => {})),
    );
  }

  /** Pick a smaller fallback model when VRAM budget can't fit the current pick. */
  pickWithinBudget(role: "chat" | "coding", budgetGB: number): string | null {
    const wanted = role === "coding" ? "coding" : "chat";
    const candidates = [...this.models.values()]
      .filter((m) => m.capabilities.includes(wanted))
      .filter((m) => m.vramGB === null || m.vramGB <= budgetGB)
      .sort((a, b) => (b.paramsB ?? 0) - (a.paramsB ?? 0));
    return candidates[0]?.name ?? null;
  }
}
