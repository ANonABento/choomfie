/**
 * Per-session bookkeeping shared by every daemon session: folding stream
 * messages into state (turns, tokens, cost, rate limits), the cycling
 * thresholds, the handoff summary, and the worker's health from its heartbeat.
 */

import { readFile } from "node:fs/promises";
import type {
  ModelUsage,
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKRateLimitEvent,
  SDKResultMessage,
  SDKResultSuccess,
} from "@anthropic-ai/claude-agent-sdk";
import { isHeartbeatStale, parseWorkerHeartbeat, workerHealthPath, type WorkerHeartbeat } from "@choomfie/shared";
import {
  CONTEXT_HARD_CEILING_MAX_FRACTION,
  CONTEXT_HARD_CEILING_RATIO,
  CYCLE_IDLE_DEBOUNCE_MS,
  DATA_DIR,
  HANDOFF_SUMMARY_TIMEOUT,
  HANDOFF_TURN_DRAIN_TIMEOUT,
} from "./constants.ts";
import { warnIfBundledCliStale } from "./cli-version.ts";
import { parseRateLimitInfo } from "./rate-limit.ts";
import { todayKey } from "./lifecycle.ts";
import { log, verbose } from "./log.ts";
import { getErrorMessage } from "./error.ts";
import { extractAssistantText } from "./session-core.ts";
import type { MetaState } from "./types.ts";

function isCompactBoundaryMessage(
  message: SDKMessage
): message is SDKCompactBoundaryMessage {
  return message.type === "system" && message.subtype === "compact_boundary";
}

/**
 * Fold one stream message into the session's state. `onChange` fires when
 * something the state file reports changed (rate limits, model, session id).
 */
export function handleSessionMessage(state: MetaState, message: SDKMessage, onChange: () => void = () => {}): void {
  // Anything the session emits means it is not idle. A result closes the turn
  // (error results too, or a failed turn would block cycling forever); output
  // from the model means one is open, even if the SDK merged queued prompts.
  state.lastActivityAt = Date.now();
  if (message.type === "result") state.turnInFlight = false;
  else if (message.type === "assistant") state.turnInFlight = true;

  switch (message.type) {
    case "result": {
      const result = message as SDKResultMessage;
      // One result closes one prompt, error or not, so count results.
      // `num_turns` is the model/tool round-trips inside that one prompt, not a
      // running total: assigning it left nearly every handoff at "1 turn" even
      // after 50+ calls, and the turn threshold never fired.
      state.turnCount++;

      // Session-cumulative, on error results too (an interrupted turn still
      // spent money), so assigned rather than accumulated.
      if (typeof result.total_cost_usd === "number") state.totalCostUsd = result.total_cost_usd;
      const inputTokens = resultInputTokens(state, result);
      if (result.modelUsage) state.modelUsage = result.modelUsage;

      state.totalInputTokens += inputTokens;
      // Daily counter survives session cycles (which reset totalInputTokens),
      // so roll it over on date change rather than rebuilding it per session.
      const today = todayKey();
      if (state.tokenUsageToday.date !== today) {
        state.tokenUsageToday = { date: today, inputTokens: 0 };
      }
      state.tokenUsageToday.inputTokens += inputTokens;

      log(
        `Turn ${state.turnCount}${result.subtype === "success" ? "" : ` (${result.subtype})`}: ` +
          `+${inputTokens} tokens, ${state.totalInputTokens} total, $${state.totalCostUsd.toFixed(4)}`
      );

      if (result.subtype === "success") {
        verbose(`Result text (first 200 chars): ${(result as SDKResultSuccess).result?.slice(0, 200)}`);
      } else {
        verbose(`Session error result: ${JSON.stringify(result)}`);
      }
      // Errors too: a waiter left hanging would be handed the *next* prompt's
      // result instead of its own.
      state.resultWaiters.shift()?.(result);
      break;
    }

    case "assistant": {
      const assistantMessage = message as SDKAssistantMessage;
      const text = extractAssistantText(assistantMessage);
      if (text) {
        state.lastAssistantText = text;
        verbose(`Assistant text (first 200 chars): ${text.slice(0, 200)}`);
      }
      break;
    }

    case "rate_limit_event": {
      const info = (message as SDKRateLimitEvent).rate_limit_info;
      // Raw dump at verbose: the payload carries fields the SDK's types don't
      // declare (`unifiedWindows`), and which of them are present varies, so
      // this is the only way to see what a given CLI build actually sends.
      verbose(`rate_limit_event: ${JSON.stringify(info)}`);

      // Account-level, not session-level: deliberately *not* reset by
      // a compact, so `/usage` still has an answer straight after one.
      const snapshot = parseRateLimitInfo(info);
      if (snapshot) {
        const previous = state.rateLimit?.status;
        state.rateLimit = snapshot;
        // Only log on a status change — this event fires on nearly every turn.
        if (snapshot.status !== previous) {
          const windows = Object.entries(snapshot.windows)
            .map(([name, w]) => `${name} ${(w.utilization * 100).toFixed(0)}%`)
            .join(", ");
          log(`Rate limit ${snapshot.status ?? "unknown"}: ${windows}`);
        }
        onChange();
      }
      break;
    }

    case "system": {
      if (isCompactBoundaryMessage(message)) {
        log("Context compaction occurred");
      } else if (message.subtype === "init") {
        // The SDK session id is what `/resume` brings back later.
        if (message.session_id && state.chat.sdkSessionId !== message.session_id) {
          state.chat.sdkSessionId = message.session_id;
          onChange();
        }
        // Sent at the start of every prompt, not once per session: only act
        // when it says something new.
        if (
          state.resolved.model === message.model &&
          state.resolved.claudeCodeVersion === message.claude_code_version
        ) {
          break;
        }
        const firstInit = state.resolved.claudeCodeVersion === null;
        state.resolved = {
          model: message.model,
          claudeCodeVersion: message.claude_code_version,
        };
        log(`Session model: ${message.model} (bundled Claude Code ${message.claude_code_version})`);
        if (firstInit) void warnIfBundledCliStale(message.claude_code_version);
        onChange();
      }
      break;
    }

    default:
      verbose(`Message type: ${message.type}`);
      break;
  }
}

