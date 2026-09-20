import { readFile } from "node:fs/promises";
import type {
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKResultMessage,
  SDKResultSuccess,
} from "@anthropic-ai/claude-agent-sdk";
import {
  CONTEXT_CHECK_FAILURE_LIMIT,
  CONTEXT_CHECK_INTERVAL,
  DATA_DIR,
  HANDOFF_SUMMARY_TIMEOUT,
  INITIAL_RESTART_BACKOFF,
  MAX_ERROR_RETRIES,
  MAX_RESTART_BACKOFF,
  WORKER_HEALTH_INTERVAL,
  WORKER_MAX_CONSECUTIVE_FAILURES,
} from "./constants.ts";
import {
  isHeartbeatStale,
  parseWorkerHeartbeat,
  readLiveChoomfiePid,
  workerHealthPath,
  type WorkerHeartbeat,
} from "@choomfie/shared";
import { loadHandoffs, getLastHandoffSummary, saveHandoff } from "./handoffs.ts";
import { cleanup, todayKey } from "./lifecycle.ts";
import { log, setSessionId, verbose } from "./log.ts";
import { createMessageGenerator } from "./message-generator.ts";
import { getErrorMessage } from "./error.ts";
import {
  createSession,
  extractAssistantText,
  generateSessionId,
  isUnrecoverableAnthropicError,
} from "./session-core.ts";
import { writeDaemonState } from "./state-file.ts";
import type { HandoffEntry, MetaState } from "./types.ts";

function isCompactBoundaryMessage(
  message: SDKMessage
): message is SDKCompactBoundaryMessage {
  return message.type === "system" && message.subtype === "compact_boundary";
}

export async function startSession(
  state: MetaState,
  handoffSummary?: string
): Promise<void> {
  state.state = "STARTING";
  state.turnCount = 0;
  state.totalInputTokens = 0;
  state.totalCostUsd = 0;
  state.sessionStartTime = Date.now();
  state.contextCheckFailures = 0;
  state.lastAssistantText = null;
  state.resultWaiters = [];

  const sessionId = generateSessionId();
  state.sessionId = sessionId;
  setSessionId(sessionId);

  log("Starting new Claude Code session...");

  const { generator, push, close } = createMessageGenerator();
  state.pushMessage = push;
  state.closeGenerator = close;

  state.session = createSession(generator, handoffSummary);

  void consumeSessionStream(state).catch((error: unknown) => {
    log(`Session stream error: ${getErrorMessage(error)}`);
    void handleStreamError(state, error);
  });

  await new Promise((resolve) => setTimeout(resolve, 3000));

  state.state = "ACTIVE";
  log("Session active");

  void writeDaemonState(state);
  startContextMonitor(state);
  startWorkerHealthMonitor(state);

  if (state.messageQueue.length > 0) {
    log(`Replaying ${state.messageQueue.length} queued messages`);
    for (const msg of state.messageQueue) {
      push(msg);
    }
    state.messageQueue = [];
  }

  state.restartBackoff = INITIAL_RESTART_BACKOFF;

  if (handoffSummary && state.totalCycles > 0) {
    log("Notifying Discord of session cycle...");
    push({
      type: "user",
      message: {
        role: "user",
        content:
          "Your daemon session was just cycled (fresh context). " +
          "Send a brief message to the most recently active Discord channel " +
          "letting them know you're back online. Keep it casual and short — " +
          "something like 'Back online, fresh brain. What were we doing?' " +
          "If no channel was active, skip this.",
      },
      parent_tool_use_id: null,
    });
  }
}

async function consumeSessionStream(state: MetaState): Promise<void> {
  if (!state.session) return;

  try {
    for await (const message of state.session) {
      handleSessionMessage(state, message);
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      log("Session aborted");
    } else {
      throw error;
    }
  }

  log("Session stream closed");
}

