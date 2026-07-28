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

// A Discord turn is a chat completion, not a coding session, but the agent still
// needs room to use a tool and then answer. maxTurns:1 made ANY tool use a hard
// error ("Reached maximum number of turns (1)") instead of a reply — that filled
// the endpoint log on 2026-07-13. Small enough to bound cost on a runaway loop.
const MAX_TURNS = 8;

// SDK isolation mode. Previously ["user", "project"], which loaded the global +
// project CLAUDE.md into EVERY Discord message: measured at 36,584 cache-creation
// tokens (~$0.22) for a one-word reply. Choomfie's persona comes from Hermes's
// system prompt, so the dev-repo context was pure overhead on a metered pool.
const SETTING_SOURCES: [] = [];

function formatTranscript(messages: NormalizedChatMessage[]): string {
  return messages
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join("\n\n");
}

// Exported for tests — these two encode the cost/failure contract of the brain
// (see agent-sdk-adapter.test.ts) and are easy to regress silently.
export function queryOptions(input: ChatBackendInput, includePartialMessages: boolean) {
  return {
    model: input.backendModel,
    maxTurns: MAX_TURNS,
    includePartialMessages,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    settingSources: SETTING_SOURCES,
  };
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

export function usageFromResult(result: SDKResultMessage): ChatBackendOutput["usage"] {
  const usage = result.usage;
  // Cache tokens ARE input tokens and are billed. Counting only input_tokens
  // reported 3 prompt_tokens for a turn that actually consumed ~36.6k, and
  // hermes-overlay/scripts/token-budget.sh reads these numbers via `hermes
  // insights` — so the daily 2M warn / 3M hard-stop never tripped.
  const inputTokens =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0);
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
      options: queryOptions(input, false),
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
      options: queryOptions(input, true),
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
