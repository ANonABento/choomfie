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
export {
  writeFileAtomic,
  writeFileAtomicSync,
  writeJsonAtomic,
  writeJsonAtomicSync,
  type AtomicWriteOptions,
} from "./atomic-file.ts";
export {
  CHOOMFIE_PROCESS_MARKERS,
  CHOOMFIE_DAEMON_MARKER,
  isChoomfieCommand,
  isChoomfieDaemonCommand,
  readLiveDaemonPid,
  readPidFile,
  processCommand,
  isChoomfieProcessAlive,
  readLiveChoomfiePid,
} from "./pid-utils.ts";
export {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  workerHealthPath,
  isHeartbeatStale,
  parseWorkerHeartbeat,
  type WorkerHeartbeat,
} from "./worker-health.ts";

// Paths
export {
  findMonorepoRoot,
  resolveDataDir,
  DEFAULT_DATA_DIR_SUFFIX,
} from "./paths.ts";

// Secret-file helpers
export {
  SECRET_FILE_MODE,
  writeSecretFile,
  writeSecretFileSync,
} from "./secret-file.ts";

// Interaction registries
export {
  registerButtonHandler,
  registerModalHandler,
  registerCommand,
  getCommandDefs,
  buttonHandlers,
  modalHandlers,
  commands,
  AUTOCOMPLETE_LIMIT,
} from "./interactions.ts";
export type {
  ButtonHandler,
  ModalHandler,
  CommandHandler,
  AutocompleteHandler,
  CommandDef,
} from "./interactions.ts";
