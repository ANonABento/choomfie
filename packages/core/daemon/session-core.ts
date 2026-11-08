/**
 * Starting one Agent SDK session, and the error classification its retry
 * loop relies on.
 */

import {
  query,
  type Query,
  type SDKAssistantMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ModelSettings } from "./types.ts";

export function buildSystemPromptAppend(handoffSummary?: string): string {
  const parts = [
    "You are running under the Choomfie daemon, one session per Discord thread, channel or DM. " +
      "When context gets heavy the daemon asks you for a handoff summary and carries on in a fresh " +
      "session that starts with it. Choomfie's `restart` tool restarts only the Discord worker; " +
      "this session is unaffected. " +
      // Measured: a recap after every reply was ~14% of a chat's output tokens.
      "Nobody reads your text outside tool calls — Discord only sees what you send with `reply`. " +
      "Once you've replied, end the turn without writing anything else (no recap of what you sent).",
  ];
  if (handoffSummary) {
    parts.push(
      "\n\n--- HANDOFF CONTEXT FROM PREVIOUS SESSION ---\n" + handoffSummary + "\n--- END HANDOFF CONTEXT ---"
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

/** Where the session runs, what it continues, and where its tools are. */
export type SessionPlacement = {
  cwd: string;
  /** SDK session id to load (Claude Code's `--resume`). Must have been created in `cwd`. */
  resume?: string;
  /** The daemon's loopback endpoint serving every Choomfie tool. */
  mcp: { url: string; token: string };
};

export function createSession(
  prompt: AsyncGenerator<SDKUserMessage>,
  handoffSummary: string | undefined,
  models: ModelSettings,
  placement: SessionPlacement
): Query {
  return query({
    prompt,
    options: {
      // The SDK finds a session's transcript by the directory it ran in, so a
      // resume has to come back with the cwd it was created under.
      ...(placement.resume ? { resume: placement.resume } : {}),
      // Omitted rather than passed as undefined: the SDK treats an absent
      // `model` as "use Claude Code's configured default".
      ...(models.model ? { model: models.model } : {}),
      ...(models.fallbackModel ? { fallbackModel: models.fallbackModel } : {}),
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // Tools over HTTP from the daemon, not the plugin: loading the plugin
      // would start a supervisor and a second Discord worker per session.
      // Inbound messages are pushed by the daemon, so no channel capability.
      mcpServers: {
        choomfie: {
          type: "http",
          url: placement.mcp.url,
          headers: { Authorization: `Bearer ${placement.mcp.token}` },
        },
      },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: buildSystemPromptAppend(handoffSummary),
      },
      persistSession: true,
      includePartialMessages: false,
      // Project only: the owner's own Claude Code setup (skills, plugins,
      // global CLAUDE.md) is theirs, not the bot's, and every session paid for
      // it. A chat started in a project (`/clear cwd:`) loads that project's
      // CLAUDE.md and settings; the default chat home has none.
      settingSources: ["project"],
      cwd: placement.cwd,
      env: {
        ...process.env,
        // claude.ai connectors (Notion, Drive, Docs, ...) put their server
        // instructions and tool names into every session's context. The
        // persona never uses them, and that context is re-read on every turn.
        // bin/choomfie sets the same default for foreground sessions.
        ENABLE_CLAUDEAI_MCP_SERVERS: process.env.ENABLE_CLAUDEAI_MCP_SERVERS ?? "false",
      },
    },
  });
}
