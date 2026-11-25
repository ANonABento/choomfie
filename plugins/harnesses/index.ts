/**
 * Harnesses plugin — coding-agent CLIs installed on this machine as brains:
 * `/brain antigravity`. Each is found on PATH at init; one that isn't
 * installed is skipped. No tools, no instructions: costs the Claude session
 * nothing. Built on @choomfie/harness.
 */

import { createHarnessBrain, spawnCli } from "@choomfie/harness";
import { registerBrain, unregisterBrain, type Plugin } from "@choomfie/shared";
import { HARNESSES } from "./harnesses/index.ts";

export { HARNESSES };

let registered: string[] = [];

async function listModels(binPath: string, spec: (typeof HARNESSES)[number]): Promise<string[]> {
  if (!spec.listModels) return [];
  const abort = new AbortController();
  const out = await spawnCli([binPath, ...spec.listModels.args], { cwd: process.cwd(), signal: abort.signal, timeoutMs: 20_000 }).catch(() => null);
  return out && out.code === 0 ? spec.listModels.parse(out.stdout) : [];
}

const plugin: Plugin = {
  name: "harnesses",
  async init(ctx) {
    for (const spec of HARNESSES) {
      const binPath = Bun.which(spec.bin);
      if (!binPath) {
        console.error(`[harnesses] ${spec.label}: \`${spec.bin}\` not installed — skipped`);
        continue;
      }
      const models = await listModels(binPath, spec);
      registerBrain(createHarnessBrain(spec, ctx, { binPath, models }));
      registered.push(spec.id);
    }
    console.error(`Harnesses initialized — ${registered.length ? registered.join(", ") : "none installed"}`);
  },
  async destroy() {
    for (const id of registered) unregisterBrain(id);
    registered = [];
  },
};

export default plugin;
