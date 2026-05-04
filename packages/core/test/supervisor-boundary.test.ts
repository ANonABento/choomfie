import { expect, test } from "bun:test";
import {
  waitForPendingToolCalls,
  type PendingToolCallMap,
} from "../lib/supervisor-boundary.ts";

test("planned worker restart waits for in-flight tool calls to drain", async () => {
  const pendingCalls: PendingToolCallMap = new Map();
  const timer = setTimeout(() => {}, 1_000);
  pendingCalls.set("1", {
    resolve: () => {},
    reject: () => {},
    timer,
  });

  setTimeout(() => {
    clearTimeout(timer);
    pendingCalls.delete("1");
  }, 30);

  const status = await waitForPendingToolCalls(pendingCalls, 250);

  expect(status).toBe("drained");
  expect(pendingCalls.size).toBe(0);
});

test("planned worker restart has a bounded drain timeout", async () => {
  const pendingCalls: PendingToolCallMap = new Map();
  const timer = setTimeout(() => {}, 1_000);
  pendingCalls.set("1", {
    resolve: () => {},
    reject: () => {},
    timer,
  });

  const status = await waitForPendingToolCalls(pendingCalls, 20);
  clearTimeout(timer);

  expect(status).toBe("timed_out");
  expect(pendingCalls.size).toBe(1);
});
