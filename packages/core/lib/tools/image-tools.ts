/**
 * Image generation tools.
 */

import type { TextChannel, ThreadChannel } from "discord.js";
import type { ToolDef } from "../types.ts";
import { err, text } from "../types.ts";
import { formatGeneratedImageMessage, generateImage } from "../image-generation.ts";
import { refreshChannel } from "../conversation.ts";
import { onReplySent } from "../typing.ts";

export const imageTools: ToolDef[] = [
  {
    definition: {
      name: "imagine",
      description:
        "Generate an image from a prompt, save it to the inbox directory, and optionally attach it to a Discord channel.",
      inputSchema: {
        type: "object" as const,
        properties: {
          prompt: {
            type: "string",
            description: "Image prompt to generate.",
          },
          chat_id: {
            type: "string",
            description: "Discord channel ID to attach the generated image to.",
          },
          text: {
            type: "string",
            description: "Optional message text to send with the attachment.",
          },
        },
        required: ["prompt"],
      },
    },
    handler: async (args, ctx) => {
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt) return err("Prompt is required.");

      const image = await generateImage(prompt, ctx.DATA_DIR);

      if (args.chat_id && typeof args.chat_id === "string") {
        const channel = await ctx.discord.channels.fetch(args.chat_id);
        if (!channel?.isTextBased()) {
          return err(`Generated ${image.filePath}, but channel was not found or not text-based.`);
        }

        const textChannel = channel as TextChannel | ThreadChannel;
        const baseMessage = (typeof args.text === "string" && args.text.trim())
          ? args.text.trim()
          : `Image: ${prompt}`;
        const sent = await textChannel.send({
          content: formatGeneratedImageMessage(image, baseMessage),
          files: [{ attachment: image.filePath }],
          allowedMentions: { parse: [] },
        });
        ctx.messageStats.sent++;
        refreshChannel(ctx.activeChannels, args.chat_id);
        onReplySent(args.chat_id);

        return text(`generated and sent (id: ${sent.id}, file: ${image.filePath}, provider: ${image.provider})`);
      }

      return text(`generated image: ${image.filePath} (provider: ${image.provider})`);
    },
  },
];