function inputTokensOf(modelUsage: Record<string, ModelUsage> | undefined): number {
  let total = 0;
  for (const m of Object.values(modelUsage ?? {})) {
    total += (m.inputTokens ?? 0) + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0);
  }
  return total;
}

/**
 * Input tokens this result added, cache reads and writes included —
 * `input_tokens` alone is a couple of tokens per call once caching kicks in.
 *
 * Taken from the growth of `modelUsage` (session-cumulative, every model call:
 * subagents, compaction and helper calls too) when the result has it. `usage`
 * is per-prompt but main loop only, so it misses everything else; it is the
 * fallback. A shrinking total means the SDK reset its running count, and the
 * new total is then all new.
 */
export function resultInputTokens(state: MetaState, result: SDKResultMessage): number {
  if (result.modelUsage && Object.keys(result.modelUsage).length > 0) {
    const now = inputTokensOf(result.modelUsage);
    const before = inputTokensOf(state.modelUsage);
    return now >= before ? now - before : now;
  }
  const usage = result.usage;
  return (
    (usage?.input_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0)
  );
}

export function shouldCycle(state: MetaState, contextTokens?: number): boolean {
  if (state.state !== "ACTIVE") return false;
  if (state.turnCount >= state.thresholds.turnThreshold) return true;
  if (
    contextTokens !== undefined &&
    contextTokens >= state.thresholds.tokenThreshold
  )
    return true;
  return false;
}

/**
 * Past this, a cycle is forced even mid-task. Never below the soft threshold,
 * and kept under the model's real window when `getContextUsage` reported one.
 */
export function hardCeiling(state: MetaState): number {
  const { tokenThreshold } = state.thresholds;
  let ceiling = Math.round(tokenThreshold * CONTEXT_HARD_CEILING_RATIO);
  if (state.context.maxTokens) {
    ceiling = Math.min(
      ceiling,
      Math.floor(state.context.maxTokens * CONTEXT_HARD_CEILING_MAX_FRACTION)
    );
  }
  return Math.max(ceiling, tokenThreshold);
}

/**
 * Idle enough to compact without cutting anything off: no turn in flight and
 * quiet for the debounce period. Any prompt or stream message resets the clock.
 */
export function isIdleForCycle(state: MetaState, now = Date.now()): boolean {
  return state.state === "ACTIVE" && !state.turnInFlight && now - state.lastActivityAt >= CYCLE_IDLE_DEBOUNCE_MS;
}

/**
 * Wait (bounded) for the in-flight turn to finish. `waitForResult` takes the
 * *next* result, so asking for a summary while a turn is running hands back
 * that turn's result instead — which is how a handoff once read, in full,
 * "Reading the mockup and the gripper memory before I build the real
 * symmetric version."
 */
export async function waitForTurnToFinish(
  state: MetaState,
  timeoutMs: number,
  pollMs = 250
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (state.turnInFlight) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return true;
}

