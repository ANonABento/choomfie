/**
 * `/clear` and `/compact` — this channel's chat, from Discord.
 *
 * Named after the Claude Code commands they mirror. Neither touches memories,
 * reminders or personas — those live in SQLite, the way Claude Code's `/clear`
 * leaves CLAUDE.md alone.
 *
 * - `/clear [cwd]` starts a new chat here with whichever brain answers here
 *   (`/brain`); the old one is kept and `/resume` brings it back. Claude:
 *   `cwd:` (one of config `chatRoots`) starts it in another project.
 *   Other brains: `mode:` starts it in one of the brain's modes.
 * - `/mode [name]` puts this chat in one of its brain's modes (Waymond: code,
 *   plan, cad, 3d), or shows them; `off` goes back to plain chat.
 * - `/compact` (Claude) summarises this chat's session and carries on fresh
 *   with the summary. Other brains manage their own context.
 *
 * Claude needs the daemon, which runs one session per location. In foreground
 * mode the session belongs to the `claude` CLI in your terminal and there is
 * no remote way in, so the commands say so rather than hide.
 */

import { EmbedBuilder, MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { ANYWHERE, AUTOCOMPLETE_LIMIT, CLAUDE_BRAIN, getBrain, type BrainMode } from "@choomfie/shared";
import { registerCommand } from "../register.ts";
import { isDaemonMode, requestDaemonControl } from "../daemon-status.ts";
import { brainAt, resolveChatCwd, shortPath } from "../chats/here.ts";
import { parseModel } from "../settings.ts";
import { botIsAbsent } from "../ask-relay.ts";
import { requireOwner } from "./shared.ts";

export const FOREGROUND_NOTICE =
  "Choomfie is running in **foreground mode**, where the session belongs to the " +
  "`claude` CLI in your terminal — nothing in Discord can reach it.\n" +
  "Type the same command there, or run `choomfie --daemon` to make it work from here.";

async function ephemeral(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

const brainName = (id: string) => (id === CLAUDE_BRAIN ? "Claude" : (getBrain(id)?.label ?? id));

const MODE_OFF = "off";
const modesOf = (brain: string): BrainMode[] => (brain === CLAUDE_BRAIN ? [] : (getBrain(brain)?.modes ?? []));

/** A brain's modes matching what's typed, plus `off`. In memory — well inside 3s. */
function modeChoices(brain: string, typed: string, withOff: boolean) {
  const t = typed.toLowerCase();
  return [...modesOf(brain).map((m) => ({ name: `${m.label} — ${m.description}`, value: m.id })), ...(withOff ? [{ name: "off — plain chat", value: MODE_OFF }] : [])]
    .filter((c) => c.value.includes(t) || c.name.toLowerCase().includes(t))
    .slice(0, AUTOCOMPLETE_LIMIT)
    .map((c) => ({ name: c.name.slice(0, 100), value: c.value }));
}

/** `requested` as a mode of `brain`: its id, null for `off`, or an error to show. */
function resolveMode(brain: string, requested: string): { mode: string | null } | { error: string } {
  const wanted = requested.trim().toLowerCase();
  if (wanted === MODE_OFF || wanted === "none") return { mode: null };
  const modes = modesOf(brain);
  if (modes.some((m) => m.id === wanted)) return { mode: wanted };
  return {
    error: modes.length
      ? `**${brainName(brain)}** has no \`${wanted}\` mode. Modes: ${modes.map((m) => `\`${m.id}\``).join(", ")}, or \`off\`.`
      : `**${brainName(brain)}** has no modes.`,
  };
}

registerCommand("compact", {
  data: new SlashCommandBuilder()
    .setName("compact")
    .setDescription("Free up context, keeping a summary of the conversation (owner only)")
    .toJSON(),
  handler: async (interaction, ctx) => {
    if (await requireOwner(interaction, ctx)) return;
    const brain = brainAt(interaction, ctx);
    if (brain !== CLAUDE_BRAIN) {
      return ephemeral(
        interaction,
        `This channel is answered by **${brainName(brain)}**, which manages its own context — nothing to compact. ` +
          "`/clear` starts a fresh conversation with it here."
      );
    }
    if (!(await isDaemonMode(ctx.DATA_DIR))) return ephemeral(interaction, FOREGROUND_NOTICE);

    await requestDaemonControl(ctx.DATA_DIR, "compact", {
      requestedBy: interaction.user.id,
      location: interaction.channelId,
      // The fresh session says hello here, unless this is a chat the bot can't post in.
      chatId: botIsAbsent(interaction) ? undefined : interaction.channelId,
    });
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle("Compacting context")
          .setDescription(
            "Summarising this chat and carrying on in a fresh session with the summary. " +
              "Who you were talking to and what about carries over."
          )
          .setFooter({ text: "Takes a few seconds — I'll post here when I'm back." }),
      ],
    });
  },
});

