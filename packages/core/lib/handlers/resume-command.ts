/**
 * `/resume [chat]` — the conversations behind this channel, like Claude Code's `/resume`.
 *
 *   /resume              the chat live here, recent ones with Resume buttons, and Rename
 *   /resume chat:<…>     put that chat back here (search by title, any brain)
 *
 * Starting a fresh chat is `/clear`. A thread is its own chat automatically
 * (it inherits the channel's brain), so there is no "new thread".
 *
 * Every brain keeps one chat per location, so resuming only affects this
 * channel; a chat live elsewhere moves here. Claude needs the daemon, which
 * owns the sessions.
 *
 * Owner-only: titles are the first thing someone said.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  ANYWHERE,
  AUTOCOMPLETE_LIMIT,
  CHAT_TITLE_MAX,
  CLAUDE_BRAIN,
  getBrain,
  relativeTime,
  type ChatRecord,
} from "@choomfie/shared";
import { registerButtonHandler, registerCommand, registerModalHandler } from "../register.ts";
import { parentChannelId, resolveBrainId } from "../brain-router.ts";
import { isDaemonMode, requestDaemonControl } from "../daemon-status.ts";
import { isOwner } from "../access.ts";
import { brainAt, liveChat, shortPath, type AnyInteraction } from "../chats/here.ts";
import type { AppContext } from "../types.ts";
import { requireOwner } from "./shared.ts";

const LIST_LIMIT = 10;
const RESUME_BUTTONS = 5;

export const FOREGROUND_CHAT_NOTICE =
  "Claude chats need the daemon: in **foreground mode** the session belongs to the `claude` CLI in " +
  "your terminal. Use `claude --resume` there, or run `choomfie --daemon` to swap chats from Discord.";

function brainLabel(id: string): string {
  return id === CLAUDE_BRAIN ? "Claude" : (getBrain(id)?.label ?? id);
}

function chatLine(chat: ChatRecord, ctx: AppContext): string {
  const bits = [`**${chat.title}**`, relativeTime(chat.lastActiveAt)];
  if (chat.cwd) bits.push(`\`${shortPath(chat.cwd)}\``);
  const at = ctx.chats.locationOf(chat.id);
  if (at) bits.push(`live in <#${at}>`);
  return `• ${bits.join(" · ")}`;
}

function buttons(others: ChatRecord[], current: ChatRecord | null) {
  const rows = [];
  if (others.length) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        others.slice(0, RESUME_BUTTONS).map((c) =>
          new ButtonBuilder()
            .setCustomId(`chat:resume:${c.id}`)
            .setLabel(`Resume: ${c.title}`.slice(0, 80))
            .setStyle(ButtonStyle.Secondary)
        )
      )
    );
  }
  if (current) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`chat:rename:${current.id}`).setLabel("Rename this chat").setStyle(ButtonStyle.Primary)
      )
    );
  }
  return rows;
}

async function reply(interaction: AnyInteraction, content: string) {
  if (interaction.deferred || interaction.replied) await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
  else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

async function show(interaction: ChatInputCommandInteraction, ctx: AppContext) {
  const { brain, chat: current } = await liveChat(interaction, ctx);
  const others = ctx.chats
    .list({ brain, limit: LIST_LIMIT + 1 })
    .filter((c) => c.id !== current?.id)
    .slice(0, LIST_LIMIT);

  const here = current
    ? `**${current.title}** · since ${relativeTime(current.createdAt)}${current.cwd ? ` · \`${shortPath(current.cwd)}\`` : ""}`
    : brain === CLAUDE_BRAIN && !(await isDaemonMode(ctx.DATA_DIR))
      ? "the terminal session"
      : "nothing yet — say something";
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`${brainLabel(brain)} chats`)
    .setDescription(
      [`Live here: ${here}`, "", others.length ? others.map((c) => chatLine(c, ctx)).join("\n") : "No earlier chats."].join("\n")
    )
    .setFooter({ text: "/resume chat: finds any chat by title · /clear starts a new one" });
  await interaction.reply({ embeds: [embed], components: buttons(others, current), flags: MessageFlags.Ephemeral });
}

/** Resume `chatId` at the interaction's location. Shared by the slash command and the buttons. */
export async function resumeChat(interaction: AnyInteraction, ctx: AppContext, chatId: string) {
  const chat = ctx.chats.get(chatId);
  if (!chat) return reply(interaction, "That chat doesn't exist anymore.");
  const location = interaction.channelId!;

  if (chat.brain === CLAUDE_BRAIN) {
    if (!(await isDaemonMode(ctx.DATA_DIR))) {
      return reply(interaction, `${FOREGROUND_CHAT_NOTICE}${chat.backendRef ? `\nSession id: \`${chat.backendRef}\`` : ""}`);
    }
  } else if (!getBrain(chat.brain)) {
    return reply(interaction, `The \`${chat.brain}\` brain isn't loaded right now.`);
  }

  // Point this channel at the chat's brain if it isn't already.
  if (brainAt(interaction, ctx) !== chat.brain) {
    const parentId = parentChannelId(interaction.channel);
    const inherited = parentId ? resolveBrainId(parentId, null, (c) => ctx.config.getChannelBrain(c)) : CLAUDE_BRAIN;
    ctx.config.setChannelBrain(location, inherited === chat.brain ? undefined : chat.brain);
  }
  if (ctx.chats.bound(location, chat.brain)?.id === chat.id) return reply(interaction, `**${chat.title}** is already live here.`);

  const movedFrom = ctx.chats.locationOf(chat.id);
  ctx.chats.bind(location, chat.id);
  ctx.chats.touch(chat.id);
  // The old conversation here ends: Claude's session closes, a web brain stops watching.
  if (chat.brain === CLAUDE_BRAIN) {
    await requestDaemonControl(ctx.DATA_DIR, "resume", { requestedBy: interaction.user.id, location });
  } else {
    await getBrain(chat.brain)?.reset?.(location);
  }

  const content =
    `Resumed **${chat.title}** with ${brainLabel(chat.brain)} here` +
    (chat.cwd ? ` in \`${shortPath(chat.cwd)}\`` : "") +
    " — your next message picks it up." +
    (movedFrom && movedFrom !== location ? ` (Moved from <#${movedFrom}>, which starts fresh next time.)` : "");
  if (interaction.isButton()) await interaction.update({ content, embeds: [], components: [] });
  else await interaction.reply({ content });
}

