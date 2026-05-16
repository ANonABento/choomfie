import { z } from "zod";

export const ChatCompletionRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.union([
      z.string(),
      z.array(z.record(z.unknown())),
      z.null(),
    ]),
  }).passthrough()),
  stream: z.boolean().optional(),
  n: z.number().int().positive().optional(),
  tools: z.array(z.unknown()).optional(),
  modalities: z.array(z.string()).optional(),
  audio: z.unknown().optional(),
}).passthrough();

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

export interface OpenAIErrorEnvelope {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

export interface OpenAIModelObject {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export interface OpenAIModelList {
  object: "list";
  data: OpenAIModelObject[];
}

export function openAIErrorEnvelope(
  message: string,
  type = "invalid_request_error",
  param: string | null = null,
  code: string | null = "invalid_request",
): OpenAIErrorEnvelope {
  return {
    error: {
      message,
      type,
      param,
      code,
    },
  };
}

export function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

export function openAIErrorResponse(
  status: number,
  message: string,
  type = "invalid_request_error",
  param: string | null = null,
  code: string | null = "invalid_request",
): Response {
  return jsonResponse(openAIErrorEnvelope(message, type, param, code), status);
}
