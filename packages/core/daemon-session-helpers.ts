import type {
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKResultMessage,
  SDKResultSuccess,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { MetaState } from "./daemon-types.ts";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createMessageGenerator(): {
  generator: AsyncGenerator<SDKUserMessage>;
  push: (msg: SDKUserMessage) => void;
  close: () => void;
} {
  const queue: SDKUserMessage[] = [];
  let resolve: (() => void) | null = null;
  let closed = false;

  async function* gen(): AsyncGenerator<SDKUserMessage> {
    while (!closed) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else {
        await new Promise<void>((resume) => {
          resolve = resume;
        });
        resolve = null;
      }
    }
  }

  return {
    generator: gen(),
    push(msg: SDKUserMessage) {
      queue.push(msg);
      resolve?.();
    },
    close() {
      closed = true;
      resolve?.();
    },
  };
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
      "when the worker is detected as unhealthy.",
  );

  if (handoffSummary) {
    parts.push(
      "\n\n--- HANDOFF CONTEXT FROM PREVIOUS SESSION ---\n" +
        handoffSummary +
        "\n--- END HANDOFF CONTEXT ---",
    );
  }

  return parts.join("");
}

function addInputTokens(state: MetaState, inputTokens: number): void {
  const today = new Date().toISOString().slice(0, 10);
  if (state.tokenUsageToday.date !== today) {
    state.tokenUsageToday = { date: today, inputTokens: 0 };
  }

  state.tokenUsageToday.inputTokens += inputTokens;
}

function extractAssistantText(msg: SDKAssistantMessage): string | null {
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

function isCompactBoundaryMessage(
  message: SDKMessage
): message is SDKCompactBoundaryMessage {
  return message.type === "system" && message.subtype === "compact_boundary";
}

export function handleSessionMessage(
  state: MetaState,
  message: SDKMessage,
  opts: {
    log: (msg: string) => void;
    verbose: (msg: string) => void;
  },
): void {
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
          addInputTokens(state, inputTokens);
        }

        opts.log(
          `Turn ${state.turnCount}: +${usage?.input_tokens ?? 0} tokens, ` +
            `${state.totalInputTokens} total, $${state.totalCostUsd.toFixed(4)}`,
        );

        opts.verbose(`Result text (first 200 chars): ${successResult.result?.slice(0, 200)}`);

        if (state.resultWaiters.length > 0) {
          const waiter = state.resultWaiters.shift()!;
          waiter(successResult);
        }
      } else {
        opts.log(`Session error result: ${JSON.stringify(result)}`);
      }
      break;
    }

    case "assistant": {
      const assistantMsg = message as SDKAssistantMessage;
      const text = extractAssistantText(assistantMsg);
      if (text) {
        state.lastAssistantText = text;
        opts.verbose(`Assistant text (first 200 chars): ${text.slice(0, 200)}`);
      }
      break;
    }

    case "system": {
      if (isCompactBoundaryMessage(message)) {
        opts.log("Context compaction occurred");
      }
      break;
    }

    default:
      opts.verbose(`Message type: ${message.type}`);
      break;
  }
}

export function waitForResult(state: MetaState, timeoutMs: number): Promise<SDKResultSuccess> {
  return new Promise<SDKResultSuccess>((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = state.resultWaiters.indexOf(waiterFn);
      if (idx !== -1) state.resultWaiters.splice(idx, 1);
      reject(new Error(`Timed out waiting for result after ${timeoutMs}ms`));
    }, timeoutMs);

    const waiterFn = (result: SDKResultSuccess) => {
      clearTimeout(timer);
      resolve(result);
    };

    state.resultWaiters.push(waiterFn);
  });
}

export async function captureHandoffSummary(
  state: MetaState,
  opts: {
    handoffSummaryTimeout: number;
    log: (msg: string) => void;
  },
): Promise<string> {
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
    const result = await waitForResult(state, opts.handoffSummaryTimeout);
    if (result.result && result.result.length > 0) {
      opts.log(`Captured handoff summary (${result.result.length} chars)`);
      return result.result;
    }
    if (state.lastAssistantText) {
      opts.log(`Using lastAssistantText as summary (${state.lastAssistantText.length} chars)`);
      return state.lastAssistantText;
    }
  } catch (error: unknown) {
    opts.log(`Handoff summary capture failed: ${getErrorMessage(error)}`);
    if (state.lastAssistantText) {
      opts.log("Falling back to last assistant text for summary");
      return state.lastAssistantText;
    }
  }

  return `Session cycled at ${state.turnCount} turns, ~${state.totalInputTokens} tokens, $${state.totalCostUsd.toFixed(4)}`;
}
