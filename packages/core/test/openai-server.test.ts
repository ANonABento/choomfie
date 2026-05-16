import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import OpenAI from "openai";
import { OpenAIAPIKeyManager } from "../lib/openai/auth.ts";
import { AppMemoryStore } from "../lib/openai/app-memory.ts";
import { resolveOpenAIEndpointConfig } from "../lib/openai/config.ts";
import {
  createOpenAIEndpointHandler,
  startOpenAIEndpointServer,
} from "../openai-server.ts";
import type { ChatBackend } from "../lib/openai/chat.ts";
import type { OpenAINotifier } from "../lib/openai/notifier.ts";
import {
  OllamaEmbeddingProvider,
  type EmbeddingProvider,
} from "../lib/openai/embeddings.ts";
import type { OpenAISkillBridge } from "../lib/openai/skills.ts";
import {
  DefaultHermesAdapter,
  type HermesAdapter,
} from "../lib/openai/hermes-adapter.ts";

const tempDirs: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "choomfie-openai-server-"));
  tempDirs.push(dir);
  return dir;
}

test("health is unauthenticated and reports Phase 0 runtime status", async () => {
  const dir = makeTempDir();
  const handler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig(undefined, {}),
    dataDir: dir,
    version: "test",
  });

  const response = await handler(new Request("http://127.0.0.1:4141/health"));
  const body = await response.json() as {
    status: string;
    runtime: string;
    backend: string;
    version: string;
    auth: { required: boolean };
    features: { chat: boolean; streaming: boolean; memory: boolean; notify: boolean };
    caveats: string[];
  };

  expect(response.status).toBe(200);
  expect(body.status).toBe("ok");
  expect(body.runtime).toBe("choomfie");
  expect(body.backend).toBe("claude_code");
  expect(body.version).toBe("test");
  expect(body.auth.required).toBe(true);
  expect(body.features.chat).toBe(true);
  expect(body.features.streaming).toBe(true);
  expect(body.features.memory).toBe(true);
  expect(body.features.notify).toBe(true);
  expect(body.caveats).toContain("token_usage_may_be_approximate");
});

test("models endpoint requires a bearer token with models or chat scope", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const issued = authManager.issue("exampleapp", ["chat"]);
  const modelsOnly = authManager.issue("catalog", ["models"]);
  const wrongScope = authManager.issue("notes", ["memory"]);
  const handler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig(undefined, {}),
    dataDir: dir,
    authManager,
    version: "test",
  });

  const rejected = await handler(new Request("http://127.0.0.1:4141/v1/models"));
  expect(rejected.status).toBe(401);
  expect(await rejected.json()).toEqual({
    error: {
      message: "Missing or invalid bearer token",
      type: "authentication_error",
      param: null,
      code: "invalid_api_key",
    },
  });

  const rejectedWrongScope = await handler(new Request("http://127.0.0.1:4141/v1/models", {
    headers: {
      Authorization: `Bearer ${wrongScope.token}`,
    },
  }));
  expect(rejectedWrongScope.status).toBe(401);

  const acceptedModelsScope = await handler(new Request("http://127.0.0.1:4141/v1/models", {
    headers: {
      Authorization: `Bearer ${modelsOnly.token}`,
    },
  }));
  expect(acceptedModelsScope.status).toBe(200);

  const accepted = await handler(new Request("http://127.0.0.1:4141/v1/models", {
    headers: {
      Authorization: `Bearer ${issued.token}`,
    },
  }));
  const body = await accepted.json() as {
    object: string;
    data: Array<{ id: string; object: string; created: number; owned_by: string }>;
  };

  expect(accepted.status).toBe(200);
  expect(body.object).toBe("list");
  expect(body.data).toContainEqual({
    id: "choomfie-claude-sonnet",
    object: "model",
    created: 0,
    owned_by: "choomfie:claude_code",
  });
});

test("OpenAI error responses include CORS headers for allowed browser origins", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const issued = authManager.issue("exampleapp", ["chat"]);
  const handler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig(undefined, {}),
    dataDir: dir,
    authManager,
    chatBackend: {
      async complete() {
        throw new Error("backend should not be called");
      },
    },
    version: "test",
  });

  const authError = await handler(new Request("http://127.0.0.1:4141/v1/models", {
    headers: {
      Origin: "http://localhost:5173",
      Authorization: "Bearer sk-choomfie-invalid",
    },
  }));
  expect(authError.status).toBe(401);
  expect(authError.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
  expect(authError.headers.get("Vary")).toBe("Origin");

  const validationError = await handler(new Request("http://127.0.0.1:4141/v1/chat/completions", {
    method: "POST",
    headers: {
      Origin: "http://127.0.0.1:3000",
      Authorization: `Bearer ${issued.token}`,
    },
    body: JSON.stringify({
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://example.test/image.png" } }],
        },
      ],
    }),
  }));
  expect(validationError.status).toBe(400);
  expect(validationError.headers.get("Access-Control-Allow-Origin")).toBe("http://127.0.0.1:3000");

  const preflight = await handler(new Request("http://127.0.0.1:4141/v1/chat/completions", {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:5173",
      "Access-Control-Request-Headers": "authorization, content-type, x-choomfie-notify-mode",
    },
  }));
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("X-Choomfie-Notify-Mode");
});

