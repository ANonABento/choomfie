/**
 * `/chat` — the conversations behind a channel, and swapping between them.
 *
 *   /chat list [brain]        recent chats, the one live here marked; Resume buttons
 *   /chat new [title] [cwd]   start a fresh chat (a new thread, in a server channel)
 *   /chat resume <chat>       put an earlier chat back here
 *   /chat rename <title>      rename the chat live here (and its thread)
 *
 * A chat belongs to one brain. Web brains (Waymond, …) keep one chat per
 * location, so resuming one only affects this channel. Claude has a single
 * shared session until sessions can run side by side, so a Claude chat swaps
 * the session everywhere — and needs the daemon, which owns that session.
 *
 * Owner-only throughout: titles are the first thing you said, and a Claude
 * swap affects everyone talking to Choomfie.
 */

import { realpathSync } from "node:fs";
import { sep } from "node:path";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  ANYWHERE,
  AUTOCOMPLETE_LIMIT,
  CHAT_TITLE_MAX,
  CLAUDE_BRAIN,
  getBrain,
  relativeTime,
  UNTITLED_CHAT,
  type ChatRecord,
} from "@choomfie/shared";
import { registerButtonHandler, registerCommand } from "../register.ts";
import { parentChannelId, resolveBrainId } from "../brain-router.ts";
import { isDaemonMode, requestDaemonControl } from "../daemon-status.ts";
import { botIsAbsent } from "../ask-relay.ts";
import { isOwner } from "../access.ts";
import { CLAUDE_GLOBAL, syncClaudeChat } from "../chats/claude.ts";
import { brainAt, home, liveChat, locationFor, shortPath, type AnyInteraction } from "../chats/here.ts";
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


/**
 * Resolve a requested cwd against the allowed roots. Returns the real path, or
 * an error to show. Symlinks are resolved first, so a link inside a root can't
 * point a session somewhere outside it.
 */
export function resolveChatCwd(requested: string, roots: string[]): { cwd: string } | { error: string } {
  if (!roots.length) {
    return { error: "No working directories are allowed yet. Add them to `chatRoots` in config.json, e.g. `[\"~/projects\"]`." };
  }
  const expanded = requested.startsWith("~") ? home() + requested.slice(1) : requested;
  let real: string;
  try {
    real = realpathSync(expanded);
  } catch {
    return { error: `\`${requested}\` doesn't exist.` };
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      continue;
    }
    if (real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) return { cwd: real };
  }
  return { error: `\`${requested}\` isn't under an allowed root (${roots.map((r) => `\`${shortPath(r)}\``).join(", ")}).` };
}

function chatLine(chat: ChatRecord, here: boolean, ctx: AppContext): string {
  const bits = [`**${chat.title}**`, relativeTime(chat.lastActiveAt)];
  if (chat.cwd) bits.push(`\`${shortPath(chat.cwd)}\``);
  if (here) bits.push("← live here");
  else if (chat.brain !== CLAUDE_BRAIN) {
    const at = ctx.chats.locationOf(chat.id);
    if (at) bits.push(`live in <#${at}>`);
  }
  return bits.join(" · ");
}

function resumeRow(chats: ChatRecord[]) {
  if (!chats.length) return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      chats.slice(0, RESUME_BUTTONS).map((c) =>
        new ButtonBuilder()
          .setCustomId(`chat:resume:${c.id}`)
          .setLabel(`Resume: ${c.title}`.slice(0, 80))
          .setStyle(ButtonStyle.Secondary)
      )
    ),
  ];
}

async function reply(interaction: AnyInteraction, content: string) {
  if (interaction.deferred || interaction.replied) await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
  else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}


async function list(interaction: ChatInputCommandInteraction, ctx: AppContext) {
  const brainHere = brainAt(interaction, ctx);
  const brain = interaction.options.getString("brain") ?? brainHere;
  if (brain === CLAUDE_BRAIN) await syncClaudeChat(ctx);
  const current = ctx.chats.bound(locationFor(brain, interaction.channelId), brain);
  const chats = ctx.chats.list({ brain, limit: LIST_LIMIT });

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`${brainLabel(brain)} chats`)
    .setDescription(
      chats.length
        ? chats.map((c) => chatLine(c, c.id === current?.id, ctx)).join("\n")
        : "No chats yet — say something, or `/chat new`."
    )
    .setFooter({
      text:
        brain === CLAUDE_BRAIN
          ? "Claude has one shared session: resuming swaps it for every channel."
          : "`/chat resume` finds older ones by title.",
    });
  const others = chats.filter((c) => c.id !== current?.id);
  await interaction.reply({ embeds: [embed], components: resumeRow(others), flags: MessageFlags.Ephemeral });
}

