/**
 * `/brain [name]` and `/stop` — who answers in this channel, and interrupting it.
 *
 *   /brain           show what answers here, for whom, and what's loaded
 *   /brain <name>    this channel/thread now answers with <name>; `claude` clears it
 *   /brain threads:  whether an @mention in this server channel opens a thread
 *   /stop            interrupt the reply in progress here, whoever is answering
 *
 * Starting over is `/clear`, which also follows the channel's brain, and the
 * channel's brain shows in `/status`. One command per verb, whoever answers.
 *
 * Also handles the buttons a brain's answer can carry: quick replies
 * (`brain:choice:<n>`), approvals (`brain:approval:yes|no`) and patches
 * (`brain:pr`, owner only: opens a draft PR from the patch) and plan tasks
 * (`brain:task:<n>`, owner only: runs the task in its own thread, in its mode).
 *
 * Threads inherit their parent channel's brain unless set directly, but each
 * thread is its own backend conversation.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
} from "discord.js";
import { ANYWHERE, AUTOCOMPLETE_LIMIT, CLAUDE_BRAIN, getBrain, listBrainIds } from "@choomfie/shared";
import { botIsAbsent, interactionChannel, rememberBrainRelay, settleAskRelays } from "../ask-relay.ts";
import { registerButtonHandler, registerCommand } from "../register.ts";
import {
  clearPendingApproval,
  dispatchToBrain,
  getPendingApproval,
  getTaskBoard,
  taskBoardRows,
  parentChannelId,
  resolveBrainId,
  takeChoices,
  type SendableChannel,
  type TaskBoard,
} from "../brain-router.ts";
import { isAllowed, isOwner } from "../access.ts";
import { onMessageReceived, onReplySent } from "../typing.ts";
import { isDaemonMode, requestDaemonControl } from "../daemon-status.ts";
import { openDraftPr, takePatch } from "../patch-pr.ts";
import { requireOwner } from "./shared.ts";

function label(id: string): string {
  return id === CLAUDE_BRAIN ? "Claude" : (getBrain(id)?.label ?? `${id} (not loaded)`);
}

registerCommand("brain", {
  data: {
    ...new SlashCommandBuilder()
      .setName("brain")
      .setDescription("Who answers in this channel (owner only)")
      .addStringOption((o) =>
        o
          .setName("name")
          .setDescription("claude, or a loaded brain — omit to see what answers here")
          .setAutocomplete(true)
      )
      .addBooleanOption((o) =>
        o
          .setName("threads")
          .setDescription("Server channels: open a thread for each @mention (default on)")
      )
      .toJSON(),
    // Usable in group DMs (user install), so /choomfie there can be pointed at a brain.
    ...ANYWHERE,
  },
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
    const parentId = parentChannelId(interaction.channel);
    const current = resolveBrainId(channelId, parentId, (id) => ctx.config.getChannelBrain(id));
    const reply = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
    const wantedRaw = interaction.options.getString("name");
    const threads = interaction.options.getBoolean("threads");

    if (threads !== null) {
      if (!interaction.guildId || interaction.channel?.type !== ChannelType.GuildText) {
        await reply("Threads are for server text channels — DMs and threads are already one chat each.");
        return;
      }
      ctx.config.setAutoThread(channelId, threads);
      if (!wantedRaw) {
        await reply(
          threads
            ? "An @mention here now opens a thread, with its own chat."
            : "I'll answer @mentions here inline, without opening a thread."
        );
        return;
      }
    }

    if (!wantedRaw) {
      const own = ctx.config.getChannelBrain(channelId);
      const source = own
        ? "set on this channel"
        : parentId && ctx.config.getChannelBrain(parentId)
          ? "inherited from the parent channel"
          : "default";
      const threadNote =
        interaction.guildId && interaction.channel?.type === ChannelType.GuildText
          ? ctx.config.getAutoThread(channelId)
            ? "@mentions here open a thread (`/brain threads:false` to answer inline)."
            : "@mentions here are answered inline (`/brain threads:true` for threads)."
          : "";
      const lines = [
        `**${label(current)}** answers here (${source}).`,
        threadNote,
        current === CLAUDE_BRAIN
          ? ""
          : ctx.config.getBrainAccess() === "owner"
            ? `It answers you; others on your allowlist get Claude. To let them use ${label(current)} too: \`/config setting:brainAccess value:allowlist\``
            : `It answers everyone on your allowlist. To keep it to yourself: \`/config setting:brainAccess value:owner\``,
        `Loaded brains: ${listBrainIds().map((b) => `\`${b}\``).join(", ")} · \`/brain <name>\` to switch`,
      ].filter(Boolean);
      await reply(lines.join("\n"));
      return;
    }

    const wanted = wantedRaw.trim().toLowerCase();
    if (wanted !== CLAUDE_BRAIN && !getBrain(wanted)) {
      await reply(`No brain called \`${wanted}\` is loaded. Available: ${listBrainIds().map((b) => `\`${b}\``).join(", ")}.`);
      return;
    }
    // `claude` clears the override, so a thread falls back to its parent again.
    ctx.config.setChannelBrain(channelId, wanted === CLAUDE_BRAIN ? undefined : wanted);
    const now = resolveBrainId(channelId, parentId, (id) => ctx.config.getChannelBrain(id));
    const name = label(now);
    await interaction.reply(
      now === CLAUDE_BRAIN
        ? "This channel is answered by **Claude**."
        : ctx.config.getBrainAccess() === "owner"
          ? `**${name}** answers you in this channel. Others on your allowlist get Claude. ` +
            `To let them use ${name} too: \`/config setting:brainAccess value:allowlist\``
          : `**${name}** answers everyone on your allowlist in this channel. ` +
            "To keep it to yourself: `/config setting:brainAccess value:owner`"
    );
  },
});

// /stop — interrupt whoever is answering in this channel.
registerCommand("stop", {
  data: {
    ...new SlashCommandBuilder()
      .setName("stop")
      .setDescription("Interrupt the reply in progress in this channel (owner only)")
      .toJSON(),
    ...ANYWHERE,
  },
  handler: async (interaction, ctx) => {
    if (await requireOwner(interaction, ctx)) return;
    const channelId = interaction.channelId;
    const current = resolveBrainId(channelId, parentChannelId(interaction.channel), (id) =>
      ctx.config.getChannelBrain(id)
    );
    if (current === CLAUDE_BRAIN) {
      // Only the daemon owns a Claude session it can interrupt. In foreground
      // the session is a terminal Claude Code window, which nothing outside it
      // can press Esc in.
      if (!(await isDaemonMode(ctx.DATA_DIR))) {
        await interaction.reply({
          content: "Claude can only be interrupted from Discord in daemon mode (`choomfie --daemon`). In the terminal, press Esc.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await requestDaemonControl(ctx.DATA_DIR, "stop", { requestedBy: interaction.user.id, location: channelId });
      onReplySent(channelId); // the interrupted turn won't reply, so stop typing now
      await settleAskRelays(channelId, "⏹️ Stopped.");
      await interaction.reply({ content: "Asked **Claude** to stop.", flags: MessageFlags.Ephemeral });
      return;
    }
    const brain = getBrain(current);
    if (!brain?.stop) {
      await interaction.reply({
        content: brain ? `**${brain.label}** can't be stopped from here.` : `The \`${current}\` brain isn't loaded right now.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const stopped = await brain.stop(channelId);
      await interaction.editReply(stopped ? `Asked **${brain.label}** to stop.` : "Nothing is running here.");
    } catch (e) {
      await interaction.editReply(`Couldn't stop **${brain.label}**: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
});

// Quick-reply buttons on a brain's answer. Same gate as typing a message to
// that brain: owner, or anyone allowlisted when brainAccess is "allowlist".
registerButtonHandler("brain", async (interaction, parts, ctx) => {
  if (parts[1] === "approval") return handleApproval(interaction, parts[2] === "yes", ctx);
  if (parts[1] === "pr") return handlePatchPr(interaction, ctx);
  if (parts[1] === "task") return handleTask(interaction, Number(parts[2]), ctx);
  if (parts[1] !== "choice") return;
  const userId = interaction.user.id;
  const owner = isOwner(ctx, userId);
  if (!owner && !(ctx.config.getBrainAccess() === "allowlist" && isAllowed(ctx, userId))) {
    await interaction.reply({ content: "Only the owner can answer this one~", flags: MessageFlags.Ephemeral });
    return;
  }
  const pending = takeChoices(interaction.message.id);
  const index = Number(parts[2]);
  const choice = pending?.choices[index];
  const brain = pending ? getBrain(pending.brainId) : undefined;
  // In a chat the bot isn't in (a group DM /choomfie), answer through the button's own interaction.
  const absent = botIsAbsent(interaction);
  if (!pending || choice === undefined || !brain || (!absent && !interaction.channel)) {
    await interaction.reply({ content: "Those options have expired — just type your answer.", flags: MessageFlags.Ephemeral });
    return;
  }

  // Freeze the buttons, highlighting the pick, so nobody answers twice.
  const rows = interaction.message.components.map((row) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      (row as unknown as { components: { customId?: string; label?: string }[] }).components.map((c) =>
        new ButtonBuilder()
          .setCustomId(c.customId ?? `brain:done:${Math.random()}`)
          .setLabel(c.label ?? "…")
          .setStyle(c.customId === `brain:choice:${index}` ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(true)
      )
    )
  );
  await interaction.update({ components: rows });

  let channel: SendableChannel;
  if (absent) {
    const relay = interactionChannel(interaction, {
      first: "followUp",
      ephemeral: interaction.message.flags.has(MessageFlags.Ephemeral),
      replyButton: true,
    });
    rememberBrainRelay(pending.chatKey, relay);
    channel = relay;
  } else {
    channel = interaction.channel as unknown as SendableChannel;
    onMessageReceived(pending.chatKey, interaction.channel as never, false);
  }
  void dispatchToBrain(ctx, brain, channel, {
    chatKey: pending.chatKey,
    messageId: interaction.message.id,
    content: choice,
    meta: {
      chat_id: pending.chatKey,
      user: interaction.user.username,
      user_id: userId,
      role: owner ? "owner" : "user",
    },
    filePaths: [],
  });
});

type Ctx = Parameters<Parameters<typeof registerButtonHandler>[1]>[2];

/** The prompt a task's thread starts with: stands alone, since that chat has never seen the plan conversation. */
export function taskPrompt(task: { n: number; spec: string }, context?: string): string {
  return [`Task ${task.n} of a plan: ${task.spec}`, context].filter(Boolean).join("\n\n");
}