test("chat completions return an OpenAI-shaped non-streaming response through an injected backend", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const issued = authManager.issue("exampleapp", ["chat"]);
  const calls: unknown[] = [];
  const chatBackend: ChatBackend = {
    async complete(input) {
      calls.push(input);
      return {
        content: "hello from choomfie",
        usage: {
          prompt_tokens: 2,
          completion_tokens: 3,
          total_tokens: 5,
        },
      };
    },
  };
  const handler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig(undefined, {}),
    dataDir: dir,
    authManager,
    chatBackend,
    version: "test",
  });

  const response = await handler(new Request("http://127.0.0.1:4141/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${issued.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "choomfie-claude-sonnet",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: "previous answer" },
      ],
    }),
  }));
  const body = await response.json() as {
    object: string;
    model: string;
    choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    choomfie?: unknown;
  };

  expect(response.status).toBe(200);
  expect(body.object).toBe("chat.completion");
  expect(body.model).toBe("choomfie-claude-sonnet");
  expect(body.choices[0].message).toEqual({ role: "assistant", content: "hello from choomfie" });
  expect(body.choices[0].finish_reason).toBe("stop");
  expect(body.usage).toEqual({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 });
  expect(body.choomfie).toEqual({
    notify: { mode: "auto", delivered: false },
  });
  expect(calls).toEqual([
    {
      model: "choomfie-claude-sonnet",
      backendModel: "claude-sonnet-4-6",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "previous answer" },
      ],
      signal: expect.any(AbortSignal),
    },
  ]);
});

test("chat completions expose notify metadata and scoped emit delivery", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const chatOnly = authManager.issue("exampleapp", ["chat"]);
  const chatAndNotify = authManager.issue("exampleapp", ["chat", "notify"]);
  const notifyCalls: Array<{ app: string; content: string }> = [];
  const chatBackend: ChatBackend = {
    async complete() {
      return { content: "notify me" };
    },
  };
  const notifier: OpenAINotifier = {
    async notify(input) {
      notifyCalls.push({ app: input.app, content: input.content });
      return { delivered: true, mode: "owner_dm" };
    },
  };
  const handler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig(undefined, {}),
    dataDir: dir,
    authManager,
    chatBackend,
    notifier,
    version: "test",
  });

  const missingScope = await handler(new Request("http://127.0.0.1:4141/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${chatOnly.token}`,
      "X-Choomfie-Notify-Mode": "emit",
    },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  }));
  const missingScopeBody = await missingScope.json() as { choomfie?: unknown };
  expect(missingScope.status).toBe(200);
  expect(missingScopeBody.choomfie).toEqual({
    notify: { mode: "emit", delivered: false, reason: "missing_scope" },
  });

  const delivered = await handler(new Request("http://127.0.0.1:4141/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${chatAndNotify.token}`,
      "X-Choomfie-Notify-Mode": "emit",
    },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  }));
  const deliveredBody = await delivered.json() as { choomfie?: unknown };
  expect(delivered.status).toBe(200);
  expect(deliveredBody.choomfie).toEqual({
    notify: { mode: "emit", delivered: true, target: "owner_dm" },
  });
  expect(notifyCalls).toEqual([{ app: "exampleapp", content: "notify me" }]);

  const invalid = await handler(new Request("http://127.0.0.1:4141/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${chatOnly.token}`,
      "X-Choomfie-Notify-Mode": "loud",
    },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  }));
  expect(invalid.status).toBe(400);
});

test("chat completions reject unsupported tool and multi-choice requests explicitly", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const issued = authManager.issue("exampleapp", ["chat"]);
  const handler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig(undefined, {}),
    dataDir: dir,
    authManager,
    chatBackend: {
      async complete() {
        throw new Error("backend should not be called");
      },
    },
    version: "test",
  });

  const toolResponse = await handler(new Request("http://127.0.0.1:4141/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${issued.token}` },
    body: JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "x" } }],
    }),
  }));
  expect(toolResponse.status).toBe(400);
  expect(await toolResponse.json()).toEqual({
    error: {
      message: "OpenAI tool calls are not supported by this endpoint yet",
      type: "invalid_request_error",
      param: "tools",
      code: "unsupported_feature",
    },
  });

  const nResponse = await handler(new Request("http://127.0.0.1:4141/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${issued.token}` },
    body: JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
      n: 2,
    }),
  }));
  expect(nResponse.status).toBe(400);
  expect(await nResponse.json()).toEqual({
    error: {
      message: "Only n=1 is supported",
      type: "invalid_request_error",
      param: "n",
      code: "unsupported_value",
    },
  });

  const toolMessage = await handler(new Request("http://127.0.0.1:4141/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${issued.token}` },
    body: JSON.stringify({
      messages: [
        { role: "user", content: "hello" },
        { role: "tool", content: "tool result", tool_call_id: "call_1" },
      ],
    }),
  }));
  expect(toolMessage.status).toBe(400);
  expect(await toolMessage.json()).toEqual({
    error: {
      message: "Tool result messages are not supported yet",
      type: "invalid_request_error",
      param: "messages.1.role",
      code: "unsupported_feature",
    },
  });
});

test("chat completions reject image content and pass abort signals to the backend", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const issued = authManager.issue("exampleapp", ["chat"]);
  let backendSignal: AbortSignal | undefined;
  const handler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig(undefined, {}),
    dataDir: dir,
    authManager,
    chatBackend: {
      async complete(input) {
        backendSignal = input.signal;
        return { content: "ok" };
      },
    },
    version: "test",
  });

  const imageResponse = await handler(new Request("http://127.0.0.1:4141/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${issued.token}` },
    body: JSON.stringify({
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://example.test/image.png" } }],
        },
      ],
    }),
  }));
  expect(imageResponse.status).toBe(400);
  expect(await imageResponse.json()).toEqual({
    error: {
      message: "Only text message content parts are supported",
      type: "invalid_request_error",
      param: "messages.0.content.0",
      code: "unsupported_feature",
    },
  });

  const controller = new AbortController();
  await handler(new Request("http://127.0.0.1:4141/v1/chat/completions", {
    method: "POST",
    signal: controller.signal,
    headers: { Authorization: `Bearer ${issued.token}` },
    body: JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
      unknown_field_is_ignored: true,
    }),
  }));
  expect(backendSignal?.aborted).toBe(false);
});

