import {
  query,
  type SDKAssistantMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ChatBackend,
  ChatBackendInput,
  ChatBackendOutput,
  ChatBackendStreamEvent,
  NormalizedChatMessage,
} from "./chat.ts";

function formatTranscript(messages: NormalizedChatMessage[]): string {
  return messages
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join("\n\n");
}

function assistantText(message: SDKAssistantMessage): string {
  const content = message.message?.content;
  if (!Array.isArray(content)) return "";

  const text: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      text.push(block.text);
    }
  }
  return text.join("\n");
}

function usageFromResult(result: SDKResultMessage): ChatBackendOutput["usage"] {
  const usage = result.usage;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  };
}

export class ClaudeAgentSDKChatBackend implements ChatBackend {
  async complete(input: ChatBackendInput): Promise<ChatBackendOutput> {
    const sdkQuery = query({
      prompt: formatTranscript(input.messages),
      options: {
        model: input.backendModel,
        maxTurns: 1,
        includePartialMessages: false,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: ["user", "project"],
      },
    });

    const abort = () => sdkQuery.close();
    input.signal?.addEventListener("abort", abort, { once: true });

    let lastAssistantText = "";
    try {
      for await (const message of sdkQuery) {
        if (message.type === "assistant") {
          lastAssistantText = assistantText(message) || lastAssistantText;
        }
        if (message.type === "result") {
          if (message.subtype !== "success") {
            throw new Error(message.errors?.join("; ") || message.subtype);
          }
          return {
            content: message.result || lastAssistantText,
            finishReason: message.stop_reason === "max_tokens" ? "length" : "stop",
            usage: usageFromResult(message),
          };
        }
      }
    } finally {
      input.signal?.removeEventListener("abort", abort);
    }

    return {
      content: lastAssistantText,
      finishReason: "stop",
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };
  }

  async *stream(input: ChatBackendInput): AsyncIterable<ChatBackendStreamEvent> {
    const sdkQuery = query({
      prompt: formatTranscript(input.messages),
      options: {
        model: input.backendModel,
        maxTurns: 1,
        includePartialMessages: true,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: ["user", "project"],
      },
    });

    const abort = () => sdkQuery.close();
    input.signal?.addEventListener("abort", abort, { once: true });

    let sentContent = false;
    let lastAssistantText = "";
    try {
      for await (const message of sdkQuery) {
        if (message.type === "stream_event") {
          const event = message.event;
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            sentContent = true;
            yield { type: "content", content: event.delta.text };
          }
        }
        if (message.type === "assistant") {
          lastAssistantText = assistantText(message) || lastAssistantText;
        }
        if (message.type === "result") {
          if (message.subtype !== "success") {
            throw new Error(message.errors?.join("; ") || message.subtype);
          }
          const finalText = message.result || lastAssistantText;
          if (!sentContent && finalText) {
            yield { type: "content", content: finalText };
          }
          yield {
            type: "done",
            finishReason: message.stop_reason === "max_tokens" ? "length" : "stop",
            usage: usageFromResult(message),
          };
        }
      }
    } finally {
      input.signal?.removeEventListener("abort", abort);
    }
  }
}
