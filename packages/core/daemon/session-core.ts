import {
  query,
  type Query,
  type SDKAssistantMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { PLUGIN_DIR } from "./constants.ts";
import type { ModelSettings } from "./types.ts";

/**
 * Claude Code gates the experimental channel capability behind an explicit
 * opt-in list. `server:choomfie` names the MCP server the plugin registers —
 * keep it in sync with the server name in `.mcp.json`.
 */
const CHANNELS_FLAG = "dangerously-load-development-channels";
/** The MCP server name from .mcp.json. Keep both of these in sync with it. */
const CHANNEL_SERVER_NAME = "choomfie";
const CHANNEL_TARGET = `server:${CHANNEL_SERVER_NAME}`;

/**
 * Try to opt the Choomfie MCP server in to pushing inbound messages.
 *
 * Expected to fail, and no longer load-bearing — kept as a tripwire.
 *
 * The `--dangerously-load-development-channels` flag only makes the server
 * *eligible*: it puts it on the allowlist. Something still has to enable it,
 * and interactive Claude Code does that automatically on its MCP-connect path.
 * A session driven through the Agent SDK never runs that path, so the
 * capability was never registered and every `notifications/claude/channel` was
 * dropped — the worker booted, Discord went green, the typing indicator
 * started, and no message ever reached Claude.
 *
 * The one SDK-facing way in is `Query.enableChannel()`, and it refuses:
 *
 *   server choomfie is not plugin-sourced; channel_enable requires a
 *   marketplace plugin
 *
 * It resolves `config.pluginSource` to a `name@marketplace` pair before it will
 * consider anything else, and `SdkPluginConfig` only offers `{ type: 'local',
 * path }`. Unlike the automatic path, there is no `dev` bypass. Nothing on our
 * side can satisfy it.
 *
 * So daemon sessions get their messages another way: the worker writes each one
 * to `meta/incoming` and the daemon injects it directly (`daemon/incoming.ts`). This
 * call stays because the day it starts succeeding is worth knowing about, and
 * because silence is what made the original failure take a day to find. It is
 * safe to leave failing — the worker sends no notification for a registered
 * capability to receive, so nothing double-delivers if it ever works.
 *
 * `enableChannel` is real on the Query object but absent from the SDK's `.d.ts`
 * (`SDKControlChannelEnableRequest` is referenced in the control-request union
 * and never declared), hence the cast and the runtime check.
 */
export async function enableChannelNotifications(session: Query): Promise<void> {
  const enable = (
    session as unknown as { enableChannel?: (serverName: string) => Promise<void> }
  ).enableChannel;
  if (typeof enable !== "function") {
    throw new Error(
      "this Agent SDK build has no Query.enableChannel() — Discord messages cannot be delivered",
    );
  }
  await enable.call(session, CHANNEL_SERVER_NAME);
}

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
  handoffSummary?: string,
  models: ModelSettings = {}
): Query {
  return query({
    prompt,
    options: {
      // Omitted rather than passed as undefined: the SDK treats an absent
      // `model` as "use Claude Code's configured default", which is the
      // behaviour daemon sessions had before this was configurable.
      ...(models.model ? { model: models.model } : {}),
      ...(models.fallbackModel ? { fallbackModel: models.fallbackModel } : {}),
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      plugins: [{ type: "local", path: PLUGIN_DIR }],
      // Puts the server on the session's channel allowlist. Foreground mode
      // needs this — without it Claude Code skips registration with "server
      // choomfie not in --channels list for this session" and every Discord
      // message is dropped. Here it is necessary but not sufficient (see
      // `enableChannelNotifications` above), and kept so both launch paths
      // stay identical in what they ask for.
      extraArgs: { [CHANNELS_FLAG]: CHANNEL_TARGET },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: buildSystemPromptAppend(handoffSummary),
      },
      persistSession: true,
      includePartialMessages: false,
      settingSources: ["user", "project"],
      cwd: PLUGIN_DIR,
      // Marks the supervisor spawned beneath this session as daemon-owned, so
      // its single-instance guard doesn't refuse to start. A supervisor
      // launched any other way while this daemon is alive will refuse.
      env: {
        ...process.env,
        CHOOMFIE_DAEMON_PID: String(process.pid),
      },
    },
  });
}
