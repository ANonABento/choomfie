/**
 * Orchestrator — local 24/7 runtime that powers Choomfie when running with
 * `--local`. No Anthropic, no Claude Code MCP — Ollama-only.
 */

export {
  OllamaProvider,
  type ChatProvider,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ModelInfo,
} from "./chat-provider.ts";
export {
  ModelRegistry,
  parseParamsB,
  estimateVramGB,
  classifySpeedTier,
  inferCapabilities,
  enrich,
  type ModelMetadata,
  type ModelSelection,
  type SpeedTier,
  type Capability,
} from "./model-registry.ts";
export {
  ModelRouter,
  type Route,
  type RouteDecision,
  type RoutingHints,
} from "./model-router.ts";
export { IdleMonitor, type IdleSnapshot, type IdleMonitorOptions } from "./idle-monitor.ts";
export {
  BackgroundWorker,
  type BackgroundWorkerOptions,
  type BentoyaTask,
} from "./background-worker.ts";
export {
  LocalRuntime,
  DEFAULT_LOCAL_CONFIG,
  type LocalRuntimeConfig,
  type LocalReplyOptions,
  type LocalReplyResult,
} from "./local-runtime.ts";