test("chat completions propagate client abort while backend work is active", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const key = authManager.issue("exampleapp", ["chat"]);
  const controller = new AbortController();
  let observedAbort = false;
  const handler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig(undefined, {}),
    dataDir: dir,
    authManager,
    chatBackend: {
      async complete(input) {
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => {
            observedAbort = true;
            resolve();
          }, { once: true });
        });
        return { content: "aborted" };
      },
    },
    version: "test",
  });

  const inFlight = handler(new Request("http://127.0.0.1:4141/v1/chat/completions", {
    method: "POST",
    signal: controller.signal,
    headers: { Authorization: `Bearer ${key.token}` },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await inFlight;

  expect(observedAbort).toBe(true);
});

test("streaming chat completions emit OpenAI SSE chunks and DONE", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const issued = authManager.issue("exampleapp", ["chat"]);
  const handler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig(undefined, {}),
    dataDir: dir,
    authManager,
    chatBackend: {
      async complete() {
        throw new Error("non-streaming backend should not be called");
      },
      async *stream() {
        yield { type: "content", content: "hello" };
        yield { type: "content", content: " world" };
        yield { type: "done", finishReason: "stop" };
      },
    },
    version: "test",
  });

  const response = await handler(new Request("http://127.0.0.1:4141/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${issued.token}` },
    body: JSON.stringify({
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
  }));
  const text = await response.text();
  const frames = text.trim().split("\n\n");

  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toContain("text/event-stream");
  expect(frames[0]).toContain('"delta":{"role":"assistant"}');
  expect(frames[1]).toContain('"delta":{"content":"hello"}');
  expect(frames[2]).toContain('"delta":{"content":" world"}');
  expect(frames[3]).toContain('"finish_reason":"stop"');
  expect(frames[4]).toBe("data: [DONE]");
});

test("streaming chat completions hold concurrency until the stream finishes", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const key = authManager.issue("exampleapp", ["chat"]);
  let releaseStream!: () => void;
  let markStarted!: () => void;
  const streamStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const handler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig({ maxConcurrent: 1 }, {}),
    dataDir: dir,
    authManager,
    chatBackend: {
      async complete() {
        throw new Error("non-streaming backend should not be called");
      },
      async *stream() {
        markStarted();
        await new Promise<void>((resolve) => {
          releaseStream = resolve;
        });
        yield { type: "content", content: "done" };
        yield { type: "done", finishReason: "stop" };
      },
    },
    version: "test",
  });

  const stream = await handler(new Request("http://127.0.0.1:4141/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}` },
    body: JSON.stringify({
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
  }));
  expect(stream.status).toBe(200);
  await streamStarted;

  const limited = await handler(new Request("http://127.0.0.1:4141/health"));
  expect(limited.status).toBe(429);

  releaseStream();
  expect(await stream.text()).toContain("data: [DONE]");

  const afterStream = await handler(new Request("http://127.0.0.1:4141/health"));
  expect(afterStream.status).toBe(200);
});

test("streaming chat completions propagate request abort to the backend", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const key = authManager.issue("exampleapp", ["chat"]);
  const controller = new AbortController();
  let markStarted!: () => void;
  let markAborted!: () => void;
  const streamStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const backendAborted = new Promise<void>((resolve) => {
    markAborted = resolve;
  });
  const handler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig(undefined, {}),
    dataDir: dir,
    authManager,
    chatBackend: {
      async complete() {
        throw new Error("non-streaming backend should not be called");
      },
      async *stream(input) {
        markStarted();
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => {
            markAborted();
            resolve();
          }, { once: true });
        });
      },
    },
    version: "test",
  });

  const response = await handler(new Request("http://127.0.0.1:4141/v1/chat/completions", {
    method: "POST",
    signal: controller.signal,
    headers: { Authorization: `Bearer ${key.token}` },
    body: JSON.stringify({
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
  }));
  const text = response.text();

  await streamStarted;
  controller.abort();
  await backendAborted;

  expect(response.status).toBe(200);
  expect(await text).toContain("data: [DONE]");
});

test("chat and streaming feature flags are enforced", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const key = authManager.issue("exampleapp", ["chat"]);
  const chatBackend: ChatBackend = {
    async complete() {
      return { content: "backend should not be reached" };
    },
    async *stream() {
      yield { type: "content", content: "backend should not be reached" };
    },
  };

  const chatDisabled = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig({ features: { chat: false } }, {}),
    dataDir: dir,
    authManager,
    chatBackend,
    version: "test",
  });
  const disabled = await chatDisabled(new Request("http://127.0.0.1:4141/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}` },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  }));
  expect(disabled.status).toBe(404);
  expect(await disabled.json()).toEqual({
    error: {
      message: "Chat completions are not enabled",
      type: "invalid_request_error",
      param: null,
      code: "feature_disabled",
    },
  });

  const streamingDisabled = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig({ features: { streaming: false } }, {}),
    dataDir: dir,
    authManager,
    chatBackend,
    version: "test",
  });
  const stream = await streamingDisabled(new Request("http://127.0.0.1:4141/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}` },
    body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hello" }] }),
  }));
  expect(stream.status).toBe(400);
  expect(await stream.json()).toEqual({
    error: {
      message: "Streaming chat completions are not enabled",
      type: "invalid_request_error",
      param: "stream",
      code: "feature_disabled",
    },
  });
});

