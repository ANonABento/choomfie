/**
 * @choomfie/shared — shared types, utilities, and registries.
 *
 * Re-exports everything for convenient single-import usage:
 *   import { Plugin, ToolDef, text, err, nowUTC, VERSION } from "@choomfie/shared";
 */

// Types + helpers
export type { Plugin, ToolDef, ToolResult } from "./types.ts";
export { text, err } from "./types.ts";
export { errorMessage } from "./errors.ts";

// Plugin context
export type { PluginContext, PluginConfig, McpTransport, NotificationMessage, SocialsConfig, SocialsPlatformConfig, ChoomfieConfig } from "./plugin-context.ts";

// Time utilities
export {
  MS_PER_MIN,
  MS_PER_HOUR,
  MS_PER_DAY,
  toSQLiteDatetime,
  nowUTC,
  dateToSQLite,
  fromSQLiteDatetime,
  formatDuration,
  relativeTime,
  parseNaturalTime,
  isValidTimeZone,
  normalizeTimeZone,
  getZonedParts,
  zonedTimeToUtc,
  addZonedCalendarDays,
  addZonedCalendarMonths,
  isValidCron,
} from "./time.ts";

// Version
export { VERSION } from "./version.ts";

// Paths
export { findMonorepoRoot } from "./paths.ts";

// Interaction registries
export {
  registerButtonHandler,
  registerModalHandler,
  registerCommand,
  getCommandDefs,
  buttonHandlers,
  modalHandlers,
  commands,
} from "./interactions.ts";
export type {
  ButtonHandler,
  ModalHandler,
  CommandHandler,
  CommandDef,
} from "./interactions.ts";