export async function captureHandoffSummary(
  state: MetaState,
  drainTimeoutMs = HANDOFF_TURN_DRAIN_TIMEOUT
): Promise<string> {
  if (!state.pushMessage || !state.session) {
    return "No summary available (no active session)";
  }

  if (state.turnInFlight) {
    log("Waiting for the in-flight turn to finish before requesting a summary...");
    if (!(await waitForTurnToFinish(state, drainTimeoutMs))) {
      log(`Turn still running after ${drainTimeoutMs}ms — requesting summary anyway`);
    }
  }
  if (!state.pushMessage) {
    return "No summary available (no active session)";
  }

  state.pushMessage({
    type: "user",
    message: {
      role: "user",
      content:
        "[DAEMON] Session cycling — generate a handoff summary. This will be injected into the next session's system prompt. Include:\n" +
        "1. Active persona name and key\n" +
        "2. Who you were talking to recently (Discord user IDs/names) and what about\n" +
        "3. Any active voice channels and who's in them\n" +
        "4. Ongoing conversations or tasks (what was the user asking for?)\n" +
        "5. Important things you learned this session (user preferences, facts to remember)\n" +
        "6. Any promises you made ('I'll remind you', 'I'll check on that')\n" +
        "Keep it under 500 words. Use structured format. Skip sections with nothing to report.\n" +
        "Do NOT use any tools — just output the summary text.",
    },
    parent_tool_use_id: null,
  });

  try {
    const result = await waitForResult(state, HANDOFF_SUMMARY_TIMEOUT);
    if (result.result && result.result.length > 0) {
      log(`Captured handoff summary (${result.result.length} chars)`);
      return result.result;
    }
    if (state.lastAssistantText) {
      log(`Using lastAssistantText as summary (${state.lastAssistantText.length} chars)`);
      return state.lastAssistantText;
    }
  } catch (error: unknown) {
    log(`Handoff summary capture failed: ${getErrorMessage(error)}`);
    if (state.lastAssistantText) {
      log("Falling back to last assistant text for summary");
      return state.lastAssistantText;
    }
  }

  return `Session cycled at ${state.turnCount} turns, ~${state.totalInputTokens} tokens, $${state.totalCostUsd.toFixed(4)}`;
}

export function waitForResult(
  state: MetaState,
  timeoutMs: number
): Promise<SDKResultSuccess> {
  return new Promise<SDKResultSuccess>((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = state.resultWaiters.indexOf(waiter);
      if (idx !== -1) state.resultWaiters.splice(idx, 1);
      reject(new Error(`Timed out waiting for result after ${timeoutMs}ms`));
    }, timeoutMs);

    const waiter = (result: SDKResultMessage) => {
      clearTimeout(timer);
      if (result.subtype === "success") resolve(result as SDKResultSuccess);
      else reject(new Error(`Turn ended with ${result.subtype}`));
    };

    state.resultWaiters.push(waiter);
  });
}

/**
 * Assess worker health from its heartbeat file, falling back to the process
 * check when no heartbeat exists yet.
 *
 * The process check alone only proves a process exists — a worker whose
 * gateway dropped or whose event loop is wedged passes it indefinitely. The
 * heartbeat distinguishes "running" from "working".
 */
export async function assessWorkerHealth(processAlive: boolean): Promise<{
  healthy: boolean;
  reason: string;
  /**
   * The worker is not doing its job, but respawning it cannot help — e.g. no
   * Discord token is configured. Same reasoning as isUnrecoverableAnthropicError:
   * don't burn restarts on a problem restarts don't solve.
   */
  cycleWontHelp?: boolean;
}> {
  let heartbeat: WorkerHeartbeat | null = null;
  try {
    heartbeat = parseWorkerHeartbeat(
      JSON.parse(await readFile(workerHealthPath(DATA_DIR), "utf-8"))
    );
  } catch {
    heartbeat = null;
  }

  // No heartbeat yet (worker still booting): fall back to the process check
  // so we never restart a worker that is simply starting up.
  if (!heartbeat) {
    return {
      healthy: processAlive,
      reason: processAlive ? "process alive (no heartbeat yet)" : "process not alive",
    };
  }

  if (isHeartbeatStale(heartbeat)) {
    const age = Math.round((Date.now() - heartbeat.updatedAt) / 1000);
    return { healthy: false, reason: `heartbeat stale (${age}s old)` };
  }

  if (!heartbeat.discordConfigured) {
    return {
      healthy: false,
      cycleWontHelp: true,
      reason: "no Discord token configured — run /choomfie:configure <token>",
    };
  }

  if (!heartbeat.discordReady) {
    return { healthy: false, reason: "Discord gateway not ready" };
  }

  const ping = heartbeat.wsPing === null ? "?" : `${heartbeat.wsPing}ms`;
  return { healthy: true, reason: `heartbeat fresh, gateway up (${ping})` };
}
