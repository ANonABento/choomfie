/**
 * Tutor module registry — manages available teaching modules.
 *
 * To add a new module:
 *   1. Create modules/<name>/index.ts implementing TutorModule
 *   2. Register in the modules map below
 */

import type { TutorModule } from "../core/types.ts";
import { chineseModule } from "./chinese/index.ts";
import { frenchModule } from "./french/index.ts";
import { japaneseModule } from "./japanese/index.ts";
import { spanishModule } from "./spanish/index.ts";

const modules: Record<string, TutorModule> = {
  japanese: japaneseModule,
  chinese: chineseModule,
  french: frenchModule,
  spanish: spanishModule,
};

export function getModule(name: string): TutorModule {
  const mod = modules[name];
  if (!mod) {
    throw new Error(
      `Unknown module: "${name}". Available: ${Object.keys(modules).join(", ")}`
    );
  }
  return mod;
}

export function listModules(): TutorModule[] {
  return Object.values(modules);
}

export function getAllModuleTools() {
  return Object.values(modules).flatMap((m) => m.tools ?? []);
}
