import { randomBytes } from "node:crypto";
import {
  ChatCompletionRequestSchema,
  openAIErrorResponse,
  type ChatCompletionRequest,
} from "./types.ts";
import type { OpenAIEndpointConfig } from "./config.ts";
import { encodeSSE, sseDoneChunk, sseJsonChunk } from "./sse.ts";

export interface NormalizedChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatBackendInput {
  model: string;
  backendModel: string;
  messages: NormalizedChatMessage[];
  signal?: AbortSignal;
}

export interface ChatBackendOutput {
  content: string;
  finishReason?: "stop" | "length" | "content_filter";
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export type ChatBackendStreamEvent =
  | { type: "content"; content: string }
  | { type: "done"; finishReason?: "stop" | "length" | "content_filter"; usage?: ChatBackendOutput["usage"] };

export interface ChatBackend {
  complete(input: ChatBackendInput): Promise<ChatBackendOutput>;
  stream?(input: ChatBackendInput): AsyncIterable<ChatBackendStreamEvent>;
}

export function normalizeChatRequest(
  body: unknown,
  config: OpenAIEndpointConfig,
): { ok: true; request: ChatCompletionRequest; messages: NormalizedChatMessage[]; model: string; backendModel: string } | { ok: false; response: Response } {
  const parsed = ChatCompletionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      response: openAIErrorResponse(400, "Invalid chat completion request", "invalid_request_error", "messages", "invalid_request"),
    };
  }

  const request = parsed.data;
  const model = request.model ?? config.models.default;
  const alias = config.models.aliases[model];
  if (!alias) {
    return {
      ok: false,
      response: openAIErrorResponse(400, `Unknown model: ${model}`, "invalid_request_error", "model", "model_not_found"),
    };
  }

  if ((request.n ?? 1) > 1) {
    return {
      ok: false,
      response: openAIErrorResponse(400, "Only n=1 is supported", "invalid_request_error", "n", "unsupported_value"),
    };
  }

  if (request.tools && request.tools.length > 0) {
    return {
      ok: false,
      response: openAIErrorResponse(400, "OpenAI tool calls are not supported by this endpoint yet", "invalid_request_error", "tools", "unsupported_feature"),
    };
  }

  if (request.audio || (request.modalities && request.modalities.some((modality) => modality !== "text"))) {
    return {
      ok: false,
      response: openAIErrorResponse(400, "Only text chat completions are supported", "invalid_request_error", "modalities", "unsupported_feature"),
    };
  }

  const messages: NormalizedChatMessage[] = [];
  for (const [index, message] of request.messages.entries()) {
    if (message.role === "tool") {
      return {
        ok: false,
        response: openAIErrorResponse(400, "Tool result messages are not supported yet", "invalid_request_error", `messages.${index}.role`, "unsupported_feature"),
      };
    }

    const content = normalizeContent(message.content, index);
    if (content.ok === false) {
      return { ok: false, response: content.response };
    }
    messages.push({ role: message.role, content: content.value });
  }

  if (messages.length === 0) {
    return {
      ok: false,
      response: openAIErrorResponse(400, "At least one message is required", "invalid_request_error", "messages", "invalid_request"),
    };
  }

  return {
    ok: true,
    request,
    messages,
    model,
    backendModel: alias.model,
  };
}

function normalizeContent(content: ChatCompletionRequest["messages"][number]["content"], messageIndex: number): { ok: true; value: string } | { ok: false; response: Response } {
  if (typeof content === "string") {
    return { ok: true, value: content };
  }

  if (content === null) {
    return {
      ok: false,
      response: openAIErrorResponse(400, "Message content must be text", "invalid_request_error", `messages.${messageIndex}.content`, "invalid_request"),
    };
  }

  const parts: string[] = [];
  for (const [partIndex, part] of content.entries()) {
    if (part.type !== "text" || typeof part.text !== "string") {
      const param = `messages.${messageIndex}.content.${partIndex}`;
      return {
        ok: false,
        response: openAIErrorResponse(400, "Only text message content parts are supported", "invalid_request_error", param, "unsupported_feature"),
      };
    }
    parts.push(part.text);
  }

  return { ok: true, value: parts.join("") };
}

export async function createChatCompletionResponse(
  normalized: { model: string; backendModel: string; messages: NormalizedChatMessage[] },
  backend: ChatBackend,
  signal?: AbortSignal,
  extensionMetadata?: Record<string, unknown>,
): Promise<Response> {
  const output = await backend.complete({
    model: normalized.model,
    backendModel: normalized.backendModel,
    messages: normalized.messages,
    signal,
  });

  const promptTokens = output.usage?.prompt_tokens ?? 0;
  const completionTokens = output.usage?.completion_tokens ?? 0;
  const totalTokens = output.usage?.total_tokens ?? promptTokens + completionTokens;

  return new Response(JSON.stringify({
    id: `chatcmpl_${randomBytes(12).toString("base64url")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: normalized.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: output.content,
        },
        finish_reason: output.finishReason ?? "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
    },
    ...(extensionMetadata ? { choomfie: extensionMetadata } : {}),
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export function createChatCompletionStreamResponse(
  normalized: { model: string; backendModel: string; messages: NormalizedChatMessage[] },
  backend: ChatBackend,
  signal?: AbortSignal,
  onDone?: () => void,
): Response {
  const id = `chatcmpl_${randomBytes(12).toString("base64url")}`;
  const created = Math.floor(Date.now() / 1000);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    onDone?.();
  };
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (value: unknown) => controller.enqueue(encodeSSE(sseJsonChunk(value)));
      enqueue({
        id,
        object: "chat.completion.chunk",
        created,
        model: normalized.model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
          },
        ],
      });

      let finishReason: "stop" | "length" | "content_filter" = "stop";
      try {
        if (backend.stream) {
          for await (const event of backend.stream({
            model: normalized.model,
            backendModel: normalized.backendModel,
            messages: normalized.messages,
            signal,
          })) {
            if (event.type === "content" && event.content) {
              enqueue({
                id,
                object: "chat.completion.chunk",
                created,
                model: normalized.model,
                choices: [
                  {
                    index: 0,
                    delta: { content: event.content },
                    finish_reason: null,
                  },
                ],
              });
            } else if (event.type === "done") {
              finishReason = event.finishReason ?? "stop";
            }
          }
        } else {
          const output = await backend.complete({
            model: normalized.model,
            backendModel: normalized.backendModel,
            messages: normalized.messages,
            signal,
          });
          finishReason = output.finishReason ?? "stop";
          if (output.content) {
            enqueue({
              id,
              object: "chat.completion.chunk",
              created,
              model: normalized.model,
              choices: [
                {
                  index: 0,
                  delta: { content: output.content },
                  finish_reason: null,
                },
              ],
            });
          }
        }

        enqueue({
          id,
          object: "chat.completion.chunk",
          created,
          model: normalized.model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: finishReason,
            },
          ],
        });
        controller.enqueue(encodeSSE(sseDoneChunk()));
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        finish();
      }
    },
    cancel() {
      finish();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