registerCommand("resume", {
  data: {
    ...new SlashCommandBuilder()
      .setName("resume")
      .setDescription("Chats here: see them, rename, or put an earlier one back (owner only)")
      .addStringOption((o) =>
        o.setName("chat").setDescription("Resume this chat — search by title, any brain").setAutocomplete(true)
      )
      .toJSON(),
    ...ANYWHERE,
  },
  // Local SQLite only — no network, well inside Discord's 3s.
  autocomplete: async (interaction, ctx) => {
    if (!isOwner(ctx, interaction.user.id)) return interaction.respond([]);
    const typed = interaction.options.getFocused().toLowerCase();
    return interaction.respond(
      ctx.chats.search(typed, { limit: AUTOCOMPLETE_LIMIT }).map((c) => ({
        name: `${c.title} · ${brainLabel(c.brain)} · ${relativeTime(c.lastActiveAt)}`.slice(0, 100),
        value: c.id,
      }))
    );
  },
  handler: async (interaction, ctx) => {
    if (await requireOwner(interaction, ctx)) return;
    const chatId = interaction.options.getString("chat");
    return chatId ? resumeChat(interaction, ctx, chatId) : show(interaction, ctx);
  },
});

registerButtonHandler("chat", async (interaction, parts, ctx) => {
  if (!isOwner(ctx, interaction.user.id)) {
    await interaction.reply({ content: "This is owner-only~", flags: MessageFlags.Ephemeral });
    return;
  }
  const chatId = parts[2];
  if (!chatId) return;
  if (parts[1] === "resume") return resumeChat(interaction, ctx, chatId);
  if (parts[1] === "rename") {
    const chat = ctx.chats.get(chatId);
    if (!chat) return reply(interaction, "That chat doesn't exist anymore.");
    // A modal must be the first response to the click.
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(`chatrename:${chatId}`)
        .setTitle("Rename chat")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("title")
              .setLabel("Title")
              .setStyle(TextInputStyle.Short)
              .setValue(chat.title.slice(0, CHAT_TITLE_MAX))
              .setMaxLength(CHAT_TITLE_MAX)
              .setRequired(true)
          )
        )
    );
  }
});

registerModalHandler("chatrename", async (interaction, parts, ctx) => {
  if (!isOwner(ctx, interaction.user.id)) {
    await interaction.reply({ content: "This is owner-only~", flags: MessageFlags.Ephemeral });
    return;
  }
  const chat = parts[1] ? ctx.chats.get(parts[1]) : null;
  const title = interaction.fields.getTextInputValue("title").trim().slice(0, CHAT_TITLE_MAX);
  if (!chat || !title) {
    await interaction.reply({ content: "Nothing to rename.", flags: MessageFlags.Ephemeral });
    return;
  }
  ctx.chats.rename(chat.id, title);
  // A web brain's chat in a thread: the thread name is its title too.
  const channel = interaction.channel;
  if (chat.brain !== CLAUDE_BRAIN && channel?.isThread() && ctx.chats.locationOf(chat.id) === channel.id) {
    await channel.setName(title).catch(() => {});
  }
  await interaction.reply({ content: `Renamed to **${title}**.`, flags: MessageFlags.Ephemeral });
});