test("server startup rejects public bind addresses by default", async () => {
  const dir = makeTempDir();

  expect(() => startOpenAIEndpointServer({
    config: resolveOpenAIEndpointConfig({ host: "0.0.0.0", port: 0 }, {}),
    dataDir: dir,
  })).toThrow("public bind addresses");

  expect(() => startOpenAIEndpointServer({
    config: resolveOpenAIEndpointConfig({
      host: "0.0.0.0",
      port: 0,
      allowPublicBind: true,
      requireAuth: false,
    }, {}),
    dataDir: dir,
  })).toThrow("require auth");

  const server = startOpenAIEndpointServer({
    config: resolveOpenAIEndpointConfig({
      host: "0.0.0.0",
      port: 0,
      allowPublicBind: true,
      requireAuth: true,
    }, {}),
    dataDir: dir,
  });
  servers.push(server);
  expect(server.port).toBeGreaterThan(0);

  const health = await fetch(`http://127.0.0.1:${server.port}/health`, {
    headers: { Origin: "http://localhost:3000" },
  });
  expect(health.headers.get("Access-Control-Allow-Origin")).toBeNull();
});

test("endpoint enforces request size and concurrency admission limits", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const key = authManager.issue("exampleapp", ["chat"]);
  let releaseBackend!: () => void;
  const handler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig({ maxConcurrent: 1, maxRequestBytes: 5 }, {}),
    dataDir: dir,
    authManager,
    chatBackend: {
      async complete() {
        await new Promise<void>((resolve) => {
          releaseBackend = resolve;
        });
        return { content: "ok" };
      },
    },
    version: "test",
  });

  const tooLarge = await handler(new Request("http://127.0.0.1:4141/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key.token}`,
      "Content-Length": "6",
    },
    body: "{}",
  }));
  expect(tooLarge.status).toBe(413);

  const inFlight = handler(new Request("http://127.0.0.1:4141/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}` },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const limited = await handler(new Request("http://127.0.0.1:4141/health"));
  expect(limited.status).toBe(429);

  releaseBackend();
  expect((await inFlight).status).toBe(200);
});

test("endpoint aborts backend work after request timeout", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const key = authManager.issue("exampleapp", ["chat"]);
  let observedAbort = false;
  const handler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig({ requestTimeoutMs: 5 }, {}),
    dataDir: dir,
    authManager,
    chatBackend: {
      async complete(input) {
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => {
            observedAbort = true;
            resolve();
          }, { once: true });
        });
        return { content: "aborted" };
      },
    },
    version: "test",
  });

  const response = await handler(new Request("http://127.0.0.1:4141/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}` },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  }));

  expect(response.status).toBe(200);
  expect(observedAbort).toBe(true);
});

test("choomfie memory is app-scoped by bearer key and ignores body app overrides", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const appA = authManager.issue("exampleapp", ["memory"]);
  const appB = authManager.issue("notes", ["memory"]);
  const handler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig(undefined, {}),
    dataDir: dir,
    authManager,
    version: "test",
  });

  const write = await handler(new Request("http://127.0.0.1:4141/v1/choomfie/memory", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appA.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      app: "notes",
      key: "project",
      value: "exampleapp secret",
    }),
  }));
  expect(write.status).toBe(200);
  expect(await write.json()).toMatchObject({
    object: "choomfie.memory",
    app: "exampleapp",
    key: "project",
    value: "exampleapp secret",
  });

  const appARead = await handler(new Request("http://127.0.0.1:4141/v1/choomfie/memory?key=project", {
    headers: { Authorization: `Bearer ${appA.token}` },
  }));
  expect(await appARead.json()).toEqual({
    object: "choomfie.memory",
    key: "project",
    value: "exampleapp secret",
    found: true,
  });

  const appBRead = await handler(new Request("http://127.0.0.1:4141/v1/choomfie/memory?key=project", {
    headers: { Authorization: `Bearer ${appB.token}` },
  }));
  expect(await appBRead.json()).toEqual({
    object: "choomfie.memory",
    key: "project",
    value: null,
    found: false,
  });

  const appBDelete = await handler(new Request("http://127.0.0.1:4141/v1/choomfie/memory?key=project", {
    method: "DELETE",
    headers: { Authorization: `Bearer ${appB.token}` },
  }));
  expect(await appBDelete.json()).toEqual({
    object: "choomfie.memory.deleted",
    key: "project",
    deleted: false,
  });
});

