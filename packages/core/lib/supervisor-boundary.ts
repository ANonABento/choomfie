export type PendingToolCall = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type PendingToolCallMap = Map<string, PendingToolCall>;

export async function waitForPendingToolCalls(
  pendingCalls: PendingToolCallMap,
  timeoutMs: number,
): Promise<"drained" | "timed_out"> {
  if (pendingCalls.size === 0) return "drained";

  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      clearInterval(poll);
      resolve("timed_out");
    }, timeoutMs);

    const poll = setInterval(() => {
      if (pendingCalls.size === 0) {
        clearInterval(poll);
        clearTimeout(timeout);
        resolve("drained");
      }
    }, 25);
  });
}