/**
 * A plan task's button: open a thread off the plan's channel, put a fresh
 * chat there in the task's mode, and send it the task. The button becomes a
 * link to the thread (⏳, then ✅ or ❌). Owner only — it starts real work.
 */
async function handleTask(interaction: ButtonInteraction, index: number, ctx: Ctx): Promise<void> {
  const ephemeral = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
  if (!isOwner(ctx, interaction.user.id)) return void (await ephemeral("Only the owner can start plan tasks~"));
  const board = getTaskBoard(interaction.message.id);
  const task = board?.tasks[index];
  const brain = board ? getBrain(board.brainId) : undefined;
  if (!board || !task || !brain) return void (await ephemeral("These tasks expired (Choomfie restarted) — ask for the task list again."));
  if (board.states[index]?.kind !== "idle") return void (await ephemeral("That task is already running."));

  // Threads can't nest: from inside a thread, the task's thread goes in the parent channel.
  const here = interaction.channel as unknown as { isThread?: () => boolean; parent?: unknown } | null;
  const parent = (here?.isThread?.() ? here.parent : here) as
    | { type?: ChannelType; threads?: { create(o: { name: string }): Promise<unknown> } }
    | null
    | undefined;
  if (!interaction.guildId || parent?.type !== ChannelType.GuildText || !parent.threads) {
    return void (await ephemeral("Plan tasks run in threads, so they need a server text channel — not a DM."));
  }
  await interaction.deferUpdate();
  let thread: SendableChannel & { id: string; url: string; members?: { add(id: string): Promise<unknown> } };
  try {
    thread = (await parent.threads.create({ name: `${task.n} · ${task.mode} · ${task.title}`.slice(0, 100) })) as typeof thread;
  } catch (e) {
    await interaction.followUp({ content: `Couldn't open a thread: ${e instanceof Error ? e.message : e}`, flags: MessageFlags.Ephemeral });
    return;
  }
  await thread.members?.add(interaction.user.id).catch(() => {});
  ctx.config.setChannelBrain(thread.id, brain.id);
  ctx.chats.setMode(ctx.chats.start(thread.id, brain.id).id, task.mode);

  const show = (state: TaskBoard["states"][number]) => {
    board.states[index] = state;
    return interaction.message.edit({ components: taskBoardRows(board) }).catch(() => {});
  };
  await show({ kind: "running", url: thread.url });
  const prompt = taskPrompt(task, board.context);
  await thread.send({ content: `**Task ${task.n}** · \`${task.mode}\` mode\n${task.spec}`.slice(0, 2000), allowedMentions: { parse: [] } });
  onMessageReceived(thread.id, thread as never, false);
  const ok = await dispatchToBrain(ctx, brain, thread, {
    chatKey: thread.id,
    content: prompt,
    meta: { chat_id: thread.id, user: interaction.user.username, user_id: interaction.user.id, role: "owner" },
    filePaths: [],
  });
  await show({ kind: ok ? "done" : "failed", url: thread.url });
}

