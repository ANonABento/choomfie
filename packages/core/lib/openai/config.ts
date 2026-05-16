export type OpenAIRoutingMode = "claude_code" | "hermes";

export interface OpenAIModelAliasConfig {
  backend: string;
  model: string;
}

export interface OpenAIEndpointConfig {
  enabled: boolean;
  host: string;
  port: number;
  allowPublicBind: boolean;
  requireAuth: boolean;
  corsOrigins: string[];
  maxConcurrent: number;
  requestTimeoutMs: number;
  maxRequestBytes: number;
  maxFileBytes: number;
  responseTtlDays: number;
  routing: {
    mode: OpenAIRoutingMode;
    hermesBaseUrl: string;
  };
  models: {
    default: string;
    aliases: Record<string, OpenAIModelAliasConfig>;
  };
  features: {
    chat: boolean;
    streaming: boolean;
    tools: boolean;
    responses: boolean;
    embeddings: boolean;
    files: boolean;
    memory: boolean;
    notify: boolean;
    skills: boolean;
  };
}

export const DEFAULT_OPENAI_ENDPOINT_CONFIG: OpenAIEndpointConfig = {
  enabled: false,
  host: "127.0.0.1",
  port: 4141,
  allowPublicBind: false,
  requireAuth: true,
  corsOrigins: ["http://localhost:*", "http://127.0.0.1:*"],
  maxConcurrent: 5,
  requestTimeoutMs: 120_000,
  maxRequestBytes: 10_485_760,
  maxFileBytes: 26_214_400,
  responseTtlDays: 30,
  routing: {
    mode: "claude_code",
    hermesBaseUrl: "http://127.0.0.1:8642/v1",
  },
  models: {
    default: "choomfie-claude-sonnet",
    aliases: {
      "choomfie-claude-sonnet": {
        backend: "claude_code",
        model: "claude-sonnet-4-6",
      },
      "choomfie-claude-code": {
        backend: "claude_code",
        model: "claude-opus-4-6",
      },
      "choomfie-local": {
        backend: "ollama",
        model: "llama3.1",
      },
    },
  },
  features: {
    chat: true,
    streaming: true,
    tools: false,
    responses: false,
    embeddings: false,
    files: false,
    memory: true,
    notify: true,
    skills: false,
  },
};

type Env = Record<string, string | undefined>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function readPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readRoutingMode(value: string | undefined): OpenAIRoutingMode | undefined {
  if (value === "claude_code" || value === "hermes") return value;
  return undefined;
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

export function mergeOpenAIEndpointConfig(saved: unknown): OpenAIEndpointConfig {
  if (!isRecord(saved)) {
    return structuredClone(DEFAULT_OPENAI_ENDPOINT_CONFIG);
  }

  const savedRouting = isRecord(saved.routing) ? saved.routing : {};
  const savedModels = isRecord(saved.models) ? saved.models : {};
  const savedAliases = isRecord(savedModels.aliases) ? savedModels.aliases : {};
  const savedFeatures = isRecord(saved.features) ? saved.features : {};

  return {
    ...DEFAULT_OPENAI_ENDPOINT_CONFIG,
    ...saved,
    corsOrigins: Array.isArray(saved.corsOrigins)
      ? saved.corsOrigins.filter((origin): origin is string => typeof origin === "string")
      : [...DEFAULT_OPENAI_ENDPOINT_CONFIG.corsOrigins],
    routing: {
      ...DEFAULT_OPENAI_ENDPOINT_CONFIG.routing,
      ...savedRouting,
    },
    models: {
      ...DEFAULT_OPENAI_ENDPOINT_CONFIG.models,
      ...savedModels,
      aliases: {
        ...DEFAULT_OPENAI_ENDPOINT_CONFIG.models.aliases,
        ...savedAliases,
      } as Record<string, OpenAIModelAliasConfig>,
    },
    features: {
      ...DEFAULT_OPENAI_ENDPOINT_CONFIG.features,
      ...savedFeatures,
    },
  } as OpenAIEndpointConfig;
}

export function resolveOpenAIEndpointConfig(
  saved: unknown = undefined,
  env: Env = process.env,
): OpenAIEndpointConfig {
  const config = mergeOpenAIEndpointConfig(saved);
  const savedRecord = isRecord(saved) ? saved : {};

  const enabled = readBoolean(env.CHOOMFIE_OPENAI_ENABLED);
  if (enabled !== undefined) config.enabled = enabled;

  if (env.CHOOMFIE_OPENAI_HOST) config.host = env.CHOOMFIE_OPENAI_HOST;

  const port = readPositiveInteger(env.CHOOMFIE_OPENAI_PORT);
  if (port !== undefined) config.port = port;

  const allowPublicBind = readBoolean(env.CHOOMFIE_OPENAI_ALLOW_PUBLIC_BIND);
  if (allowPublicBind !== undefined) config.allowPublicBind = allowPublicBind;

  const requireAuth = readBoolean(env.CHOOMFIE_OPENAI_REQUIRE_AUTH);
  if (requireAuth !== undefined) config.requireAuth = requireAuth;

  const routingMode = readRoutingMode(env.CHOOMFIE_OPENAI_ROUTING_MODE);
  if (routingMode !== undefined) config.routing.mode = routingMode;

  if (env.CHOOMFIE_OPENAI_HERMES_BASE_URL) {
    config.routing.hermesBaseUrl = env.CHOOMFIE_OPENAI_HERMES_BASE_URL;
  }

  if (env.CHOOMFIE_OPENAI_DEFAULT_MODEL) {
    config.models.default = env.CHOOMFIE_OPENAI_DEFAULT_MODEL;
  }

  const maxConcurrent = readPositiveInteger(env.CHOOMFIE_OPENAI_MAX_CONCURRENT);
  if (maxConcurrent !== undefined) config.maxConcurrent = maxConcurrent;

  const requestTimeoutMs = readPositiveInteger(env.CHOOMFIE_OPENAI_REQUEST_TIMEOUT_MS);
  if (requestTimeoutMs !== undefined) config.requestTimeoutMs = requestTimeoutMs;

  const maxFileBytes = readPositiveInteger(env.CHOOMFIE_OPENAI_MAX_FILE_BYTES);
  if (maxFileBytes !== undefined) config.maxFileBytes = maxFileBytes;

  if (!isLoopbackHost(config.host) && !Array.isArray(savedRecord.corsOrigins)) {
    config.corsOrigins = [];
  }

  return config;
}

export function getOpenAIEndpointDataDir(env: Env = process.env): string {
  return (
    env.CHOOMFIE_DATA_DIR ||
    env.CLAUDE_PLUGIN_DATA ||
    `${env.HOME ?? "."}/.claude/plugins/data/choomfie-inline`
  );
}