export async function handleStreamError(
  state: MetaState,
  initialError: unknown
): Promise<void> {
  if (state.state === "CYCLING" || state.state === "DRAINING") {
    verbose("Stream error during cycling/draining — ignoring");
    return;
  }

  let error = initialError;
  for (let attempt = 1; attempt <= MAX_ERROR_RETRIES; attempt++) {
    const unrecoverable = isUnrecoverableAnthropicError(error);

    log(
      `Session stream failed: ${getErrorMessage(error)}` +
        (unrecoverable ? "" : ` (attempt ${attempt}/${MAX_ERROR_RETRIES})`)
    );

    stopWorkerHealthMonitor(state);
    try {
      state.closeGenerator?.();
      state.session?.close();
    } catch {
      // Best-effort cleanup.
    }
    state.session = null;
    state.pushMessage = null;
    state.closeGenerator = null;
    state.resultWaiters = [];

    // Bad credentials or exhausted billing will not fix themselves — retrying
    // just burns MAX_ERROR_RETRIES rounds of backoff before failing anyway.
    if (unrecoverable) {
      log(
        "Not retrying: this is an authentication or billing error. " +
          "Re-authenticate Claude Code (`claude` login) or check your plan status, " +
          "then restart the daemon."
      );
      return;
    }

    const delay = state.restartBackoff;
    state.restartBackoff = Math.min(state.restartBackoff * 2, MAX_RESTART_BACKOFF);

    log(`Restarting session in ${delay}ms...`);
    await new Promise((resolve) => setTimeout(resolve, delay));

    const handoffs = await loadHandoffs();
    const lastSummary = getLastHandoffSummary(handoffs);

    try {
      await startSession(state, lastSummary);
      log("Session restarted successfully after error");
      return;
    } catch (restartError: unknown) {
      error = restartError;
    }
  }

  log(`FATAL: Failed to restart session after ${MAX_ERROR_RETRIES} attempts. Exiting.`);
  await cleanup(state);
  process.exit(1);
}

