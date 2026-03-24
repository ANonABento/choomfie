/**
 * Ryuji — Personal AI agent powered by Claude Code CLI.
 *
 * Modes:
 *   npm run discord   — Discord bot
 *   npm run terminal  — Terminal REPL
 *   npm run dev       — Both (default)
 */

import { createDiscordBot } from "./discord/bot.js";
import { MemoryStore } from "./memory/store.js";

const memory = new MemoryStore();

// Start Discord bot if token is available
const discordToken = process.env.DISCORD_TOKEN;

if (discordToken) {
  const bot = createDiscordBot(memory);
  bot.login(discordToken);
  console.log("Starting Discord bot...");
} else {
  console.log("No DISCORD_TOKEN set — skipping Discord bot");
  console.log("Run `npm run terminal` for terminal mode");
}