test("choomfie memory persists across store restart", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const key = authManager.issue("exampleapp", ["memory"]);
  const firstStore = new AppMemoryStore(dir);
  const firstHandler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig(undefined, {}),
    dataDir: dir,
    authManager,
    appMemory: firstStore,
    version: "test",
  });

  const write = await firstHandler(new Request("http://127.0.0.1:4141/v1/choomfie/memory", {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}` },
    body: JSON.stringify({ key: "project", value: "persisted" }),
  }));
  expect(write.status).toBe(200);
  firstStore.close();

  const secondStore = new AppMemoryStore(dir);
  const secondHandler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig(undefined, {}),
    dataDir: dir,
    authManager,
    appMemory: secondStore,
    version: "test",
  });
  const read = await secondHandler(new Request("http://127.0.0.1:4141/v1/choomfie/memory?key=project", {
    headers: { Authorization: `Bearer ${key.token}` },
  }));

  expect(await read.json()).toEqual({
    object: "choomfie.memory",
    key: "project",
    value: "persisted",
    found: true,
  });
  secondStore.close();
});

test("choomfie memory requires memory scope and validates requests", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const chatOnly = authManager.issue("exampleapp", ["chat"]);
  const memory = authManager.issue("exampleapp", ["memory"]);
  const handler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig(undefined, {}),
    dataDir: dir,
    authManager,
    version: "test",
  });

  const forbidden = await handler(new Request("http://127.0.0.1:4141/v1/choomfie/memory?key=x", {
    headers: { Authorization: `Bearer ${chatOnly.token}` },
  }));
  expect(forbidden.status).toBe(401);

  const missingKey = await handler(new Request("http://127.0.0.1:4141/v1/choomfie/memory", {
    headers: { Authorization: `Bearer ${memory.token}` },
  }));
  expect(missingKey.status).toBe(400);
  expect(await missingKey.json()).toEqual({
    error: {
      message: "Missing memory key",
      type: "invalid_request_error",
      param: "key",
      code: "invalid_request",
    },
  });

  const badPost = await handler(new Request("http://127.0.0.1:4141/v1/choomfie/memory", {
    method: "POST",
    headers: { Authorization: `Bearer ${memory.token}` },
    body: JSON.stringify({ key: "x", value: { nested: true } }),
  }));
  expect(badPost.status).toBe(400);
  expect(await badPost.json()).toEqual({
    error: {
      message: "Memory value must be a string",
      type: "invalid_request_error",
      param: "value",
      code: "invalid_request",
    },
  });
});

test("choomfie notify validates scope and dispatches through notifier", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const notifyKey = authManager.issue("exampleapp", ["notify"]);
  const chatKey = authManager.issue("exampleapp", ["chat"]);
  const calls: unknown[] = [];
  const notifier: OpenAINotifier = {
    async notify(input) {
      calls.push(input);
      return { delivered: true, mode: input.channelId ? "channel" : "owner_dm" };
    },
  };
  const handler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig(undefined, {}),
    dataDir: dir,
    authManager,
    notifier,
    version: "test",
  });

  const forbidden = await handler(new Request("http://127.0.0.1:4141/v1/choomfie/notify", {
    method: "POST",
    headers: { Authorization: `Bearer ${chatKey.token}` },
    body: JSON.stringify({ message: "hello" }),
  }));
  expect(forbidden.status).toBe(401);

  const response = await handler(new Request("http://127.0.0.1:4141/v1/choomfie/notify", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${notifyKey.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: "ship finished",
      channel_id: "channel-1",
    }),
  }));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    object: "choomfie.notify",
    delivered: true,
    mode: "channel",
  });
  expect(calls).toEqual([
    {
      app: "exampleapp",
      content: "ship finished",
      channelId: "channel-1",
    },
  ]);
});

test("embeddings endpoint is feature-gated and returns OpenAI list shape", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const key = authManager.issue("exampleapp", ["embeddings"]);
  const calls: unknown[] = [];
  const embeddingProvider: EmbeddingProvider = {
    async embed(input, model) {
      calls.push({ input, model });
      return input.map((text, index) => [index, text.length]);
    },
  };
  const disabledHandler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig(undefined, {}),
    dataDir: dir,
    authManager,
    embeddingProvider,
    version: "test",
  });

  const disabled = await disabledHandler(new Request("http://127.0.0.1:4141/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}` },
    body: JSON.stringify({ input: "hello" }),
  }));
  expect(disabled.status).toBe(404);

  const enabledHandler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig({ features: { embeddings: true } }, {}),
    dataDir: dir,
    authManager,
    embeddingProvider,
    version: "test",
  });
  const response = await enabledHandler(new Request("http://127.0.0.1:4141/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}` },
    body: JSON.stringify({ input: ["hello", "world!"], model: "test-embed" }),
  }));
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body).toEqual({
    object: "list",
    data: [
      { object: "embedding", embedding: [0, 5], index: 0 },
      { object: "embedding", embedding: [1, 6], index: 1 },
    ],
    model: "test-embed",
    usage: {
      prompt_tokens: 4,
      total_tokens: 4,
    },
  });
  expect(calls).toEqual([{ input: ["hello", "world!"], model: "test-embed" }]);
});

test("Ollama embedding provider calls the local embeddings API", async () => {
  const calls: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== "/api/embeddings") {
        return new Response("not found", { status: 404 });
      }
      const body = await req.json();
      calls.push(body);
      return Response.json({ embedding: [calls.length, 0.5] });
    },
  });
  servers.push(server);

  const provider = new OllamaEmbeddingProvider({
    OLLAMA_BASE_URL: `http://127.0.0.1:${server.port}/`,
    OLLAMA_EMBEDDING_MODEL: "fallback-embed",
  });
  const embeddings = await provider.embed(["one", "two"], "explicit-embed");

  expect(embeddings).toEqual([[1, 0.5], [2, 0.5]]);
  expect(calls).toEqual([
    { model: "explicit-embed", prompt: "one" },
    { model: "explicit-embed", prompt: "two" },
  ]);
});

test("files endpoint stores metadata, raw content, and deletes files", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const key = authManager.issue("exampleapp", ["files"]);
  const handler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig({ features: { files: true }, maxFileBytes: 32 }, {}),
    dataDir: dir,
    authManager,
    version: "test",
  });

  const form = new FormData();
  form.set("purpose", "assistants");
  form.set("file", new File(["hello file"], "note.txt", { type: "text/plain" }));
  const upload = await handler(new Request("http://127.0.0.1:4141/v1/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}` },
    body: form,
  }));
  const uploaded = await upload.json() as { id: string; object: string; bytes: number; filename: string; purpose: string };

  expect(upload.status).toBe(200);
  expect(uploaded.id.startsWith("file_")).toBe(true);
  expect(uploaded).toMatchObject({
    object: "file",
    bytes: 10,
    filename: "note.txt",
    purpose: "assistants",
  });

  const metadata = await handler(new Request(`http://127.0.0.1:4141/v1/files/${uploaded.id}`, {
    headers: { Authorization: `Bearer ${key.token}` },
  }));
  expect(await metadata.json()).toMatchObject(uploaded);

  const db = new Database(join(dir, "choomfie.db"));
  const row = db
    .query("SELECT content_hash FROM openai_files WHERE id = ?")
    .get(uploaded.id) as { content_hash: string } | null;
  expect(row?.content_hash).toBe(`sha256:${createHash("sha256").update("hello file").digest("hex")}`);
  db.close();

  const filePath = join(dir, "openai-files", uploaded.id);
  expect(existsSync(filePath)).toBe(true);

  const content = await handler(new Request(`http://127.0.0.1:4141/v1/files/${uploaded.id}/content`, {
    headers: { Authorization: `Bearer ${key.token}` },
  }));
  expect(await content.text()).toBe("hello file");

  const deleted = await handler(new Request(`http://127.0.0.1:4141/v1/files/${uploaded.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${key.token}` },
  }));
  expect(await deleted.json()).toEqual({
    id: uploaded.id,
    object: "file",
    deleted: true,
  });
  expect(existsSync(filePath)).toBe(false);

  const missingAfterDelete = await handler(new Request(`http://127.0.0.1:4141/v1/files/${uploaded.id}`, {
    headers: { Authorization: `Bearer ${key.token}` },
  }));
  expect(missingAfterDelete.status).toBe(404);
});

