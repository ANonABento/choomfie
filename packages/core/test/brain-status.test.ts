import { afterEach, expect, test } from "bun:test";
import { registerBrain, unregisterBrain, type Brain } from "@choomfie/shared";
import { brainStatus } from "../lib/handlers/brain-command.ts";

const brain = (status: Brain["status"]): Brain => ({ id: "probe", label: "Probe", send: async () => ({ text: "" }), status });

afterEach(() => unregisterBrain("probe"));

test("/brain shows a brain's own status lines, after a blank line", async () => {
  registerBrain(brain(async () => ["• Groq — ready"]));
  expect(await brainStatus("probe")).toEqual(["", "• Groq — ready"]);
});

test("no status, claude, or an unknown brain: nothing", async () => {
  registerBrain(brain(undefined));
  expect(await brainStatus("probe")).toEqual([]);
  expect(await brainStatus("claude")).toEqual([]);
  expect(await brainStatus("nope")).toEqual([]);
});

test("a slow or failing status never holds up the reply", async () => {
  registerBrain(brain(() => new Promise(() => {})));
  expect(await brainStatus("probe", 20)).toEqual([]);
  unregisterBrain("probe");
  registerBrain(brain(async () => Promise.reject(new Error("boom"))));
  expect((await brainStatus("probe")).join("")).toContain("status unavailable: boom");
});
