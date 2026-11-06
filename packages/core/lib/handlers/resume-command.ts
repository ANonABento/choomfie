/**
 * `/resume [chat]` — the conversations behind this channel, like Claude Code's `/resume`.
 *
 *   /resume              the chat live here, recent ones with Resume buttons, and Rename
 *   /resume chat:<…>     put that chat back here (search by title, any brain)
 *
 * Starting a fresh chat is `/clear`. A thread you create is its own chat
 * automatically (it inherits the channel's brain), so there is no "new thread".
 *
 * Web brains (Waymond, …) keep one chat per channel, so resuming one only
 * affects this channel. Claude does too when the daemon runs one session per
 * location (`daemon.multiSession`); otherwise it has a single shared session,
 * and resuming a Claude chat swaps it everywhere. Either way Claude needs the
 * daemon, which owns the sessions.
 *
 * Owner-only: titles are the first thing you said, and a Claude swap affects
 * everyone talking to Choomfie.
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
import { botIsAbsent } from "../ask-relay.ts";
import { isOwner } from "../access.ts";
import { CLAUDE_GLOBAL, claudeIsPerLocation, syncClaudeChat } from "../chats/claude.ts";
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
  if (at && at !== CLAUDE_GLOBAL) bits.push(`live in <#${at}>`);
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
    .setFooter({
      text:
        (brain === CLAUDE_BRAIN && !(await claudeIsPerLocation(ctx))
          ? "Claude has one shared session: resuming swaps it for every channel. "
          : "") +
        "/resume chat: finds any chat by title · /clear starts a new one",
    });
  await interaction.reply({ embeds: [embed], components: buttons(others, current), flags: MessageFlags.Ephemeral });
}

/** Resume `chatId` at the interaction's location. Shared by the slash command and the buttons. */
export async function resumeChat(interaction: AnyInteraction, ctx: AppContext, chatId: string) {
  const chat = ctx.chats.get(chatId);
  if (!chat) return reply(interaction, "That chat doesn't exist anymore.");
  const channelId = interaction.channelId!;

  // Point this channel at the chat's brain if it isn't already. Only called
  // once the resume is known to go ahead, so a refusal changes nothing.
  const pointHere = () => {
    if (brainAt(interaction, ctx) === chat.brain) return;
    const parentId = parentChannelId(interaction.channel);
    const inherited = parentId ? resolveBrainId(parentId, null, (c) => ctx.config.getChannelBrain(c)) : CLAUDE_BRAIN;
    ctx.config.setChannelBrain(channelId, inherited === chat.brain ? undefined : chat.brain);
  };
  const done = async (content: string) => {
    if (interaction.isButton()) await interaction.update({ content, embeds: [], components: [] });
    else await interaction.reply({ content });
  };

  if (chat.brain === CLAUDE_BRAIN) {
    if (!(await isDaemonMode(ctx.DATA_DIR))) {
      return reply(interaction, `${FOREGROUND_CHAT_NOTICE}${chat.backendRef ? `\nSession id: \`${chat.backendRef}\`` : ""}`);
    }
    if (await claudeIsPerLocation(ctx)) {
      // Its own session per location: bind it here and let the daemon close
      // whatever this channel had; the next message opens (resumes) this one.
      pointHere();
      if (ctx.chats.bound(channelId, CLAUDE_BRAIN)?.id === chat.id) return reply(interaction, `**${chat.title}** is already live here.`);
      const movedFrom = ctx.chats.locationOf(chat.id);
      ctx.chats.bind(channelId, chat.id);
      ctx.chats.touch(chat.id);
      await requestDaemonControl(ctx.DATA_DIR, "resume", { requestedBy: interaction.user.id, location: channelId, targetChat: chat.id });
      return done(
        `Resumed **${chat.title}** here${chat.cwd ? ` in \`${shortPath(chat.cwd)}\`` : ""} — your next message picks it up.` +
          (movedFrom && movedFrom !== channelId && movedFrom !== CLAUDE_GLOBAL ? ` (Moved from <#${movedFrom}>, which starts fresh next time.)` : "")
      );
    }
    const held = await syncClaudeChat(ctx);
    if (held?.id === chat.id) {
      pointHere();
      return reply(interaction, `**${chat.title}** is already the live Claude chat.`);
    }
    if (!chat.backendRef) return reply(interaction, `**${chat.title}** never got as far as a session — nothing to resume.`);
    pointHere();
    ctx.chats.bind(CLAUDE_GLOBAL, chat.id);
    await requestDaemonControl(ctx.DATA_DIR, "resume", {
      requestedBy: interaction.user.id,
      chatId: botIsAbsent(interaction) ? undefined : channelId,
      targetChat: chat.id,
      sdkSessionId: chat.backendRef,
      cwd: chat.cwd ?? undefined,
      title: chat.title,
    });
    return done(`Resuming **${chat.title}**${chat.cwd ? ` in \`${shortPath(chat.cwd)}\`` : ""} — back in a few seconds.`);
  }

  if (!getBrain(chat.brain)) return reply(interaction, `The \`${chat.brain}\` brain isn't loaded right now.`);
  pointHere();
  if (ctx.chats.bound(channelId, chat.brain)?.id === chat.id) return reply(interaction, `**${chat.title}** is already live here.`);
  const movedFrom = ctx.chats.locationOf(chat.id);
  ctx.chats.bind(channelId, chat.id);
  ctx.chats.touch(chat.id);
  await getBrain(chat.brain)?.reset?.(channelId);
  return done(
    `Resumed **${chat.title}** with ${brainLabel(chat.brain)} here.` +
      (movedFrom && movedFrom !== channelId ? ` (Moved from <#${movedFrom}>, which starts fresh next time.)` : "")
  );
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

