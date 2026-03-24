/**
 * Terminal REPL — interactive chat in the terminal.
 */

import { createInterface } from "readline";
import { runAgent } from "../core/agent.js";
import { MemoryStore } from "../memory/store.js";

const memory = new MemoryStore();

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "ryuji> ",
});

console.log("Ryuji Terminal — type your message, Ctrl+C to exit\n");
rl.prompt();

rl.on("line", async (line) => {
  const input = line.trim();
  if (!input) {
    rl.prompt();
    return;
  }

  // Built-in commands
  if (input === "/memory") {
    const core = memory.getCoreMemory();
    if (core.length === 0) {
      console.log("(no core memories)\n");
    } else {
      core.forEach((m) => console.log(`  ${m.key}: ${m.value}`));
      console.log();
    }
    rl.prompt();
    return;
  }

  if (input.startsWith("/remember ")) {
    const [key, ...rest] = input.slice(10).split("=");
    if (key && rest.length > 0) {
      memory.setCoreMemory(key.trim(), rest.join("=").trim());
      console.log(`Remembered: ${key.trim()}\n`);
    } else {
      console.log("Usage: /remember key=value\n");
    }
    rl.prompt();
    return;
  }

  try {
    const memoryContext = memory.buildMemoryContext();

    const response = await runAgent(input, {
      sessionId: "terminal",
      systemPrompt: [
        "You are Ryuji, a personal AI assistant.",
        "Be concise and helpful.",
        memoryContext,
      ]
        .filter(Boolean)
        .join("\n\n"),
    });

    console.log(`\n${response.content}\n`);
  } catch (error) {
    console.error("Error:", error);
  }

  rl.prompt();
});

rl.on("close", () => {
  memory.close();
  process.exit(0);
});
