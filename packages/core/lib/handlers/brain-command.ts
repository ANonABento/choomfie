/**
 * `/brain` — choose who answers in this channel (owner only).
 *
 *   /brain set brain:<id>   this channel/thread now answers with <id>; `claude` clears it
 *   /brain new              start a fresh backend conversation here
 *   /brain status           what answers here, and who it answers
 *
 * Threads inherit their parent channel's brain unless set directly, but each
 * thread is its own backend conversation.
 */

import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { AUTOCOMPLETE_LIMIT, CLAUDE_BRAIN, getBrain, listBrainIds } from "@choomfie/shared";
import { registerCommand } from "../register.ts";
import { resolveBrainId } from "../brain-router.ts";
import { requireOwner } from "./shared.ts";

function parentOf(channel: unknown): string | null {
  const c = channel as { isThread?: () => boolean; parentId?: string | null } | null;
  return c?.isThread?.() ? (c.parentId ?? null) : null;
}

function label(id: string): string {
  return id === CLAUDE_BRAIN ? "Claude" : (getBrain(id)?.label ?? `${id} (not loaded)`);
}

registerCommand("brain", {
  data: new SlashCommandBuilder()
    .setName("brain")
    .setDescription("Choose who answers in this channel (owner only)")
    .addSubcommand((s) =>
      s
        .setName("set")
        .setDescription("Set this channel's brain")
        .addStringOption((o) =>
          o.setName("brain").setDescription("claude, or a loaded brain").setRequired(true).setAutocomplete(true)
        )
    )
    .addSubcommand((s) => s.setName("new").setDescription("Start a fresh conversation with this channel's brain"))
    .addSubcommand((s) => s.setName("status").setDescription("Show what answers here"))
    .toJSON(),
  // Lists only brains actually loaded right now — in-memory, well inside 3s.
  autocomplete: async (interaction) => {
    const typed = interaction.options.getFocused().toLowerCase();
    await interaction.respond(
      listBrainIds()
        .filter((id) => id.includes(typed))
        .slice(0, AUTOCOMPLETE_LIMIT)
        .map((id) => ({ name: `${label(id)} (${id})`.slice(0, 100), value: id }))
    );
  },
  handler: async (interaction, ctx) => {
    if (await requireOwner(interaction, ctx)) return;
    const channelId = interaction.channelId;
    const parentId = parentOf(interaction.channel);
    const sub = interaction.options.getSubcommand();
    const current = resolveBrainId(channelId, parentId, (id) => ctx.config.getChannelBrain(id));
    const reply = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

    if (sub === "set") {
      const wanted = interaction.options.getString("brain", true).trim().toLowerCase();
      if (wanted !== CLAUDE_BRAIN && !getBrain(wanted)) {
        await reply(`No brain called \`${wanted}\` is loaded. Available: ${listBrainIds().map((b) => `\`${b}\``).join(", ")}.`);
        return;
      }
      // `claude` clears the override, so a thread falls back to its parent again.
      ctx.config.setChannelBrain(channelId, wanted === CLAUDE_BRAIN ? undefined : wanted);
      const now = resolveBrainId(channelId, parentId, (id) => ctx.config.getChannelBrain(id));
      const who = ctx.config.getBrainAccess() === "owner" ? "only you" : "everyone on the allowlist";
      await interaction.reply(
        now === CLAUDE_BRAIN
          ? "This channel is answered by **Claude**."
          : `This channel is now answered by **${label(now)}** — for ${who}. Others still get Claude. ` +
              "Change who with `/config setting:brainAccess`."
      );
      return;
    }

    if (sub === "new") {
      if (current === CLAUDE_BRAIN) {
        await reply("Claude's conversation is shared by every channel — use `/compact` or `/clear` instead.");
        return;
      }
      const brain = getBrain(current);
      if (!brain?.reset) {
        await reply(`**${label(current)}** can't start a fresh conversation.`);
        return;
      }
      await brain.reset(channelId);
      await interaction.reply(`Started a fresh **${brain.label}** conversation in this channel.`);
      return;
    }

    // status
    const own = ctx.config.getChannelBrain(channelId);
    const source = own ? "set on this channel" : parentId && ctx.config.getChannelBrain(parentId) ? "inherited from the parent channel" : "default";
    const lines = [
      `**${label(current)}** answers here (${source}).`,
      current === CLAUDE_BRAIN ? "" : `Answers: ${ctx.config.getBrainAccess() === "owner" ? "owner only" : "everyone on the allowlist"}; others get Claude.`,
      `Loaded brains: ${listBrainIds().map((b) => `\`${b}\``).join(", ")}`,
    ].filter(Boolean);
    await reply(lines.join("\n"));
  },
});