async function startNew(interaction: ChatInputCommandInteraction, ctx: AppContext) {
  const brain = brainAt(interaction, ctx);
  const title = interaction.options.getString("title")?.trim().slice(0, CHAT_TITLE_MAX) || undefined;
  const requestedCwd = interaction.options.getString("cwd")?.trim();

  if (brain === CLAUDE_BRAIN) {
    if (!(await isDaemonMode(ctx.DATA_DIR))) return reply(interaction, FOREGROUND_CHAT_NOTICE);
    let cwd: string | undefined;
    if (requestedCwd) {
      const resolved = resolveChatCwd(requestedCwd, ctx.config.getChatRoots());
      if ("error" in resolved) return reply(interaction, resolved.error);
      cwd = resolved.cwd;
    }
    const held = await syncClaudeChat(ctx);
    const chat = ctx.chats.create({
      locationId: CLAUDE_GLOBAL,
      brain: CLAUDE_BRAIN,
      title,
      cwd: cwd ?? held?.cwd ?? null,
    });
    ctx.chats.bind(CLAUDE_GLOBAL, chat.id);
    await requestDaemonControl(ctx.DATA_DIR, "new", {
      requestedBy: interaction.user.id,
      chatId: botIsAbsent(interaction) ? undefined : interaction.channelId,
      targetChat: chat.id,
      cwd: chat.cwd ?? undefined,
      title: chat.title === UNTITLED_CHAT ? undefined : chat.title,
    });
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle("Starting a new Claude chat")
          .setDescription(
            [
              title ? `**${title}**` : "Untitled until you say something.",
              chat.cwd ? `Working in \`${shortPath(chat.cwd)}\`.` : null,
              "The current one is saved — `/chat list` to get it back.",
            ]
              .filter(Boolean)
              .join("\n")
          )
          .setFooter({ text: "Takes a few seconds — I'll post here when I'm back." }),
      ],
    });
    return;
  }

  if (requestedCwd) return reply(interaction, `\`cwd\` only applies to Claude chats; **${brainLabel(brain)}** runs in its own app.`);

  // In a server text channel, a new chat gets its own thread: the thread name
  // is the title, and the old chat stays live in the channel.
  const channel = interaction.channel;
  if (channel?.type === ChannelType.GuildText) {
    try {
      const thread = await channel.threads.create({ name: title ?? `${brainLabel(brain)} chat`, autoArchiveDuration: 1440 });
      ctx.chats.start(thread.id, brain, title);
      await thread.send(`New **${brainLabel(brain)}** chat — talk to me here.`).catch(() => {});
      await reply(interaction, `Started a new ${brainLabel(brain)} chat in <#${thread.id}>.`);
      return;
    } catch (e) {
      console.error(`[chat] thread create failed, starting in place: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Thread, DM, group DM (or no thread permission): swap in place.
  ctx.chats.start(interaction.channelId, brain, title);
  await getBrain(brain)?.reset?.(interaction.channelId);
  await interaction.reply({
    content: `Fresh **${brainLabel(brain)}** chat here${title ? `: **${title}**` : ""}. The previous one is in \`/chat list\`.`,
  });
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

  if (chat.brain === CLAUDE_BRAIN) {
    if (!(await isDaemonMode(ctx.DATA_DIR))) {
      return reply(interaction, `${FOREGROUND_CHAT_NOTICE}${chat.backendRef ? `\nSession id: \`${chat.backendRef}\`` : ""}`);
    }
    const held = await syncClaudeChat(ctx);
    if (held?.id === chat.id) {
      pointHere();
      return reply(interaction, `**${chat.title}** is already the live Claude chat.`);
    }
    if (!chat.backendRef) return reply(interaction, `**${chat.title}** never got as far as a session — nothing to resume. \`/chat new\` instead.`);
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
    const content = `Resuming **${chat.title}**${chat.cwd ? ` in \`${shortPath(chat.cwd)}\`` : ""} — back in a few seconds.`;
    if (interaction.isButton()) await interaction.update({ content, embeds: [], components: [] });
    else await interaction.reply({ content });
    return;
  }

  if (!getBrain(chat.brain)) return reply(interaction, `The \`${chat.brain}\` brain isn't loaded right now.`);
  pointHere();
  const previous = ctx.chats.bound(channelId, chat.brain);
  if (previous?.id === chat.id) return reply(interaction, `**${chat.title}** is already live here.`);
  const movedFrom = ctx.chats.locationOf(chat.id);
  ctx.chats.bind(channelId, chat.id);
  ctx.chats.touch(chat.id);
  await getBrain(chat.brain)?.reset?.(channelId);
  const content =
    `Resumed **${chat.title}** with ${brainLabel(chat.brain)} here.` +
    (movedFrom && movedFrom !== channelId ? ` (Moved from <#${movedFrom}>, which starts fresh next time.)` : "");
  if (interaction.isButton()) await interaction.update({ content, embeds: [], components: [] });
  else await interaction.reply({ content });
}

