#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { VERSION } from "./lib/version.ts";
import { ConfigManager } from "./lib/config.ts";
import { OpenAIAPIKeyManager } from "./lib/openai/auth.ts";
import type { VerifiedOpenAIAPIKey } from "./lib/openai/auth.ts";
import { AppMemoryStore } from "./lib/openai/app-memory.ts";
import { ClaudeAgentSDKChatBackend } from "./lib/openai/agent-sdk-adapter.ts";
import {
  createChatCompletionResponse,
  createChatCompletionStreamResponse,
  normalizeChatRequest,
  type ChatBackend,
} from "./lib/openai/chat.ts";
import {
  getOpenAIEndpointDataDir,
  resolveOpenAIEndpointConfig,
  type OpenAIEndpointConfig,
} from "./lib/openai/config.ts";
import {
  createEmbeddingsResponse,
  EmbeddingsRequestSchema,
  normalizeEmbeddingInput,
  OllamaEmbeddingProvider,
  type EmbeddingProvider,
} from "./lib/openai/embeddings.ts";
import { OpenAIFileStore } from "./lib/openai/files.ts";
import {
  DefaultHermesAdapter,
  HermesCLIChatBackend,
  isStandardOpenAIPath,
  type HermesAdapter,
} from "./lib/openai/hermes-adapter.ts";
import {
  createResponseObject,
  responseInputToText,
  ResponseStore,
  ResponsesRequestSchema,
} from "./lib/openai/responses.ts";
import {
  SupervisorIpcNotifier,
  type OpenAINotifier,
} from "./lib/openai/notifier.ts";
import {
  SupervisorIpcSkillBridge,
  type OpenAISkillBridge,
} from "./lib/openai/skills.ts";
import {
  jsonResponse,
  openAIErrorResponse,
  type OpenAIModelList,
} from "./lib/openai/types.ts";

export interface OpenAIEndpointHandlerOptions {
  config: OpenAIEndpointConfig;
  dataDir: string;
  authManager?: OpenAIAPIKeyManager;
  appMemory?: AppMemoryStore;
  chatBackend?: ChatBackend;
  hermesAdapter?: HermesAdapter;
  embeddingProvider?: EmbeddingProvider;
  fileStore?: OpenAIFileStore;
  responseStore?: ResponseStore;
  notifier?: OpenAINotifier;
  skillBridge?: OpenAISkillBridge;
  version?: string;
}

function buildCorsHeaders(config: OpenAIEndpointConfig, origin: string | null): HeadersInit {
  if (!origin || !config.corsOrigins.some((allowed) => originMatches(allowed, origin))) {
    return {};
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Choomfie-Notify-Mode",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    Vary: "Origin",
  };
}

function originMatches(pattern: string, origin: string): boolean {
  if (pattern === origin) return true;
  if (pattern.endsWith(":*")) {
    const base = pattern.slice(0, -2);
    return origin.startsWith(`${base}:`);
  }
  return false;
}

function modelList(config: OpenAIEndpointConfig): OpenAIModelList {
  return {
    object: "list",
    data: Object.entries(config.models.aliases).map(([id, alias]) => ({
      id,
      object: "model",
      created: 0,
      owned_by: `choomfie:${alias.backend}`,
    })),
  };
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

function errorResponse(...args: Parameters<typeof openAIErrorResponse>): Response {
  return openAIErrorResponse(...args);
}

function timeoutSignal(req: Request, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  req.signal.addEventListener("abort", abort, { once: true });
  const cleanup = () => {
    clearTimeout(timer);
    req.signal.removeEventListener("abort", abort);
  };
  controller.signal.addEventListener("abort", cleanup, { once: true });
  return { signal: controller.signal, cleanup };
}

function notifyMode(req: Request): "auto" | "emit" | "off" | Response {
  const raw = req.headers.get("x-choomfie-notify-mode");
  if (!raw) return "auto";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "auto" || normalized === "emit" || normalized === "off") {
    return normalized;
  }
  return errorResponse(
    400,
    "X-Choomfie-Notify-Mode must be auto, emit, or off",
    "invalid_request_error",
    "X-Choomfie-Notify-Mode",
    "invalid_request",
  );
}