/**
 * "Open draft PR" under a patch. Owner only: it pushes a branch and opens a PR
 * as the owner's GitHub account.
 */
async function handlePatchPr(interaction: ButtonInteraction, ctx: Ctx): Promise<void> {
  if (!isOwner(ctx, interaction.user.id)) {
    await interaction.reply({ content: "Only the owner can open a PR from this~", flags: MessageFlags.Ephemeral });
    return;
  }
  const offer = takePatch(interaction.message.id);
  if (!offer) {
    await interaction.reply({ content: "This patch expired (Choomfie restarted) — ask for it again.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.update({ content: `${interaction.message.content}\n⏳ Opening a draft PR on **${offer.repo}**…`, components: [] });
  try {
    const opened = await openDraftPr(offer);
    await interaction.editReply({
      content:
        opened.kind === "pr"
          ? `📦 Patch for **${offer.repo}** → draft PR: ${opened.url}`
          : `📦 **${offer.repo}** didn't exist, so I created it (private) with this patch as the first commit: ${opened.url}`,
    });
  } catch (e) {
    await interaction.editReply({
      content: `📦 Patch for **${offer.repo}** — couldn't open a PR: ${(e instanceof Error ? e.message : String(e)).slice(0, 1500)}`,
    });
  }
}

/**
 * Approve/decline a brain's pending action. Owner-only regardless of
 * brainAccess: approving acts as the owner's account on the brain's side.
 */
async function handleApproval(
  interaction: ButtonInteraction,
  approve: boolean,
  ctx: Parameters<Parameters<typeof registerButtonHandler>[1]>[2]
): Promise<void> {
  if (!isOwner(ctx, interaction.user.id)) {
    await interaction.reply({ content: "Only the owner can approve this~", flags: MessageFlags.Ephemeral });
    return;
  }
  const pending = getPendingApproval(interaction.message.id);
  const brain = pending ? getBrain(pending.brainId) : undefined;
  if (!pending || !brain?.resolveApproval) {
    await interaction.reply({
      content: "This approval expired (Choomfie restarted) — approve or decline it in the app.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferUpdate();
  try {
    const status = await brain.resolveApproval(pending.chatKey, pending.approval.id, approve);
    clearPendingApproval(interaction.message.id);
    const embed = EmbedBuilder.from(interaction.message.embeds[0])
      .setColor(approve ? 0x57f287 : 0x99aab5)
      .setFooter({ text: `${approve ? "Approved" : "Declined"} by ${interaction.user.username} · ${status}` });
    await interaction.editReply({ embeds: [embed], components: [] });
  } catch (e) {
    await interaction.followUp({
      content: `Couldn't ${approve ? "approve" : "decline"}: ${e instanceof Error ? e.message : String(e)}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}
