import {
  query,
  type Query,
  type SDKAssistantMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { PLUGIN_DIR } from "./constants.ts";

export function generateSessionId(): string {
  return `s-${Date.now().toString(36)}`;
}

export function buildSystemPromptAppend(handoffSummary?: string): string {
  const parts: string[] = [];

  parts.push(
    "You are running under the Choomfie daemon (Phase 3). " +
      "Your session will be automatically cycled when context gets heavy. " +
      "The daemon monitors worker health and will cycle this session " +
      "if the Discord worker becomes unresponsive.\n\n" +
      "If asked for a handoff summary, provide a concise summary of the current conversation state, " +
      "active tasks, important context, and any pending work.\n\n" +
      "The daemon manages session cycling. The existing 'restart' tool in Choomfie " +
      "still works for restarting just the Discord worker. A full session cycle (which also " +
      "restarts the worker) happens automatically when context thresholds are reached or " +
      "when the worker is detected as unhealthy."
  );

  if (handoffSummary) {
    parts.push(
      "\n\n--- HANDOFF CONTEXT FROM PREVIOUS SESSION ---\n" +
        handoffSummary +
        "\n--- END HANDOFF CONTEXT ---"
    );
  }

  return parts.join("");
}

export function extractAssistantText(msg: SDKAssistantMessage): string | null {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return null;

  const texts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  return texts.length > 0 ? texts.join("\n") : null;
}

/**
 * Returns true for errors that originate from Anthropic's API rather than the
 * transport — rate limits, payment failures, authentication errors, or service
 * overload. Generic network errors (ECONNRESET, timeout) are NOT Anthropic errors.
 */
export function isAnthropicError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("rate_limit") ||
    lower.includes("rate limit") ||
    lower.includes("overloaded") ||
    lower.includes("payment") ||
    lower.includes("billing") ||
    lower.includes("credit") ||
    lower.includes("quota exceeded") ||
    lower.includes("unauthorized") ||
    lower.includes("authentication_error") ||
    msg.includes("401") ||
    msg.includes("402") ||
    msg.includes("429") ||
    msg.includes("529")
  );
}

/**
 * Returns true for Anthropic errors that retrying cannot fix — bad credentials,
 * exhausted billing. Rate limits and overload (429/529) are excluded: those are
 * exactly what the retry backoff exists for.
 */
export function isUnrecoverableAnthropicError(error: unknown): boolean {
  if (!isAnthropicError(error)) return false;
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("payment") ||
    lower.includes("billing") ||
    lower.includes("credit") ||
    lower.includes("quota exceeded") ||
    lower.includes("unauthorized") ||
    lower.includes("authentication_error") ||
    msg.includes("401") ||
    msg.includes("402")
  );
}

export function createSession(
  prompt: AsyncGenerator<SDKUserMessage>,
  handoffSummary?: string
): Query {
  return query({
    prompt,
    options: {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      plugins: [{ type: "local", path: PLUGIN_DIR }],
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: buildSystemPromptAppend(handoffSummary),
      },
      persistSession: true,
      includePartialMessages: false,
      settingSources: ["user", "project"],
      cwd: PLUGIN_DIR,
    },
  });
}