export function createOpenAIEndpointHandler(options: OpenAIEndpointHandlerOptions) {
  const authManager = options.authManager ?? new OpenAIAPIKeyManager(options.dataDir);
  const appMemory = options.appMemory ?? new AppMemoryStore(options.dataDir);
  const hermesAdapter = options.hermesAdapter ?? new DefaultHermesAdapter();
  const chatBackend = options.chatBackend ?? (
    options.config.routing.mode === "hermes"
      ? new HermesCLIChatBackend(hermesAdapter, options.config)
      : new ClaudeAgentSDKChatBackend()
  );
  const embeddingProvider = options.embeddingProvider ?? new OllamaEmbeddingProvider();
  const fileStore = options.fileStore ?? new OpenAIFileStore(options.dataDir);
  const responseStore = options.responseStore ?? new ResponseStore(options.dataDir);
  const notifier = options.notifier ?? new SupervisorIpcNotifier();
  const skillBridge = options.skillBridge ?? new SupervisorIpcSkillBridge();
  const version = options.version ?? VERSION;
  let activeRequests = 0;

  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const corsHeaders = buildCorsHeaders(options.config, req.headers.get("origin"));
    const withCors = (response: Response): Response => {
      for (const [key, value] of Object.entries(corsHeaders)) {
        response.headers.set(key, String(value));
      }
      return response;
    };
    const errorResponse = (...args: Parameters<typeof openAIErrorResponse>): Response => {
      return withCors(openAIErrorResponse(...args));
    };
    const unauthorized = (): Response => errorResponse(
      401,
      "Missing or invalid bearer token",
      "authentication_error",
      null,
      "invalid_api_key",
    );
    const requireAuth = (scopes: string[]): Response | null => {
      if (!options.config.requireAuth) return null;
      const verified = authManager.verifyAuthorizationHeader(req.headers.get("authorization"), scopes);
      return verified ? null : unauthorized();
    };
    const requireExtensionAuth = (scopes: string[]): VerifiedOpenAIAPIKey | Response => {
      const verified = authManager.verifyAuthorizationHeader(req.headers.get("authorization"), scopes);
      return verified ?? unauthorized();
    };
    const requireMemoryKey = (): string | Response => {
      const key = url.searchParams.get("key")?.trim();
      if (!key) {
        return errorResponse(400, "Missing memory key", "invalid_request_error", "key", "invalid_request");
      }
      return key;
    };
    const routeScopes = (): string[] => {
      if (req.method === "GET" && url.pathname === "/v1/models") return ["models", "chat"];
      if (url.pathname === "/v1/chat/completions") return ["chat"];
      if (url.pathname === "/v1/embeddings") return ["embeddings"];
      if (url.pathname === "/v1/files" || url.pathname.startsWith("/v1/files/")) return ["files"];
      if (url.pathname === "/v1/responses" || url.pathname.startsWith("/v1/responses/")) return ["responses"];
      return [];
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const contentLength = req.headers.get("content-length");
    if (contentLength && Number.parseInt(contentLength, 10) > options.config.maxRequestBytes) {
      return errorResponse(
        413,
        "Request body is too large",
        "invalid_request_error",
        null,
        "request_too_large",
      );
    }

    if (activeRequests >= options.config.maxConcurrent) {
      return errorResponse(
        429,
        "Too many concurrent requests",
        "rate_limit_error",
        null,
        "rate_limit_exceeded",
      );
    }

    const requestTimeout = timeoutSignal(req, options.config.requestTimeoutMs);
    const requestSignal = requestTimeout.signal;
    activeRequests++;
    let deferRequestCleanup = false;
    let requestCleanedUp = false;
    const cleanupRequest = () => {
      if (requestCleanedUp) return;
      requestCleanedUp = true;
      requestTimeout.cleanup();
      activeRequests--;
    };
    try {

    if (req.method === "GET" && url.pathname === "/health") {
      const hermesAvailable = options.config.routing.mode === "hermes"
        ? await hermesAdapter.isAvailable(options.config)
        : null;
      return jsonResponse({
        status: "ok",
        runtime: "choomfie",
        backend: hermesAvailable === false ? "hermes_cli_fallback" : options.config.routing.mode,
        version,
        auth: {
          required: options.config.requireAuth,
        },
        features: options.config.features,
        caveats: [
          "token_usage_may_be_approximate",
          "openai_tool_calls_rejected_when_tools_feature_is_disabled",
        ],
      }, 200, corsHeaders);
    }

    if (
      options.config.routing.mode === "hermes" &&
      isStandardOpenAIPath(url.pathname) &&
      await hermesAdapter.isAvailable(options.config)
    ) {
      const authError = requireAuth(routeScopes());
      if (authError) return authError;
      const response = await hermesAdapter.passThrough(req, options.config);
      for (const [key, value] of Object.entries(corsHeaders)) {
        response.headers.set(key, String(value));
      }
      return response;
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      const authError = requireAuth(["models", "chat"]);
      if (authError) return authError;
      return jsonResponse(modelList(options.config), 200, corsHeaders);
    }

    if (url.pathname === "/v1/choomfie/memory") {
      if (!options.config.features.memory) {
        return errorResponse(404, "App memory is not enabled", "invalid_request_error", null, "feature_disabled");
      }

      const verified = requireExtensionAuth(["memory"]);
      if (verified instanceof Response) return verified;

      if (req.method === "GET") {
        const key = requireMemoryKey();
        if (key instanceof Response) return key;
        const row = appMemory.get(verified.key.app, key);
        return jsonResponse({
          object: "choomfie.memory",
          key,
          value: row?.value ?? null,
          found: Boolean(row),
        }, 200, corsHeaders);
      }

      if (req.method === "POST") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return errorResponse(400, "Request body must be valid JSON", "invalid_request_error", null, "invalid_json");
        }

        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return errorResponse(400, "Request body must be an object", "invalid_request_error", null, "invalid_request");
        }
        const requestBody = body as Record<string, unknown>;
        if (typeof requestBody.key !== "string" || !requestBody.key.trim()) {
          return errorResponse(400, "Memory key is required", "invalid_request_error", "key", "invalid_request");
        }
        if (typeof requestBody.value !== "string") {
          return errorResponse(400, "Memory value must be a string", "invalid_request_error", "value", "invalid_request");
        }

        const row = appMemory.set(verified.key.app, requestBody.key.trim(), requestBody.value);
        return jsonResponse({
          object: "choomfie.memory",
          key: row.key,
          value: row.value,
          app: row.app,
          updated_at: row.updated_at,
        }, 200, corsHeaders);
      }

      if (req.method === "DELETE") {
        const key = requireMemoryKey();
        if (key instanceof Response) return key;
        const deleted = appMemory.delete(verified.key.app, key);
        return jsonResponse({
          object: "choomfie.memory.deleted",
          key,
          deleted,
        }, 200, corsHeaders);
      }
    }

    if (req.method === "POST" && url.pathname === "/v1/choomfie/notify") {
      if (!options.config.features.notify) {
        return errorResponse(404, "Notify is not enabled", "invalid_request_error", null, "feature_disabled");
      }

      const verified = requireExtensionAuth(["notify"]);
      if (verified instanceof Response) return verified;

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return errorResponse(400, "Request body must be valid JSON", "invalid_request_error", null, "invalid_json");
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return errorResponse(400, "Request body must be an object", "invalid_request_error", null, "invalid_request");
      }

      const requestBody = body as Record<string, unknown>;
      const content = typeof requestBody.message === "string"
        ? requestBody.message
        : typeof requestBody.content === "string"
          ? requestBody.content
          : "";
      if (!content.trim()) {
        return errorResponse(400, "Notification message is required", "invalid_request_error", "message", "invalid_request");
      }
      if (content.length > 1900) {
        return errorResponse(400, "Notification message is too long", "invalid_request_error", "message", "invalid_request");
      }

      try {
        const result = await notifier.notify({
          app: verified.key.app,
          content: content.trim(),
          channelId: typeof requestBody.channel_id === "string" ? requestBody.channel_id : undefined,
        });
        return jsonResponse({
          object: "choomfie.notify",
          delivered: result.delivered,
          mode: result.mode,
        }, 200, corsHeaders);
      } catch (error) {
        return errorResponse(
          502,
          error instanceof Error ? error.message : "Notification failed",
          "server_error",
          null,
          "notify_failed",
        );
      }
    }

    if (url.pathname === "/v1/choomfie/skills" || url.pathname === "/v1/choomfie/skills/invoke") {
      if (!options.config.features.skills) {
        return errorResponse(404, "Skills are not enabled", "invalid_request_error", null, "feature_disabled");
      }

      const verified = requireExtensionAuth(["skills"]);
      if (verified instanceof Response) return verified;

      if (req.method === "GET" && url.pathname === "/v1/choomfie/skills") {
        try {
          return jsonResponse({
            object: "list",
            data: await skillBridge.list(),
          }, 200, corsHeaders);
        } catch (error) {
          return errorResponse(
            502,
            error instanceof Error ? error.message : "Skill list failed",
            "server_error",
            null,
            "skill_bridge_error",
          );
        }
      }

      if (req.method === "POST" && url.pathname === "/v1/choomfie/skills/invoke") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return errorResponse(400, "Request body must be valid JSON", "invalid_request_error", null, "invalid_json");
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return errorResponse(400, "Request body must be an object", "invalid_request_error", null, "invalid_request");
        }
        const requestBody = body as Record<string, unknown>;
        if (typeof requestBody.name !== "string" || !requestBody.name.trim()) {
          return errorResponse(400, "Skill name is required", "invalid_request_error", "name", "invalid_request");
        }
        const skillName = requestBody.name.trim();
        const args = requestBody.args && typeof requestBody.args === "object" && !Array.isArray(requestBody.args)
          ? requestBody.args as Record<string, unknown>
          : {};

        try {
          const allowedSkills = await skillBridge.list();
          if (!allowedSkills.some((skill) => skill.name === skillName)) {
            return errorResponse(
              400,
              `Skill is not allowed: ${skillName}`,
              "invalid_request_error",
              "name",
              "not_allowed",
            );
          }
          return jsonResponse({
            object: "choomfie.skill_result",
            name: skillName,
            result: await skillBridge.invoke(skillName, args),
          }, 200, corsHeaders);
        } catch (error) {
          return errorResponse(
            502,
            error instanceof Error ? error.message : "Skill invocation failed",
            "server_error",
            null,
            "skill_bridge_error",
          );
        }
      }
    }

    if (req.method === "POST" && url.pathname === "/v1/embeddings") {
      if (!options.config.features.embeddings) {
        return errorResponse(404, "Embeddings are not enabled", "invalid_request_error", null, "feature_disabled");
      }

      const authError = requireAuth(["embeddings"]);
      if (authError) return authError;

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return errorResponse(400, "Request body must be valid JSON", "invalid_request_error", null, "invalid_json");
      }

      const parsed = EmbeddingsRequestSchema.safeParse(body);
      if (!parsed.success) {
        return errorResponse(400, "Invalid embeddings request", "invalid_request_error", "input", "invalid_request");
      }

      const input = normalizeEmbeddingInput(parsed.data);
      const model = parsed.data.model ?? process.env.OLLAMA_EMBEDDING_MODEL ?? "mxbai-embed-large";
      try {
        const embeddings = await embeddingProvider.embed(input, model);
        return jsonResponse(createEmbeddingsResponse(model, input, embeddings), 200, corsHeaders);
      } catch (error) {
        return errorResponse(
          502,
          error instanceof Error ? error.message : "Embeddings backend failed",
          "server_error",
          null,
          "backend_error",
        );
      }
    }

    if (url.pathname === "/v1/files" || url.pathname.startsWith("/v1/files/")) {
      if (!options.config.features.files) {
        return errorResponse(404, "Files are not enabled", "invalid_request_error", null, "feature_disabled");
      }

      const authError = requireAuth(["files"]);
      if (authError) return authError;

      if (req.method === "POST" && url.pathname === "/v1/files") {
        let form: FormData;
        try {
          form = await req.formData();
        } catch {
          return errorResponse(400, "Request body must be multipart form data", "invalid_request_error", null, "invalid_request");
        }

        const file = form.get("file");
        const purpose = form.get("purpose");
        if (!(file instanceof File)) {
          return errorResponse(400, "Multipart field 'file' is required", "invalid_request_error", "file", "invalid_request");
        }
        if (typeof purpose !== "string" || !purpose.trim()) {
          return errorResponse(400, "Multipart field 'purpose' is required", "invalid_request_error", "purpose", "invalid_request");
        }

        try {
          return jsonResponse(
            await fileStore.createFromFile(file, purpose.trim(), options.config.maxFileBytes),
            200,
            corsHeaders,
          );
        } catch (error) {
          return errorResponse(
            400,
            error instanceof Error ? error.message : "File upload failed",
            "invalid_request_error",
            "file",
            "invalid_request",
          );
        }
      }

      const contentMatch = url.pathname.match(/^\/v1\/files\/([^/]+)\/content$/);
      if (req.method === "GET" && contentMatch) {
        const content = fileStore.content(contentMatch[1]);
        if (!content) {
          return errorResponse(404, "File not found", "invalid_request_error", "id", "not_found");
        }
        const body = content.buffer.slice(
          content.byteOffset,
          content.byteOffset + content.byteLength,
        ) as ArrayBuffer;
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            ...corsHeaders,
          },
        });
      }

      const metadataMatch = url.pathname.match(/^\/v1\/files\/([^/]+)$/);
      if (metadataMatch) {
        if (req.method === "GET") {
          const file = fileStore.get(metadataMatch[1]);
          if (!file) {
            return errorResponse(404, "File not found", "invalid_request_error", "id", "not_found");
          }
          return jsonResponse(file, 200, corsHeaders);
        }

        if (req.method === "DELETE") {
          const deleted = fileStore.delete(metadataMatch[1]);
          return jsonResponse({
            id: metadataMatch[1],
            object: "file",
            deleted,
          }, 200, corsHeaders);
        }
      }
    }

    if (url.pathname === "/v1/responses" || url.pathname.startsWith("/v1/responses/")) {
      if (!options.config.features.responses) {
        return errorResponse(404, "Responses are not enabled", "invalid_request_error", null, "feature_disabled");
      }

      const authError = requireAuth(["responses"]);
      if (authError) return authError;

      if (req.method === "POST" && url.pathname === "/v1/responses") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return errorResponse(400, "Request body must be valid JSON", "invalid_request_error", null, "invalid_json");
        }

        const parsed = ResponsesRequestSchema.safeParse(body);
        if (!parsed.success) {
          return errorResponse(400, "Invalid Responses request", "invalid_request_error", "input", "invalid_request");
        }

        if (parsed.data.stream) {
          return errorResponse(
            400,
            "Responses streaming is not implemented",
            "invalid_request_error",
            "stream",
            "unsupported_feature",
          );
        }

        if (parsed.data.previous_response_id && !responseStore.get(parsed.data.previous_response_id)) {
          return errorResponse(404, "Previous response not found", "invalid_request_error", "previous_response_id", "not_found");
        }

        const model = parsed.data.model ?? options.config.models.default;
        const alias = options.config.models.aliases[model];
        if (!alias) {
          return errorResponse(400, `Unknown model: ${model}`, "invalid_request_error", "model", "model_not_found");
        }

        try {
          const backendOutput = await chatBackend.complete({
            model,
            backendModel: alias.model,
            messages: [
              ...(parsed.data.previous_response_id
                ? responseStore.contextMessages(parsed.data.previous_response_id)
                : []),
              { role: "user", content: responseInputToText(parsed.data.input) },
            ],
            signal: requestSignal,
          });
          const response = createResponseObject(model, backendOutput.content, backendOutput.usage);
          response.previous_response_id = parsed.data.previous_response_id ?? null;
          return jsonResponse(
            responseStore.save(
              response,
              parsed.data.input,
              {
                previousResponseId: parsed.data.previous_response_id ?? null,
                ttlDays: options.config.responseTtlDays,
              },
            ),
            200,
            corsHeaders,
          );
        } catch (error) {
          return errorResponse(
            502,
            error instanceof Error ? error.message : "Responses backend failed",
            "server_error",
            null,
            "backend_error",
          );
        }
      }

      const inputItemsMatch = url.pathname.match(/^\/v1\/responses\/([^/]+)\/input_items$/);
      if (req.method === "GET" && inputItemsMatch) {
        const inputItems = responseStore.inputItems(inputItemsMatch[1]);
        if (!inputItems) {
          return errorResponse(404, "Response not found", "invalid_request_error", "id", "not_found");
        }
        return jsonResponse(inputItems, 200, corsHeaders);
      }

      const responseMatch = url.pathname.match(/^\/v1\/responses\/([^/]+)$/);
      if (responseMatch) {
        if (req.method === "GET") {
          const response = responseStore.get(responseMatch[1]);
          if (!response) {
            return errorResponse(404, "Response not found", "invalid_request_error", "id", "not_found");
          }
          return jsonResponse(response, 200, corsHeaders);
        }

        if (req.method === "DELETE") {
          return jsonResponse({
            id: responseMatch[1],
            object: "response.deleted",
            deleted: responseStore.delete(responseMatch[1]),
          }, 200, corsHeaders);
        }
      }
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      if (!options.config.features.chat) {
        return errorResponse(404, "Chat completions are not enabled", "invalid_request_error", null, "feature_disabled");
      }

      const chatVerified = options.config.requireAuth
        ? authManager.verifyAuthorizationHeader(req.headers.get("authorization"), ["chat"])
        : null;
      if (options.config.requireAuth && !chatVerified) return unauthorized();

      const requestedNotifyMode = notifyMode(req);
      if (requestedNotifyMode instanceof Response) return withCors(requestedNotifyMode);

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return errorResponse(400, "Request body must be valid JSON", "invalid_request_error", null, "invalid_json");
      }

      const normalized = normalizeChatRequest(body, options.config);
      if (normalized.ok === false) return withCors(normalized.response);

      if (normalized.request.stream && !options.config.features.streaming) {
        return errorResponse(
          400,
          "Streaming chat completions are not enabled",
          "invalid_request_error",
          "stream",
          "feature_disabled",
        );
      }

      if (
        options.config.routing.mode === "hermes" &&
        normalized.request.stream &&
        !(await hermesAdapter.isAvailable(options.config))
      ) {
        return errorResponse(
          400,
          "Streaming chat completions require the Hermes OpenAI endpoint in Hermes mode",
          "invalid_request_error",
          "stream",
          "unsupported_feature",
        );
      }

      try {
        let response = normalized.request.stream
          ? createChatCompletionStreamResponse(normalized, chatBackend, requestSignal, cleanupRequest)
          : await createChatCompletionResponse(
              normalized,
              chatBackend,
              requestSignal,
              { notify: { mode: requestedNotifyMode, delivered: false } },
            );
        if (normalized.request.stream) {
          deferRequestCleanup = true;
        }
        if (!normalized.request.stream && requestedNotifyMode === "emit") {
          const body = await response.json() as Record<string, unknown>;
          const assistantText = Array.isArray(body.choices)
            ? ((body.choices[0] as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined)?.content
            : undefined;
          const notifyVerified = options.config.requireAuth
            ? authManager.verifyAuthorizationHeader(req.headers.get("authorization"), ["notify"])
            : chatVerified;
          let notifyMetadata: Record<string, unknown> = {
            mode: requestedNotifyMode,
            delivered: false,
          };

          if (!options.config.features.notify) {
            notifyMetadata = { ...notifyMetadata, reason: "feature_disabled" };
          } else if (!notifyVerified) {
            notifyMetadata = { ...notifyMetadata, reason: "missing_scope" };
          } else if (typeof assistantText === "string" && assistantText.trim()) {
            try {
              const result = await notifier.notify({
                app: notifyVerified.key.app,
                content: assistantText.trim(),
              });
              notifyMetadata = {
                mode: requestedNotifyMode,
                delivered: result.delivered,
                target: result.mode,
              };
            } catch (error) {
              notifyMetadata = {
                ...notifyMetadata,
                reason: error instanceof Error ? error.message : "notify_failed",
              };
            }
          }

          body.choomfie = {
            ...((body.choomfie && typeof body.choomfie === "object") ? body.choomfie as Record<string, unknown> : {}),
            notify: notifyMetadata,
          };
          response = jsonResponse(body, 200);
        }
        for (const [key, value] of Object.entries(corsHeaders)) {
          response.headers.set(key, String(value));
        }
        return response;
      } catch (error) {
        return errorResponse(
          502,
          error instanceof Error ? error.message : "Chat backend failed",
          "server_error",
          null,
          "backend_error",
        );
      }
    }

    return errorResponse(404, `Unknown endpoint: ${req.method} ${url.pathname}`, "invalid_request_error", null, "not_found");
    } finally {
      if (!deferRequestCleanup) {
        cleanupRequest();
      }
    }
  };
}

export function startOpenAIEndpointServer(options: OpenAIEndpointHandlerOptions): ReturnType<typeof Bun.serve> {
  if (!isLoopbackHost(options.config.host) && !options.config.allowPublicBind) {
    throw new Error("OpenAI endpoint public bind addresses are not allowed by default");
  }
  if (!isLoopbackHost(options.config.host) && !options.config.requireAuth) {
    throw new Error("OpenAI endpoint public bind addresses require auth");
  }

  return Bun.serve({
    hostname: options.config.host,
    port: options.config.port,
    fetch: createOpenAIEndpointHandler(options),
  });
}

if (import.meta.main) {
  const dataDir = getOpenAIEndpointDataDir();
  mkdirSync(dataDir, { recursive: true });
  const config = new ConfigManager(dataDir).getOpenAIEndpointConfig();
  const server = startOpenAIEndpointServer({
    config: resolveOpenAIEndpointConfig(config),
    dataDir,
  });

  console.error(`Choomfie OpenAI endpoint listening on http://${server.hostname}:${server.port}`);
}
