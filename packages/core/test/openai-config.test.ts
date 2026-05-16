import { expect, test } from "bun:test";
import {
  DEFAULT_OPENAI_ENDPOINT_CONFIG,
  mergeOpenAIEndpointConfig,
  resolveOpenAIEndpointConfig,
} from "../lib/openai/config.ts";
import { openAIErrorEnvelope } from "../lib/openai/types.ts";

test("OpenAI endpoint config defaults match the Phase 0 localhost posture", () => {
  const config = resolveOpenAIEndpointConfig(undefined, {});

  expect(config.enabled).toBe(false);
  expect(config.host).toBe("127.0.0.1");
  expect(config.port).toBe(4141);
  expect(config.allowPublicBind).toBe(false);
  expect(config.requireAuth).toBe(true);
  expect(config.routing.mode).toBe("claude_code");
  expect(config.models.default).toBe("choomfie-claude-sonnet");
  expect(config.models.aliases["choomfie-claude-sonnet"]).toEqual({
    backend: "claude_code",
    model: "claude-sonnet-4-6",
  });
});

test("OpenAI endpoint config deep-merges saved JSON with defaults", () => {
  const config = mergeOpenAIEndpointConfig({
    enabled: true,
    models: {
      default: "custom",
      aliases: {
        custom: {
          backend: "test",
          model: "test-model",
        },
      },
    },
    features: {
      streaming: false,
    },
  });

  expect(config.enabled).toBe(true);
  expect(config.models.default).toBe("custom");
  expect(config.models.aliases.custom).toEqual({ backend: "test", model: "test-model" });
  expect(config.models.aliases["choomfie-local"]).toEqual(
    DEFAULT_OPENAI_ENDPOINT_CONFIG.models.aliases["choomfie-local"],
  );
  expect(config.features.streaming).toBe(false);
  expect(config.features.chat).toBe(true);
});

test("OpenAI endpoint environment overrides take precedence", () => {
  const config = resolveOpenAIEndpointConfig(
    {
      enabled: false,
      host: "127.0.0.1",
      port: 4141,
      routing: { mode: "claude_code" },
    },
    {
      CHOOMFIE_OPENAI_ENABLED: "true",
      CHOOMFIE_OPENAI_HOST: "localhost",
      CHOOMFIE_OPENAI_PORT: "5151",
      CHOOMFIE_OPENAI_ALLOW_PUBLIC_BIND: "true",
      CHOOMFIE_OPENAI_REQUIRE_AUTH: "false",
      CHOOMFIE_OPENAI_ROUTING_MODE: "hermes",
      CHOOMFIE_OPENAI_HERMES_BASE_URL: "http://127.0.0.1:8642/v1",
      CHOOMFIE_OPENAI_DEFAULT_MODEL: "choomfie-local",
      CHOOMFIE_OPENAI_MAX_CONCURRENT: "9",
      CHOOMFIE_OPENAI_REQUEST_TIMEOUT_MS: "5000",
      CHOOMFIE_OPENAI_MAX_FILE_BYTES: "12345",
    },
  );

  expect(config.enabled).toBe(true);
  expect(config.host).toBe("localhost");
  expect(config.port).toBe(5151);
  expect(config.allowPublicBind).toBe(true);
  expect(config.requireAuth).toBe(false);
  expect(config.routing.mode).toBe("hermes");
  expect(config.models.default).toBe("choomfie-local");
  expect(config.maxConcurrent).toBe(9);
  expect(config.requestTimeoutMs).toBe(5000);
  expect(config.maxFileBytes).toBe(12345);
});

test("OpenAI endpoint disables default CORS origins for public binds unless explicitly configured", () => {
  const defaultCorsDisabled = resolveOpenAIEndpointConfig(
    {
      host: "0.0.0.0",
      allowPublicBind: true,
      requireAuth: true,
    },
    {},
  );
  expect(defaultCorsDisabled.corsOrigins).toEqual([]);

  const explicitCors = resolveOpenAIEndpointConfig(
    {
      host: "0.0.0.0",
      allowPublicBind: true,
      requireAuth: true,
      corsOrigins: ["http://localhost:3000"],
    },
    {},
  );
  expect(explicitCors.corsOrigins).toEqual(["http://localhost:3000"]);
});

test("OpenAI error envelopes use the expected public shape", () => {
  expect(openAIErrorEnvelope("missing messages", "invalid_request_error", "messages", "invalid_request")).toEqual({
    error: {
      message: "missing messages",
      type: "invalid_request_error",
      param: "messages",
      code: "invalid_request",
    },
  });
});