test("files endpoint rejects oversized uploads and path traversal IDs", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const key = authManager.issue("exampleapp", ["files"]);
  const handler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig({ features: { files: true }, maxFileBytes: 4 }, {}),
    dataDir: dir,
    authManager,
    version: "test",
  });

  const form = new FormData();
  form.set("purpose", "assistants");
  form.set("file", new File(["too large"], "large.txt"));
  const upload = await handler(new Request("http://127.0.0.1:4141/v1/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}` },
    body: form,
  }));
  expect(upload.status).toBe(400);

  const traversal = await handler(new Request("http://127.0.0.1:4141/v1/files/../../secret", {
    headers: { Authorization: `Bearer ${key.token}` },
  }));
  expect(traversal.status).toBe(404);
});

test("responses endpoint creates, retrieves, lists input items, and deletes stored responses", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const key = authManager.issue("exampleapp", ["responses"]);
  const handler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig({ features: { responses: true } }, {}),
    dataDir: dir,
    authManager,
    chatBackend: {
      async complete(input) {
        return {
          content: `answer: ${input.messages[0].content}`,
          usage: {
            prompt_tokens: 4,
            completion_tokens: 2,
            total_tokens: 6,
          },
        };
      },
    },
    version: "test",
  });

  const create = await handler(new Request("http://127.0.0.1:4141/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: "hello",
      model: "choomfie-claude-sonnet",
    }),
  }));
  const created = await create.json() as {
    id: string;
    object: string;
    status: string;
    output: Array<{ content: Array<{ type: string; text: string }> }>;
    usage: { input_tokens: number; output_tokens: number; total_tokens: number };
  };

  expect(create.status).toBe(200);
  expect(created.id.startsWith("resp_")).toBe(true);
  expect(created.object).toBe("response");
  expect(created.status).toBe("completed");
  expect(created.output[0].content[0]).toEqual({ type: "output_text", text: "answer: hello" });
  expect(created.usage).toEqual({ input_tokens: 4, output_tokens: 2, total_tokens: 6 });

  const fetched = await handler(new Request(`http://127.0.0.1:4141/v1/responses/${created.id}`, {
    headers: { Authorization: `Bearer ${key.token}` },
  }));
  expect(await fetched.json()).toEqual(created);

  const inputItems = await handler(new Request(`http://127.0.0.1:4141/v1/responses/${created.id}/input_items`, {
    headers: { Authorization: `Bearer ${key.token}` },
  }));
  expect(await inputItems.json()).toEqual({
    object: "list",
    data: [{ id: "input_0", object: "response.input_item", content: "hello" }],
  });

  const deleted = await handler(new Request(`http://127.0.0.1:4141/v1/responses/${created.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${key.token}` },
  }));
  expect(await deleted.json()).toEqual({
    id: created.id,
    object: "response.deleted",
    deleted: true,
  });
});

test("responses previous_response_id reconstructs stored context and stream is rejected", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const key = authManager.issue("exampleapp", ["responses"]);
  const calls: unknown[] = [];
  const handler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig({ features: { responses: true } }, {}),
    dataDir: dir,
    authManager,
    chatBackend: {
      async complete(input) {
        calls.push(input.messages);
        return { content: `turn ${calls.length}` };
      },
    },
    version: "test",
  });

  const first = await handler(new Request("http://127.0.0.1:4141/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}` },
    body: JSON.stringify({ input: "first" }),
  }));
  const firstBody = await first.json() as { id: string };

  const second = await handler(new Request("http://127.0.0.1:4141/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}` },
    body: JSON.stringify({ input: "second", previous_response_id: firstBody.id }),
  }));
  const secondBody = await second.json() as { id: string; previous_response_id: string };

  expect(second.status).toBe(200);
  expect(secondBody.previous_response_id).toBe(firstBody.id);
  expect(calls[1]).toEqual([
    { role: "user", content: "first" },
    { role: "assistant", content: "turn 1" },
    { role: "user", content: "second" },
  ]);

  const third = await handler(new Request("http://127.0.0.1:4141/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}` },
    body: JSON.stringify({ input: "third", previous_response_id: secondBody.id }),
  }));
  const thirdBody = await third.json() as { previous_response_id: string };

  expect(third.status).toBe(200);
  expect(thirdBody.previous_response_id).toBe(secondBody.id);
  expect(calls[2]).toEqual([
    { role: "user", content: "first" },
    { role: "assistant", content: "turn 1" },
    { role: "user", content: "second" },
    { role: "assistant", content: "turn 2" },
    { role: "user", content: "third" },
  ]);

  const streamed = await handler(new Request("http://127.0.0.1:4141/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}` },
    body: JSON.stringify({ input: "stream", stream: true }),
  }));
  expect(streamed.status).toBe(400);
});