async function rename(interaction: ChatInputCommandInteraction, ctx: AppContext) {
  const title = interaction.options.getString("title", true).trim().slice(0, CHAT_TITLE_MAX);
  if (!title) return reply(interaction, "Give it a name.");
  const { brain, chat } = await liveChat(interaction, ctx);
  if (!chat) {
    return reply(interaction, brain === CLAUDE_BRAIN ? FOREGROUND_CHAT_NOTICE : "There's no chat here yet — say something first.");
  }
  ctx.chats.rename(chat.id, title);
  const channel = interaction.channel;
  if (brain !== CLAUDE_BRAIN && channel?.isThread()) await channel.setName(title).catch(() => {});
  await reply(interaction, `Renamed to **${title}**.`);
}

registerCommand("chat", {
  data: {
    ...new SlashCommandBuilder()
      .setName("chat")
      .setDescription("Conversations here: list, start, resume, rename (owner only)")
      .addSubcommand((s) =>
        s
          .setName("list")
          .setDescription("Recent chats with the brain answering here")
          .addStringOption((o) => o.setName("brain").setDescription("Another brain's chats").setAutocomplete(true))
      )
      .addSubcommand((s) =>
        s
          .setName("new")
          .setDescription("Start a fresh chat (a new thread, in a server channel)")
          .addStringOption((o) => o.setName("title").setDescription("Name it now (default: your first message)"))
          .addStringOption((o) =>
            o.setName("cwd").setDescription("Claude only: working directory, under chatRoots").setAutocomplete(true)
          )
      )
      .addSubcommand((s) =>
        s
          .setName("resume")
          .setDescription("Put an earlier chat back here")
          .addStringOption((o) => o.setName("chat").setDescription("Search by title").setRequired(true).setAutocomplete(true))
      )
      .addSubcommand((s) =>
        s
          .setName("rename")
          .setDescription("Rename the chat live here")
          .addStringOption((o) => o.setName("title").setDescription("New name").setRequired(true).setMaxLength(CHAT_TITLE_MAX))
      )
      .toJSON(),
    ...ANYWHERE,
  },
  // Local SQLite and config only — no network, well inside Discord's 3s.
  autocomplete: async (interaction, ctx) => {
    const focused = interaction.options.getFocused(true);
    const typed = focused.value.toLowerCase();
    if (!isOwner(ctx, interaction.user.id)) return interaction.respond([]);

    if (focused.name === "brain") {
      const ids = new Set([CLAUDE_BRAIN, ...ctx.chats.list({ limit: 200 }).map((c) => c.brain)]);
      return interaction.respond(
        [...ids]
          .filter((id) => id.includes(typed))
          .slice(0, AUTOCOMPLETE_LIMIT)
          .map((id) => ({ name: brainLabel(id), value: id }))
      );
    }
    if (focused.name === "cwd") {
      return interaction.respond(
        ctx.config
          .getChatRoots()
          .filter((r) => r.toLowerCase().includes(typed))
          .slice(0, AUTOCOMPLETE_LIMIT)
          .map((r) => ({ name: shortPath(r).slice(0, 100), value: r.slice(0, 100) }))
      );
    }
    // chat: across every brain, so a chat can be resumed into any channel.
    return interaction.respond(
      ctx.chats.search(typed, { limit: AUTOCOMPLETE_LIMIT }).map((c) => ({
        name: `${c.title} · ${brainLabel(c.brain)} · ${relativeTime(c.lastActiveAt)}`.slice(0, 100),
        value: c.id,
      }))
    );
  },
  handler: async (interaction, ctx) => {
    if (await requireOwner(interaction, ctx)) return;
    switch (interaction.options.getSubcommand()) {
      case "list":
        return list(interaction, ctx);
      case "new":
        return startNew(interaction, ctx);
      case "resume":
        return resumeChat(interaction, ctx, interaction.options.getString("chat", true));
      case "rename":
        return rename(interaction, ctx);
    }
  },
});

registerButtonHandler("chat", async (interaction, parts, ctx) => {
  if (!isOwner(ctx, interaction.user.id)) {
    await interaction.reply({ content: "This is owner-only~", flags: MessageFlags.Ephemeral });
    return;
  }
  if (parts[1] === "resume" && parts[2]) await resumeChat(interaction, ctx, parts[2]);
});
