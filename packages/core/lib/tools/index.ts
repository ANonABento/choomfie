/**
 * Tool registry — aggregates core tools + plugin tools.
 */

import type { AppContext, ToolDef } from "../types.ts";
import { discordTools } from "./discord-tools.ts";
import { memoryTools } from "./memory-tools.ts";
import { personaTools } from "./persona-tools.ts";
import { reminderTools } from "./reminder-tools.ts";
import { birthdayTools } from "./birthday-tools.ts";
import { githubTools } from "./github-tools.ts";
import { statusTools } from "./status-tools.ts";
import { accessTools } from "./access-tools.ts";
import { systemTools } from "./system-tools.ts";
import { translationTools } from "./translation-tools.ts";

export function getAllTools(ctx: AppContext): ToolDef[] {
  return [
    ...discordTools,
    ...memoryTools,
    ...personaTools,
    ...reminderTools,
    ...birthdayTools,
    ...accessTools,
    ...githubTools,
    ...statusTools,
    ...translationTools,
    ...systemTools,
    ...(ctx.plugins.flatMap((p) => p.tools ?? []) as unknown as ToolDef[]),
  ];
}