registerCommand("clear", {
  data: {
    ...new SlashCommandBuilder()
      .setName("clear")
      .setDescription("Start a new chat here; /resume brings the old one back (owner only)")
      .addStringOption((o) =>
        o.setName("cwd").setDescription("Claude only: work in this directory (one of chatRoots)").setAutocomplete(true)
      )
      .addStringOption((o) =>
        o.setName("model").setDescription("Claude only: run the new chat on this model (e.g. sonnet)")
      )
      .addStringOption((o) =>
        o.setName("mode").setDescription("Other brains: start the new chat in this mode (e.g. code)").setAutocomplete(true)
      )
      .toJSON(),
    // In a group DM answered by another brain, this is the only way to start it fresh.
    ...ANYWHERE,
  },
  // Config and loaded brains only — well inside Discord's 3s.
  autocomplete: async (interaction, ctx) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name === "mode") {
      await interaction.respond(modeChoices(brainAt(interaction, ctx), focused.value, false));
      return;
    }
    const typed = focused.value.toLowerCase();
    await interaction.respond(
      ctx.config
        .getChatRoots()
        .filter((r) => r.toLowerCase().includes(typed))
        .slice(0, AUTOCOMPLETE_LIMIT)
        .map((r) => ({ name: shortPath(r).slice(0, 100), value: r.slice(0, 100) }))
    );
  },
  handler: async (interaction, ctx) => {
    if (await requireOwner(interaction, ctx)) return;
    const location = interaction.channelId;
    const brain = brainAt(interaction, ctx);
    const requested = interaction.options.getString("cwd")?.trim();
    const requestedModel = interaction.options.getString("model")?.trim();
    const requestedMode = interaction.options.getString("mode")?.trim();

    let cwd: string | undefined;
    let model: string | undefined;
    if (brain === CLAUDE_BRAIN) {
      if (!(await isDaemonMode(ctx.DATA_DIR))) return ephemeral(interaction, FOREGROUND_NOTICE);
      if (requested) {
        const resolved = resolveChatCwd(requested, ctx.config.getChatRoots());
        if ("error" in resolved) return ephemeral(interaction, resolved.error);
        cwd = resolved.cwd;
      }
      if (requestedModel) {
        const parsed = parseModel(requestedModel);
        if ("error" in parsed) return ephemeral(interaction, parsed.error);
        model = parsed.value;
      }
      if (requestedMode) return ephemeral(interaction, "Claude has no modes — `mode` is for other brains (`/brain`).");
    } else if (requested || requestedModel) {
      return ephemeral(interaction, `\`cwd\` and \`model\` only apply to Claude chats; **${brainName(brain)}** runs in its own app.`);
    }
    let mode: string | null = null;
    if (requestedMode) {
      const resolved = resolveMode(brain, requestedMode);
      if ("error" in resolved) return ephemeral(interaction, resolved.error);
      mode = resolved.mode;
    }

    // A new chat bound here; the old one stays listable for `/resume`.
    const chat = ctx.chats.start(location, brain);
    if (cwd) ctx.chats.setCwd(chat.id, cwd);
    if (model) ctx.chats.setModel(chat.id, model);
    if (mode) ctx.chats.setMode(chat.id, mode);
    if (brain === CLAUDE_BRAIN) {
      await requestDaemonControl(ctx.DATA_DIR, "clear", { requestedBy: interaction.user.id, location });
    } else {
      await getBrain(brain)?.reset?.(location);
    }

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle(`New ${brainName(brain)} chat`)
          .setDescription(
            `Your next message here starts a new chat${cwd ? `, working in \`${shortPath(cwd)}\`` : ""}` +
              `${model ? ` on **${model}**` : ""}${mode ? ` in **${mode}** mode` : ""}. ` +
              "`/resume` brings the old one back. Other channels are untouched."
          ),
      ],
    });
  },
});

registerCommand("mode", {
  data: {
    ...new SlashCommandBuilder()
      .setName("mode")
      .setDescription("Put this chat in one of its brain's modes — code, plan, cad… (owner only)")
      .addStringOption((o) =>
        o.setName("name").setDescription("A mode, or `off` for plain chat — omit to see them").setAutocomplete(true)
      )
      .toJSON(),
    ...ANYWHERE,
  },
  autocomplete: async (interaction, ctx) => {
    await interaction.respond(modeChoices(brainAt(interaction, ctx), interaction.options.getFocused(), true));
  },
  handler: async (interaction, ctx) => {
    if (await requireOwner(interaction, ctx)) return;
    const brain = brainAt(interaction, ctx);
    const modes = modesOf(brain);
    if (!modes.length) {
      return ephemeral(
        interaction,
        `**${brainName(brain)}** answers here and has no modes. Modes belong to web brains like Waymond — \`/brain\` to switch.`
      );
    }
    const requested = interaction.options.getString("name");
    if (requested === null) {
      const current = ctx.chats.bound(interaction.channelId, brain)?.mode;
      return ephemeral(
        interaction,
        [
          `This **${brainName(brain)}** chat is ${current ? `in **${current}** mode` : "a plain chat (no mode)"}.`,
          ...modes.map((m) => `\`${m.id}\` — ${m.description}`),
          "`/mode <name>` switches; `/mode off` goes back to plain chat. It applies from your next message.",
        ].join("\n")
      );
    }
    const resolved = resolveMode(brain, requested);
    if ("error" in resolved) return ephemeral(interaction, resolved.error);
    // An untitled chat if nobody has spoken here yet; the first message names it.
    const chat = ctx.chats.current(interaction.channelId, brain);
    ctx.chats.setMode(chat.id, resolved.mode);
    const label = modes.find((m) => m.id === resolved.mode)?.label;
    await interaction.reply(
      label
        ? `This **${brainName(brain)}** chat is now in **${label}** mode, from your next message. \`/mode off\` to leave it.`
        : `This **${brainName(brain)}** chat is back to plain chat.`
    );
  },
});
