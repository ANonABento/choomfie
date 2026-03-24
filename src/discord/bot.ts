/**
 * Discord bot — routes messages to the core agent.
 */

import { Client, Events, GatewayIntentBits, Message } from "discord.js";
import { runAgent } from "../core/agent.js";
import { MemoryStore } from "../memory/store.js";

const BOT_PREFIX = "!ryuji";

export function createDiscordBot(memory: MemoryStore) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`Discord: logged in as ${c.user.tag}`);
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith(BOT_PREFIX)) return;

    const userMessage = message.content.slice(BOT_PREFIX.length).trim();
    if (!userMessage) return;

    const sessionId = `discord-${message.author.id}`;
    const memoryContext = memory.buildMemoryContext();

    try {
      await message.channel.sendTyping();

      const response = await runAgent(userMessage, {
        sessionId,
        systemPrompt: [
          "You are Ryuji, a personal AI assistant.",
          "Be concise and helpful. Use casual tone.",
          memoryContext,
        ]
          .filter(Boolean)
          .join("\n\n"),
      });

      // Discord has a 2000 char limit
      const chunks = splitMessage(response.content);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } catch (error) {
      console.error("Agent error:", error);
      await message.reply("Something went wrong. Check the logs.");
    }
  });

  return client;
}

function splitMessage(text: string, maxLength = 2000): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex === -1) splitIndex = maxLength;

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}
