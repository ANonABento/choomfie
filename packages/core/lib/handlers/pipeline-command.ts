/**
 * `/pipeline [name]`: put this thread on a configured pipeline (lochara, …),
 * or take it off (`off`), or see which it's on (no name). On, whichever brain
 * answers here is told once what the thread is for (lib/pipelines/thread-mode.ts),
 * and `next` runs straight away: the thread opens on a step card (where things
 * stand, a button per choice).
 * Owner only.
 */

import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { AUTOCOMPLETE_LIMIT } from "@choomfie/shared";
import { registerCommand } from "../register.ts";
import { requireOwner } from "./shared.ts";
import { startCardJob } from "../pipelines/index.ts";
import type { AppContext } from "../types.ts";

/** The first command a thread runs when it's put on a pipeline: its end posts the first step card. */
const START = ["next"];

async function ephemeral(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

/** Run the pipeline's first step for this thread. A line on why it couldn't, or nothing. */
function start(ctx: AppContext, name: string, chatId: string): string {
  const p = ctx.config.getPipelines().get(name)!;
  if (!p.allow.includes(START[0])) return "";
  try {
    startCardJob(ctx, name, chatId, START);
    return "";
  } catch (e) {
    return `\`${START.join(" ")}\` failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

registerCommand("pipeline", {
  data: {
    ...new SlashCommandBuilder()
      .setName("pipeline")
      .setDescription("Put this thread on a local pipeline (e.g. lochara), or `off` (owner only)")
      .addStringOption((o) => o.setName("name").setDescription("A configured pipeline, or `off`; omit to see").setAutocomplete(true))
      .toJSON(),
  },
  autocomplete: async (interaction, ctx) => {
    const typed = interaction.options.getFocused().toLowerCase();
    await interaction.respond(
      [...ctx.config.getPipelines().keys(), "off"]
        .filter((n) => n.includes(typed))
        .slice(0, AUTOCOMPLETE_LIMIT)
        .map((n) => ({ name: n, value: n }))
    );
  },
  handler: async (interaction, ctx) => {
    if (await requireOwner(interaction, ctx)) return;
    const location = interaction.channelId;
    const names = [...ctx.config.getPipelines().keys()];
    const requested = interaction.options.getString("name")?.trim().toLowerCase();
    const current = ctx.chats.pipelineAt(location)?.pipeline;
    if (!requested) {
      return ephemeral(
        interaction,
        `${current ? `This thread is on **${current}**.` : "This thread isn't on a pipeline."} ` +
          `Configured: ${names.map((n) => `\`${n}\``).join(", ") || "none (config.json `pipelines`)"}.`
      );
    }
    if (requested === "off") {
      ctx.chats.setPipeline(location, null);
      return ephemeral(interaction, current ? `This thread is off **${current}**.` : "This thread wasn't on a pipeline.");
    }
    if (!names.includes(requested)) {
      return ephemeral(interaction, `No pipeline \`${requested}\`. Configured: ${names.map((n) => `\`${n}\``).join(", ") || "none"}.`);
    }
    ctx.chats.setPipeline(location, requested);
    await interaction.reply({
      content: `This thread is on **${requested}**: press the buttons on each step, or say what you want. \`/pipeline off\` to leave it.`,
      allowedMentions: { parse: [] },
    });
    const problem = start(ctx, requested, location);
    if (problem) await interaction.followUp({ content: problem.slice(0, 2000), allowedMentions: { parse: [] } });
  },
});
