/**
 * Which models a provider has right now, from its `/models`. Refreshed at
 * startup and every few hours, so a new model is picked up and a renamed or
 * retired one dropped without a code change (models.ts ranks them).
 */

import { isChatModel, modelTraits, newestOnly, type ModelTraits } from "./models.ts";
import type { ApiProviderSpec, ModelInfo } from "./provider.ts";
import { modelHasVision, modelIsFree } from "./provider.ts";

export class Catalog {
  private models: Map<string, ModelInfo> | null = null;
  fetchedAt = 0;

  set(list: ModelInfo[], at = Date.now()): void {
    this.models = new Map(list.map((m) => [m.id, m]));
    this.fetchedAt = at;
  }

  /** True once a model list has been fetched. */
  get known(): boolean {
    return this.models !== null;
  }

  get size(): number {
    return this.models?.size ?? 0;
  }

  ids(): string[] {
    return [...(this.models?.keys() ?? [])];
  }

  info(model: string): ModelInfo | undefined {
    return this.models?.get(model);
  }

  stale(maxAgeMs: number, now = Date.now()): boolean {
    return now - this.fetchedAt > maxAgeMs;
  }

  /**
   * The models this provider may use, with their traits, unordered:
   * - `pinned` (config) when given: those that are listed and free, in that order;
   * - otherwise every free chat model listed, newest of each family;
   * - with no list (not fetched yet, or a provider that can't list): the spec's fallback.
   */
  candidates(spec: ApiProviderSpec, pinned?: string[]): ModelTraits[] {
    const traits = (id: string) => modelTraits(id, this.info(id), modelHasVision(spec, id, this.info(id)));
    if (pinned?.length) {
      const usable = this.models ? pinned.filter((m) => this.models!.has(m)) : pinned;
      return usable.filter((m) => modelIsFree(spec, m, this.info(m))).map(traits);
    }
    if (!this.models) return (spec.fallbackModels ?? []).filter((m) => modelIsFree(spec, m)).map(traits);
    const chat = [...this.models.values()].filter((m) => modelIsFree(spec, m.id, m) && isChatModel(m.id, m));
    // Unlisted ones skip the newest-of-family cut: a listed newer sibling may be paid (Z.ai glm-5.3-flash vs glm-4.7-flash).
    const unlisted = (spec.unlistedModels ?? []).filter((m) => !this.models!.has(m) && modelIsFree(spec, m));
    return [...newestOnly(chat.map((m) => traits(m.id))), ...unlisted.map(traits)];
  }
}