test("responses cleanup expired stored responses before retrieval", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const key = authManager.issue("exampleapp", ["responses"]);
  const handler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig({ features: { responses: true }, responseTtlDays: 0 }, {}),
    dataDir: dir,
    authManager,
    chatBackend: {
      async complete() {
        return { content: "short lived" };
      },
    },
    version: "test",
  });

  const created = await handler(new Request("http://127.0.0.1:4141/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}` },
    body: JSON.stringify({ input: "expires now" }),
  }));
  const createdBody = await created.json() as { id: string };
  expect(created.status).toBe(200);

  const fetched = await handler(new Request(`http://127.0.0.1:4141/v1/responses/${createdBody.id}`, {
    headers: { Authorization: `Bearer ${key.token}` },
  }));
  expect(fetched.status).toBe(404);

  const inputItems = await handler(new Request(`http://127.0.0.1:4141/v1/responses/${createdBody.id}/input_items`, {
    headers: { Authorization: `Bearer ${key.token}` },
  }));
  expect(inputItems.status).toBe(404);
});

test("skills extension is feature-gated and invokes through skill bridge", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const key = authManager.issue("exampleapp", ["skills"]);
  const chatOnly = authManager.issue("exampleapp", ["chat"]);
  const calls: unknown[] = [];
  const skillBridge: OpenAISkillBridge = {
    async list() {
      return [{ name: "remember", description: "Save a memory" }];
    },
    async invoke(name, args) {
      calls.push({ name, args });
      return { ok: true };
    },
  };
  const disabledHandler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig(undefined, {}),
    dataDir: dir,
    authManager,
    skillBridge,
    version: "test",
  });

  const disabled = await disabledHandler(new Request("http://127.0.0.1:4141/v1/choomfie/skills", {
    headers: { Authorization: `Bearer ${key.token}` },
  }));
  expect(disabled.status).toBe(404);

  const handler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig({ features: { skills: true } }, {}),
    dataDir: dir,
    authManager,
    skillBridge,
    version: "test",
  });
  const list = await handler(new Request("http://127.0.0.1:4141/v1/choomfie/skills", {
    headers: { Authorization: `Bearer ${key.token}` },
  }));
  expect(await list.json()).toEqual({
    object: "list",
    data: [{ name: "remember", description: "Save a memory" }],
  });

  const wrongScope = await handler(new Request("http://127.0.0.1:4141/v1/choomfie/skills", {
    headers: { Authorization: `Bearer ${chatOnly.token}` },
  }));
  expect(wrongScope.status).toBe(401);

  const invoke = await handler(new Request("http://127.0.0.1:4141/v1/choomfie/skills/invoke", {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}` },
    body: JSON.stringify({
      name: "remember",
      args: { key: "x" },
    }),
  }));
  expect(await invoke.json()).toEqual({
    object: "choomfie.skill_result",
    name: "remember",
    result: { ok: true },
  });
  expect(calls).toEqual([{ name: "remember", args: { key: "x" } }]);

  const denied = await handler(new Request("http://127.0.0.1:4141/v1/choomfie/skills/invoke", {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}` },
    body: JSON.stringify({
      name: "not-listed",
      args: {},
    }),
  }));
  expect(denied.status).toBe(400);
  expect(await denied.json()).toEqual({
    error: {
      message: "Skill is not allowed: not-listed",
      type: "invalid_request_error",
      param: "name",
      code: "not_allowed",
    },
  });
  expect(calls).toEqual([{ name: "remember", args: { key: "x" } }]);
});

test("Hermes mode passes standard OpenAI routes through when Hermes endpoint is healthy", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const key = authManager.issue("exampleapp", ["chat"]);
  const calls: string[] = [];
  const hermesAdapter: HermesAdapter = {
    async isAvailable() {
      return true;
    },
    async passThrough(req) {
      calls.push(`${req.method} ${new URL(req.url).pathname}`);
      return new Response(JSON.stringify({ object: "list", data: [{ id: "hermes-model" }] }), {
        headers: { "Content-Type": "application/json" },
      });
    },
    async chat() {
      throw new Error("CLI fallback should not be used");
    },
  };
  const handler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig({ routing: { mode: "hermes" } }, {}),
    dataDir: dir,
    authManager,
    hermesAdapter,
    version: "test",
  });

  const response = await handler(new Request("http://127.0.0.1:4141/v1/models", {
    headers: { Authorization: `Bearer ${key.token}` },
  }));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ object: "list", data: [{ id: "hermes-model" }] });
  expect(calls).toEqual(["GET /v1/models"]);
});

test("Default Hermes adapter probes health and maps OpenAI pass-through routes", async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        calls.push({ method: req.method, path: url.pathname });
        return Response.json({ status: "ok" });
      }
      if (url.pathname === "/v1/chat/completions") {
        const body = await req.json();
        calls.push({ method: req.method, path: `${url.pathname}${url.search}`, body });
        return Response.json({ object: "chat.completion", choices: [] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  const config = resolveOpenAIEndpointConfig({
    routing: {
      mode: "hermes",
      hermesBaseUrl: `http://127.0.0.1:${server.port}/v1`,
    },
  }, {});
  const adapter = new DefaultHermesAdapter();

  expect(await adapter.isAvailable(config)).toBe(true);
  const response = await adapter.passThrough(new Request("http://127.0.0.1:4141/v1/chat/completions?trace=1", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  }), config);

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ object: "chat.completion", choices: [] });
  expect(calls).toEqual([
    { method: "GET", path: "/health" },
    {
      method: "POST",
      path: "/v1/chat/completions?trace=1",
      body: { messages: [{ role: "user", content: "hello" }] },
    },
  ]);
});