export function handleSessionMessage(state: MetaState, message: SDKMessage): void {
  switch (message.type) {
    case "result": {
      const result = message as SDKResultMessage;
      if (result.subtype === "success") {
        const successResult = result as SDKResultSuccess;
        state.turnCount = successResult.num_turns;
        state.totalCostUsd = successResult.total_cost_usd;

        const usage = successResult.usage;
        if (usage) {
          const inputTokens = usage.input_tokens ?? 0;
          state.totalInputTokens += inputTokens;

          // Daily counter survives session cycles (which reset
          // totalInputTokens), so roll it over on date change rather than
          // rebuilding it per session.
          const today = todayKey();
          if (state.tokenUsageToday.date !== today) {
            state.tokenUsageToday = { date: today, inputTokens: 0 };
          }
          state.tokenUsageToday.inputTokens += inputTokens;
        }

        log(
          `Turn ${state.turnCount}: +${usage?.input_tokens ?? 0} tokens, ` +
            `${state.totalInputTokens} total, $${state.totalCostUsd.toFixed(4)}`
        );

        verbose(`Result text (first 200 chars): ${successResult.result?.slice(0, 200)}`);

        if (state.resultWaiters.length > 0) {
          const waiter = state.resultWaiters.shift()!;
          waiter(successResult);
        }
      } else {
        log(`Session error result: ${JSON.stringify(result)}`);
      }
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

    case "system": {
      if (isCompactBoundaryMessage(message)) {
        log("Context compaction occurred");
      }
      break;
    }

    default:
      verbose(`Message type: ${message.type}`);
      break;
  }
}

export function startContextMonitor(state: MetaState): void {
  if (state.contextCheckTimer) {
    clearInterval(state.contextCheckTimer);
  }

  state.contextCheckTimer = setInterval(async () => {
    if (state.state !== "ACTIVE" || !state.session) return;

    try {
      const usage = await state.session.getContextUsage();
      const tokens = usage.totalTokens;
      const pct = usage.percentage;

      state.contextCheckFailures = 0;

      log(
        `Context: ${tokens}/${usage.maxTokens} tokens (${pct.toFixed(1)}%), ` +
          `${state.turnCount}/${state.thresholds.turnThreshold} turns, ` +
          `$${state.totalCostUsd.toFixed(4)}`
      );

      void writeDaemonState(state);

      if (shouldCycle(state, tokens)) {
        state.lastCycleReason =
          state.turnCount >= state.thresholds.turnThreshold
            ? "turn_threshold"
            : "token_threshold";
        log("Threshold reached — initiating session cycle");
        await cycleSession(state, tokens);
      }
    } catch (error: unknown) {
      state.contextCheckFailures++;
      log(
        `Context check failed (${state.contextCheckFailures}/${CONTEXT_CHECK_FAILURE_LIMIT}): ${getErrorMessage(error)}`
      );

      if (state.contextCheckFailures >= CONTEXT_CHECK_FAILURE_LIMIT) {
        log("Context checks failing repeatedly — falling back to turn-count cycling");
        if (shouldCycle(state)) {
          state.lastCycleReason = "turn_threshold_fallback";
          log("Turn threshold reached (fallback) — initiating session cycle");
          await cycleSession(state);
        }
      }
    }
  }, CONTEXT_CHECK_INTERVAL);
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

export async function captureHandoffSummary(state: MetaState): Promise<string> {
  if (!state.pushMessage || !state.session) {
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

    const waiter = (result: SDKResultSuccess) => {
      clearTimeout(timer);
      resolve(result);
    };

    state.resultWaiters.push(waiter);
  });
}

export async function cycleSession(
  state: MetaState,
  tokenCount?: number
): Promise<void> {
  if (state.state !== "ACTIVE") {
    log("Cannot cycle: not in ACTIVE state");
    return;
  }

  state.state = "DRAINING";
  state.totalCycles++;
  log(`Draining session... (cycle #${state.totalCycles}, reason: ${state.lastCycleReason || "threshold"})`);

  stopWorkerHealthMonitor(state);
  if (state.contextCheckTimer) {
    clearInterval(state.contextCheckTimer);
    state.contextCheckTimer = null;
  }

  const summary = await captureHandoffSummary(state);

  const handoff: HandoffEntry = {
    sessionId: state.sessionId,
    timestamp: new Date().toISOString(),
    summary,
    tokenCount: tokenCount ?? state.totalInputTokens,
    turnCount: state.turnCount,
    costUsd: state.totalCostUsd,
  };
  await saveHandoff(handoff);

  state.state = "CYCLING";
  log("Cycling session...");

  try {
    state.closeGenerator?.();
    state.session?.close();
  } catch (error: unknown) {
    log(`Error closing session: ${getErrorMessage(error)}`);
  }

  state.session = null;
  state.pushMessage = null;
  state.closeGenerator = null;
  state.resultWaiters = [];

  await new Promise((resolve) => setTimeout(resolve, 2000));
  await startSession(state, summary);
}

export async function checkWorkerProcessAlive(): Promise<boolean> {
  const supervisorPidPath = `${DATA_DIR}/choomfie.pid`;
  return (await readLiveChoomfiePid(supervisorPidPath)) !== null;
}

/**
 * Assess worker health from its heartbeat file, falling back to the process
 * check when no heartbeat exists yet.
 *
 * The process check alone only proves a process exists — a worker whose
 * gateway dropped or whose event loop is wedged passes it indefinitely. The
 * heartbeat distinguishes "running" from "working".
 */
export async function assessWorkerHealth(): Promise<{
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

  // No heartbeat yet (worker still booting, or an older build): fall back to
  // the process check so we never cycle a worker that is simply starting up.
  if (!heartbeat) {
    const alive = await checkWorkerProcessAlive();
    return {
      healthy: alive,
      reason: alive ? "process alive (no heartbeat yet)" : "process not alive",
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

export async function checkWorkerHealth(state: MetaState): Promise<void> {
  if (state.state !== "ACTIVE" || !state.pushMessage) {
    verbose("Skipping worker health check — session not active");
    return;
  }

  const { healthy, reason, cycleWontHelp } = await assessWorkerHealth();
  state.workerHealth.processAlive = healthy;

  if (!healthy && cycleWontHelp) {
    // Degraded, but respawning would just loop forever. Report it and hold.
    state.workerHealth.consecutiveFailures = 0;
    log(`Worker health: DEGRADED — ${reason} (not cycling; a restart cannot fix this)`);
    return;
  }

  if (!healthy) {
    state.workerHealth.consecutiveFailures++;
    log(
      `Worker health: UNHEALTHY — ${reason} ` +
        `(failure ${state.workerHealth.consecutiveFailures}/${WORKER_MAX_CONSECUTIVE_FAILURES})`
    );

    if (
      state.workerHealth.consecutiveFailures >= WORKER_MAX_CONSECUTIVE_FAILURES &&
      state.state === "ACTIVE"
    ) {
      log(`Worker unhealthy (${reason}) — triggering session cycle to respawn`);
      state.lastCycleReason = "worker_unhealthy";
      stopWorkerHealthMonitor(state);
      await cycleSession(state);
    }
    return;
  }

  state.workerHealth.consecutiveFailures = 0;
  state.workerHealth.lastHealthyAt = Date.now();

  verbose(`Worker health: ${reason}`);
}

export function startWorkerHealthMonitor(state: MetaState): void {
  if (state.workerHealthTimer) {
    clearInterval(state.workerHealthTimer);
  }

  setTimeout(() => {
    void checkWorkerHealth(state);
  }, 15_000);

  state.workerHealthTimer = setInterval(async () => {
    try {
      await checkWorkerHealth(state);
    } catch (error: unknown) {
      log(`Worker health check error: ${getErrorMessage(error)}`);
    }
  }, WORKER_HEALTH_INTERVAL);
}

export function stopWorkerHealthMonitor(state: MetaState): void {
  if (state.workerHealthTimer) {
    clearInterval(state.workerHealthTimer);
    state.workerHealthTimer = null;
  }
}
