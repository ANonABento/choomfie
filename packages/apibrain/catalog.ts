/**
 * Which models a provider has right now, from its `/models`. Refreshed at
 * startup and daily, so a renamed or retired model is skipped without a code
 * change, and a provider whose configured models have all gone still answers
 * with whatever free models it lists today.
 */

import type { ApiProviderSpec, ModelInfo } from "./provider.ts";
import { modelIsFree } from "./provider.ts";

/** How many catalog models to fall back on when none of the configured ones exist any more. */
const FALLBACK_MODELS = 3;

export class Catalog {
  private models: Map<string, ModelInfo> | null = null;
  fetchedAt = 0;

  set(list: ModelInfo[], at = Date.now()): void {
    this.models = new Map(list.map((m) => [m.id, m]));
    this.fetchedAt = at;
  }

  /** True once a model list has been fetched. Before that, configured models are taken on trust. */
  get known(): boolean {
    return this.models !== null;
  }

  get size(): number {
    return this.models?.size ?? 0;
  }

  info(model: string): ModelInfo | undefined {
    return this.models?.get(model);
  }

  stale(maxAgeMs: number, now = Date.now()): boolean {
    return now - this.fetchedAt > maxAgeMs;
  }

  /**
   * The models to use, in order: the preferred ones that exist and are free;
   * if none do, the largest free models the provider lists.
   */
  pick(preferred: string[], spec: ApiProviderSpec): string[] {
    if (!this.models) return preferred.filter((m) => modelIsFree(spec, m));
    const present = preferred.filter((m) => this.models!.has(m) && modelIsFree(spec, m, this.models!.get(m)));
    if (present.length) return present;
    return [...this.models.values()]
      .filter((m) => modelIsFree(spec, m.id, m) && !/embed|whisper|tts|guard|safety|retriever|rerank|moderation|lyria|music|image-|audio/i.test(m.id))
      .sort((a, b) => (b.contextLength ?? 0) - (a.contextLength ?? 0))
      .slice(0, FALLBACK_MODELS)
      .map((m) => m.id);
  }
}