test("Hermes mode uses CLI fallback only for non-streaming chat when Hermes endpoint is unavailable", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const key = authManager.issue("exampleapp", ["chat"]);
  const prompts: string[] = [];
  const hermesAdapter: HermesAdapter = {
    async isAvailable() {
      return false;
    },
    async passThrough() {
      throw new Error("Pass-through should not be used");
    },
    async chat(prompt) {
      prompts.push(prompt);
      return "hermes cli answer";
    },
  };
  const handler = createOpenAIEndpointHandler({
    config: resolveOpenAIEndpointConfig({ routing: { mode: "hermes" } }, {}),
    dataDir: dir,
    authManager,
    hermesAdapter,
    version: "test",
  });

  const health = await handler(new Request("http://127.0.0.1:4141/health"));
  expect((await health.json() as { backend: string }).backend).toBe("hermes_cli_fallback");

  const response = await handler(new Request("http://127.0.0.1:4141/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}` },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  }));
  const body = await response.json() as { object: string; choices: Array<{ message: { content: string } }> };
  expect(response.status).toBe(200);
  expect(body.object).toBe("chat.completion");
  expect(body.choices[0].message.content).toBe("hermes cli answer");
  expect(prompts[0]).toContain("USER:\nhello");

  const streaming = await handler(new Request("http://127.0.0.1:4141/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key.token}` },
    body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hello" }] }),
  }));
  expect(streaming.status).toBe(400);
});

test("integration server on port 0 exercises HTTP auth and chat with fake backend", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const key = authManager.issue("exampleapp", ["chat", "models"]);
  const server = startOpenAIEndpointServer({
    config: resolveOpenAIEndpointConfig({ port: 0 }, {}),
    dataDir: dir,
    authManager,
    chatBackend: {
      async complete(input) {
        return { content: `http ${input.messages.at(-1)?.content}` };
      },
    },
    version: "test",
  });
  servers.push(server);
  const baseUrl = `http://${server.hostname}:${server.port}`;

  const unauthorized = await fetch(`${baseUrl}/v1/models`);
  expect(unauthorized.status).toBe(401);

  const invalidToken = await fetch(`${baseUrl}/v1/models`, {
    headers: { Authorization: "Bearer sk-choomfie-exampleapp-invalid" },
  });
  expect(invalidToken.status).toBe(401);

  const wrongScope = authManager.issue("exampleapp", ["memory"]);
  const missingScope = await fetch(`${baseUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${wrongScope.token}` },
  });
  expect(missingScope.status).toBe(401);

  const models = await fetch(`${baseUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${key.token}` },
  });
  expect(models.status).toBe(200);
  expect((await models.json() as { object: string }).object).toBe("list");

  const chat = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  });
  const body = await chat.json() as { object: string; choices: Array<{ message: { content: string } }> };
  expect(chat.status).toBe(200);
  expect(body.object).toBe("chat.completion");
  expect(body.choices[0].message.content).toBe("http hello");
});

test("OpenAI Node SDK can list models and create a chat completion", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const key = authManager.issue("exampleapp", ["chat", "models"]);
  const server = startOpenAIEndpointServer({
    config: resolveOpenAIEndpointConfig({ port: 0 }, {}),
    dataDir: dir,
    authManager,
    chatBackend: {
      async complete(input) {
        return { content: `sdk ${input.messages.at(-1)?.content}` };
      },
    },
    version: "test",
  });
  servers.push(server);

  const client = new OpenAI({
    apiKey: key.token,
    baseURL: `http://${server.hostname}:${server.port}/v1`,
  });

  const models = await client.models.list();
  expect(models.object).toBe("list");
  expect(models.data.some((model) => model.id === "choomfie-claude-sonnet")).toBe(true);

  const chat = await client.chat.completions.create({
    model: "choomfie-claude-sonnet",
    messages: [{ role: "user", content: "hello" }],
  });
  expect(chat.object).toBe("chat.completion");
  expect(chat.choices[0]?.message.content).toBe("sdk hello");
});

test("OpenAI Node SDK streaming iterator receives chat completion chunks", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const key = authManager.issue("exampleapp", ["chat"]);
  const server = startOpenAIEndpointServer({
    config: resolveOpenAIEndpointConfig({ port: 0 }, {}),
    dataDir: dir,
    authManager,
    chatBackend: {
      async complete() {
        throw new Error("complete should not be called for streaming SDK test");
      },
      async *stream() {
        yield { type: "content", content: "stream " };
        yield { type: "content", content: "ok" };
        yield { type: "done", finishReason: "stop" };
      },
    },
    version: "test",
  });
  servers.push(server);

  const client = new OpenAI({
    apiKey: key.token,
    baseURL: `http://${server.hostname}:${server.port}/v1`,
  });
  const stream = await client.chat.completions.create({
    model: "choomfie-claude-sonnet",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  });
  let text = "";
  for await (const chunk of stream) {
    text += chunk.choices[0]?.delta.content ?? "";
  }

  expect(text).toBe("stream ok");
});

test("OpenAI Node SDK embeddings.create returns fake provider vectors", async () => {
  const dir = makeTempDir();
  const authManager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const key = authManager.issue("exampleapp", ["embeddings"]);
  const server = startOpenAIEndpointServer({
    config: resolveOpenAIEndpointConfig({ port: 0, features: { embeddings: true } }, {}),
    dataDir: dir,
    authManager,
    embeddingProvider: {
      async embed(input) {
        return input.map((value, index) => [index, value.length]);
      },
    },
    version: "test",
  });
  servers.push(server);

  const client = new OpenAI({
    apiKey: key.token,
    baseURL: `http://${server.hostname}:${server.port}/v1`,
  });
  const result = await client.embeddings.create({
    model: "fake-embedding",
    input: ["hi", "there"],
    encoding_format: "float",
  });

  expect(result.object).toBe("list");
  expect(result.data.map((item) => item.embedding)).toEqual([[0, 2], [1, 5]]);
});
