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
 * (`brain:task:<n>`, owner only: runs the task in its own thread, in its mode),
 * a plan's review (`brain:review`, started by itself once every task landed)
 * and its merge (`brain:merge:<board>:<repo>`, owner only).
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
import { ANYWHERE, AUTOCOMPLETE_LIMIT, CLAUDE_BRAIN, getBrain, isDaemonOwnedProcess, listBrainIds } from "@choomfie/shared";
import { join } from "node:path";
import { botIsAbsent, interactionChannel, rememberBrainRelay, settleAskRelays } from "../ask-relay.ts";
import { registerButtonHandler, registerCommand } from "../register.ts";
import {
  appendTask,
  brainWorkIdle,
  clearPendingApproval,
  reviewable,
  dispatchToBrain,
  getPendingApproval,
  getTaskBoard,
  landingFor,
  setPlanTaskStarter,
  planTaskRepo,
  saveTaskBoards,
  takeLand,
  taskBoardRows,
  taskPrompt,
  type Landing,
  type TaskBoard,
  parentChannelId,
  resolveBrainId,
  takeChoices,
  type SendableChannel,
} from "../brain-router.ts";
import { isAllowed, isOwner } from "../access.ts";
import { onMessageReceived, onReplySent } from "../typing.ts";
import { isDaemonMode, requestDaemonControl, waitForClaudeIdle } from "../daemon-status.ts";
import { openDraftPr, takePatch } from "../patch-pr.ts";
import { bundlePlanBranch, landFiles, landPatch, openPlanBranch, planBranchNote, planFilesNote, planReadNote, type PlanBranch } from "../plan-branch.ts";
import { mergePlanPr, prepareReview } from "../plan-branch.ts";
import { claudeReviewer, reviewLoop, type ReviewState } from "../plan-review.ts";
import { pullRunningCheckout, restartWhenIdle } from "../self-update.ts";
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
      const asked = Date.now();
      await requestDaemonControl(ctx.DATA_DIR, "stop", { requestedBy: interaction.user.id, location: channelId });
      onReplySent(channelId); // the interrupted turn won't reply, so stop typing now
      await settleAskRelays(channelId, "⏹️ Stopped.");
      await interaction.reply({ content: "Stopping **Claude**…", flags: MessageFlags.Ephemeral });
      const idle = await waitForClaudeIdle(ctx.DATA_DIR, channelId, asked);
      await interaction
        .editReply(idle ? "⏹️ **Claude** stopped." : "Asked **Claude** to stop — it hasn't confirmed yet; `/status` shows whether it's still busy.")
        .catch(() => {});
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
  if (parts[1] === "landtask") return handleLandTask(interaction, ctx);
  if (parts[1] === "task") return handleTask(interaction, Number(parts[2]), ctx);
  if (parts[1] === "taskall") return handleTask(interaction, "all", ctx);
  if (parts[1] === "review") return handleReview(interaction, ctx);
  if (parts[1] === "merge") return handleMerge(interaction, parts[2], parts.slice(3).join(":"), ctx);
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
      chatKey: pending.chatKey,
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

/**
 * A plan task's button: open a thread off the plan's channel, put a fresh
 * chat there in the task's mode, and send it the task. The button becomes a
 * link to the thread (⏳, then ✅ or ❌). Owner only — it starts real work.
 */
async function handleTask(interaction: ButtonInteraction, which: number | "all", ctx: Ctx): Promise<void> {
  const ephemeral = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
  if (!isOwner(ctx, interaction.user.id)) return void (await ephemeral("Only the owner can start plan tasks~"));
  const boardId = interaction.message.id;
  const board = getTaskBoard(boardId);
  const brain = board ? getBrain(board.brainId) : undefined;
  if (!board || !brain) return void (await ephemeral("These tasks expired — ask for the task list again."));
  if (board.busy) return void (await ephemeral("Run all is already working through these — one at a time."));
  const runnable = (i: number) => board.states[i]?.kind === "idle" || board.states[i]?.kind === "failed";
  const indices = which === "all" ? board.states.flatMap((_, i) => (runnable(i) ? [i] : [])) : [which];
  if (!indices.length || indices.some((i) => !runnable(i) || !board.tasks[i])) {
    return void (await ephemeral("That task is already running."));
  }

  // Threads can't nest: from inside a thread, the task's thread goes in the parent channel.
  const here = interaction.channel as unknown as { isThread?: () => boolean; parent?: unknown } | null;
  const parent = (here?.isThread?.() ? here.parent : here) as
    | { type?: ChannelType; threads?: { create(o: { name: string }): Promise<unknown> } }
    | null
    | undefined;
  if (!interaction.guildId || parent?.type !== ChannelType.GuildText || !parent.threads) {
    return void (await ephemeral("Plan tasks run in threads, so they need a server text channel — not a DM."));
  }
  // Claim before the first await, so a double click can't start the same work twice:
  // Run all holds the whole board; one task holds itself.
  const claimed = indices;
  const before = claimed.map((i) => board.states[i]);
  board.busy = which === "all";
  if (which !== "all") board.states[which] = { kind: "running", url: interaction.message.url };
  /** Undo a claim that never turned into a running thread. */
  const release = (i: number) => {
    const s = board.states[i];
    if (s?.kind === "running" && s.url === interaction.message.url) board.states[i] = before[claimed.indexOf(i)] ?? { kind: "idle" };
  };
  const redraw = () => interaction.message.edit({ components: taskBoardRows(board) }).catch(() => {});

  const runOne = async (index: number): Promise<boolean> => {
    const ok = await runBoardTask(ctx, brain, board, index, parent, interaction.user, redraw);
    if (ok === null) {
      await interaction.followUp({ content: "Couldn't open a thread for that task.", flags: MessageFlags.Ephemeral }).catch(() => {});
      release(index);
      return false;
    }
    return ok;
  };

  try {
    await interaction.deferUpdate();
    // In order, one at a time: later tasks build on earlier ones. A failure stops the run.
    for (const i of claimed) if (!(await runOne(i))) break;
  } finally {
    claimed.forEach(release);
    board.busy = false;
    saveTaskBoards();
    await redraw();
  }
  // The last task landed: the plan reviews itself.
  if (reviewable(board)) void startReview(ctx, boardId, board, parent as ThreadParent, interaction.user, redraw);
}

type ThreadParent = { threads?: { create(o: { name: string }): Promise<unknown> } };

/**
 * One plan task in its own thread off `parent`; resolves when its answer is
 * posted (and committed, for a repo task). Null when the thread couldn't open.
 */
async function runBoardTask(
  ctx: Ctx,
  brain: NonNullable<ReturnType<typeof getBrain>>,
  board: TaskBoard,
  index: number,
  parent: ThreadParent,
  user: { username: string; id: string },
  redraw: () => Promise<unknown>
): Promise<boolean | null> {
  const task = board.tasks[index];
  let thread: SendableChannel & { id: string; url: string; members?: { add(id: string): Promise<unknown> } };
  try {
    thread = (await parent.threads!.create({ name: `${task.n} · ${task.mode} · ${task.title}`.slice(0, 100) })) as typeof thread;
  } catch (e) {
    console.error(`[tasks] couldn't open a thread: ${errorText(e)}`);
    return null;
  }
  await thread.members?.add(user.id).catch(() => {});
  ctx.config.setChannelBrain(thread.id, brain.id);
  ctx.chats.setMode(ctx.chats.start(thread.id, brain.id).id, task.mode);
  board.states[index] = { kind: "running", url: thread.url };
  board.threads = { ...board.threads, [thread.id]: index };
  saveTaskBoards();
  await redraw();
  await thread.send({ content: `**Task ${task.n}** · \`${task.mode}\` mode\n${task.spec}`.slice(0, 2000), allowedMentions: { parse: [] } });
  onMessageReceived(thread.id, thread as never, false);
  let ok = false;
  try {
    ok = await runTaskInThread(ctx, brain, board, index, thread, user);
  } catch (e) {
    await thread.send({ content: `❌ ${errorText(e).slice(0, 1500)}`, allowedMentions: { parse: [] } }).catch(() => {});
  }
  board.states[index] = { kind: ok ? "done" : "failed", url: thread.url };
  saveTaskBoards();
  await redraw();
  return ok;
}

/**
 * A plan's chat asked for one more job ("make the meshes stickerless"): it
 * joined the plan's board (the router added it), and runs like a clicked
 * task — its own thread, on the plan's branch — not in the planning chat.
 */
setPlanTaskStarter(async (ctx, boardId, index, user) => {
  const board = getTaskBoard(boardId);
  const brain = board ? getBrain(board.brainId) : undefined;
  if (!board || !brain || !board.channelId) return false;
  const where = await ctx.discord?.channels.fetch(board.channelId).catch(() => null);
  if (!where) return false;
  const w = where as unknown as { isThread?: () => boolean; parent?: unknown; messages?: { fetch(id: string): Promise<{ edit(o: unknown): Promise<unknown> }> } };
  const parent = (w.isThread?.() ? w.parent : w) as (ThreadParent & { type?: ChannelType }) | null;
  if (parent?.type !== ChannelType.GuildText || !parent.threads) return false;
  const msg = await w.messages?.fetch(boardId).catch(() => null);
  const redraw = () => msg?.edit({ components: taskBoardRows(board) }).catch(() => {}) ?? Promise.resolve();
  if (board.busy || board.states[index]?.kind === "running") return false;
  const ok = (await runBoardTask(ctx as Ctx, brain, board, index, parent, user, redraw)) === true;
  if (ok && reviewable(board)) void startReview(ctx as Ctx, boardId, board, parent, user, redraw);
  return ok;
});

/** Threads can't nest: a board in a thread gets its review thread in the parent channel. */
function threadParentOf(channel: unknown): (ThreadParent & { type?: ChannelType }) | null {
  const here = channel as { isThread?: () => boolean; parent?: unknown } | null;
  return ((here?.isThread?.() ? here.parent : here) ?? null) as (ThreadParent & { type?: ChannelType }) | null;
}

/** "🔎 Review" on a board whose tasks all landed: run the review loop now. */
async function handleReview(interaction: ButtonInteraction, ctx: Ctx): Promise<void> {
  const ephemeral = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
  if (!isOwner(ctx, interaction.user.id)) return void (await ephemeral("Only the owner can review a plan~"));
  const boardId = interaction.message.id;
  const board = getTaskBoard(boardId);
  if (!board) return void (await ephemeral("These tasks expired."));
  if (!reviewable(board)) return void (await ephemeral("Not yet: every task has to land first, and one review runs at a time."));
  const parent = threadParentOf(interaction.channel);
  if (parent?.type !== ChannelType.GuildText || !parent.threads) return void (await ephemeral("Reviews run in a thread, so they need a server text channel."));
  await interaction.deferUpdate();
  const redraw = () => interaction.message.edit({ components: taskBoardRows(board) }).catch(() => {});
  void startReview(ctx, boardId, board, parent, interaction.user, redraw);
}

/**
 * The review loop for each of the board's plan branches, in a thread of its
 * own: review → fix tasks on the board → review, until clean and CI passes
 * (a Merge button) or it needs the owner.
 */
async function startReview(
  ctx: Ctx,
  boardId: string,
  board: TaskBoard,
  parent: ThreadParent,
  user: { username: string; id: string },
  redraw: () => Promise<unknown>
): Promise<void> {
  const brain = getBrain(board.brainId);
  const fixMode = brain?.modes?.find((m) => m.repo)?.id;
  if (!brain || !fixMode || !reviewable(board)) return;
  for (const pb of Object.values(board.plans ?? {})) {
    // A branch with nothing on it (only research read it, or it's merged already): nothing to review, no thread.
    const prep = await prepareReview(pb).catch(() => null);
    if (prep && !("conflict" in prep) && !prep.diff.trim()) continue;
    const state: ReviewState = { status: "reviewing", round: 0 };
    board.reviews = { ...board.reviews, [pb.repo]: state };
    saveTaskBoards();
    await redraw();
    let thread: SendableChannel & { id: string; url: string; members?: { add(id: string): Promise<unknown> } };
    try {
      thread = (await parent.threads!.create({ name: `🔎 Review · ${pb.repo}`.slice(0, 100) })) as typeof thread;
    } catch (e) {
      console.error(`[review] couldn't open a thread: ${errorText(e)}`);
      state.status = "stuck";
      continue;
    }
    await thread.members?.add(user.id).catch(() => {});
    state.threadId = thread.id;
    state.threadUrl = thread.url;
    const say = (content: string, components?: unknown[]) =>
      thread.send({ content: content.slice(0, 2000), allowedMentions: { parse: [] }, ...(components ? { components } : {}) } as never).catch(() => {});
    await say(`Reviewing \`${pb.branch}\` of **${pb.repo}** against its rules and the plan's tasks${pb.prUrl ? ` · ${pb.prUrl}` : ""}.`);
    try {
      await reviewLoop(pb, board.tasks, state, {
        reviewer: claudeReviewer(ctx.config.getModel()),
        say: (content) => say(content),
        fixMode,
        save: () => {
          saveTaskBoards();
          void redraw();
        },
        runFix: async (task) => {
          const index = appendTask(board, task);
          await redraw();
          return (await runBoardTask(ctx, brain, board, index, parent, user, redraw)) === true;
        },
        offerMerge: (head, checks) =>
          say(
            `✅ **Ready to merge:** review clean, CI ${checks.kind === "none" ? "— this repo has none" : "passed"}. ` +
              `Merges \`${head.slice(0, 7)}\` (exactly what was reviewed) into the default branch. If this is Choomfie's own repo, it then updates and restarts itself once nothing is running.`,
            [
              new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(`brain:merge:${boardId}:${pb.repo}`).setLabel("Merge").setStyle(ButtonStyle.Success)
              ),
            ]
          ),
      });
    } catch (e) {
      state.status = "stuck";
      await say(`❌ The review stopped: ${errorText(e).slice(0, 1500)}`);
    }
    saveTaskBoards();
    await redraw();
  }
}

/** The Merge button under a clean review: merge exactly the reviewed head, then update and restart if it's Choomfie. */
async function handleMerge(interaction: ButtonInteraction, boardId: string, repo: string, ctx: Ctx): Promise<void> {
  const ephemeral = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
  if (!isOwner(ctx, interaction.user.id)) return void (await ephemeral("Only the owner can merge~"));
  const board = getTaskBoard(boardId);
  const pb = board?.plans?.[repo];
  const state = board?.reviews?.[repo];
  if (!board || !pb || !state) return void (await ephemeral("This plan expired."));
  if (state.status === "merged") return void (await ephemeral("Already merged."));
  if (state.status !== "ready" || !state.head) return void (await ephemeral("This review isn't ready to merge any more — review the plan again."));
  await interaction.update({ components: [] });
  const say = (content: string) => (interaction.channel as unknown as SendableChannel).send({ content: content.slice(0, 2000), allowedMentions: { parse: [] } }).catch(() => {});
  try {
    await mergePlanPr(pb, state.head);
  } catch (e) {
    state.status = "stuck";
    saveTaskBoards();
    await say(`❌ Couldn't merge: ${errorText(e).slice(0, 1500)}\nPress **🔎 Review** on the board to go again.`);
    return;
  }
  state.status = "merged";
  saveTaskBoards();
  await say(`🎉 Merged: ${pb.prUrl}`);
  const update = await pullRunningCheckout(pb.repo);
  if (update.kind === "skipped") return void (await say(`⚠️ Didn't update the running Choomfie: ${update.why}. Pull and restart it yourself.`));
  if (update.kind !== "pulled") return;
  const restarting = isDaemonOwnedProcess();
  await say(
    `⬇️ Updated the running Choomfie \`${update.from}\` → \`${update.to}\`.` +
      (restarting ? " Restarting once nothing is running (tasks, reviews, replies)…" : " Restart it to load the change (foreground mode can't restart itself).")
  );
  if (restarting) {
    const ok = await restartWhenIdle(ctx.DATA_DIR, interaction.channelId, brainWorkIdle);
    if (!ok) await say("⚠️ Still busy after 6 hours — restart it yourself.");
  }
}

/** The plan's branch on `repo`: saved, being opened, or opened now (once, however many tasks ask). */
async function planBranchFor(ctx: Ctx, board: TaskBoard, repo: string): Promise<PlanBranch> {
  const known = board.plans?.[repo];
  if (known) return known;
  board.opening ??= new Map();
  let opening = board.opening.get(repo);
  if (!opening) {
    opening = openPlanBranch(repo, join(ctx.DATA_DIR, "plans")).then((pb) => {
      board.plans = { ...board.plans, [repo]: pb };
      saveTaskBoards();
      return pb;
    });
    opening.catch(() => {}).finally(() => board.opening?.delete(repo));
    board.opening.set(repo, opening);
  }
  return opening;
}

/** Commit what a task handed back to its plan's branch, and say how it went in the thread. */
async function landTask(
  board: TaskBoard,
  index: number,
  pb: PlanBranch,
  landing: Landing,
  say: (content: string) => Promise<unknown>
): Promise<boolean> {
  const task = board.tasks[index];
  const title = `Task ${task.n}: ${task.title}`;
  try {
    const landed =
      landing.kind === "patch" ? await landPatch(pb, landing.files[0].data, title) : await landFiles(pb, landing.files, landing.folder, title);
    saveTaskBoards(); // prUrl
    await say(
      `🌿 Committed to \`${pb.branch}\`${landing.kind === "files" ? ` (${landing.folder}/)` : ""}: <${landed.commitUrl}>` +
        (landed.prOpened ? `\n📦 Draft PR for the whole plan: ${landed.prOpened}` : "") +
        (landed.prError ? `\n⚠️ Couldn't open the plan's PR (the commit is in): ${landed.prError.slice(0, 500)}` : "")
    );
    return true;
  } catch (e) {
    await say(`❌ Couldn't commit it to \`${pb.branch}\`: ${errorText(e).slice(0, 1500)}`);
    return false;
  }
}

/**
 * Send a task to its thread. A repo task (its mode works on a repo, and it or
 * its plan names one) works on the plan's branch: it gets the branch as a
 * bundle, and the patch it hands back is committed there — or the task fails,
 * here, so Run all stops before the next task builds on something missing.
 */
async function runTaskInThread(
  ctx: Ctx,
  brain: NonNullable<ReturnType<typeof getBrain>>,
  board: TaskBoard,
  index: number,
  thread: SendableChannel & { id: string },
  user: { username: string; id: string }
): Promise<boolean> {
  const task = board.tasks[index];
  const say = (content: string) => thread.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
  const message = {
    chatKey: thread.id,
    content: taskPrompt(task, board.context),
    meta: { chat_id: thread.id, user: user.username, user_id: user.id, role: "owner" },
    filePaths: [] as string[],
  };
  const mode = brain.modes?.find((m) => m.id === task.mode);
  const repo = planTaskRepo(board, index);
  if (!repo || !(mode?.repo || mode?.files || mode?.readsRepo)) {
    const reply = await dispatchToBrain(ctx, brain, thread, message);
    return !!reply && !reply.stopped;
  }

  let pb: PlanBranch;
  try {
    pb = await planBranchFor(ctx, board, repo);
  } catch (e) {
    await say(`❌ Couldn't set up a branch on **${repo}**: ${errorText(e).slice(0, 1500)}`);
    return false;
  }
  let bundle: Awaited<ReturnType<typeof bundlePlanBranch>>;
  try {
    bundle = await bundlePlanBranch(pb);
  } catch (e) {
    await say(`❌ Couldn't bundle \`${pb.branch}\`: ${errorText(e).slice(0, 1500)}`);
    return false;
  }
  try {
    const name = bundle.path.split("/").pop()!;
    const note = mode.repo
      ? planBranchNote(pb, name, bundle.snapshot)
      : mode.files
        ? planFilesNote(pb, name, mode.files)
        : planReadNote(pb, name);
    const caught = bundle.caughtUp;
    await say(
      `-# 🌿 works on \`${pb.branch}\` of **${pb.repo}**${pb.created ? " (new, private)" : ""}` +
        (mode.repo ? ` — attached as ${name}` : mode.files ? ` — its files go in ${mode.files}/` : ` — reads it (attached as ${name}); nothing is committed`) +
        (caught && "merged" in caught ? ` · brought in ${caught.merged} new commit${caught.merged === 1 ? "" : "s"} from \`${caught.base}\`` : "")
    );
    if (caught && "conflict" in caught) {
      await say(
        `⚠️ \`${caught.base}\` has changes that conflict with \`${pb.branch}\` (${caught.conflict.slice(0, 300)}), so this task works without them. ` +
          `Merge \`${caught.base}\` into the branch on GitHub to bring them in.`
      );
    }
    const reply = await dispatchToBrain(
      ctx,
      brain,
      thread,
      { ...message, content: `${message.content}\n\n${note}`, filePaths: [bundle.path] },
      { noPatchOffer: true }
    );
    if (!reply) return false;
    if (reply.stopped) {
      await say(`⏹ Stopped — nothing was committed to \`${pb.branch}\`.`);
      return false;
    }
    if (!mode.repo && !mode.files) {
      // Reads only: the answer is the result.
      if (reply.background) {
        await say(`⏳ ${brain.label} is still on it; its answer is posted here when it finishes. The next task waits for you to start it from the board.`);
        return false;
      }
      await say(`📄 Done — the report stays in ${brain.label}'s workspace; nothing is committed to \`${pb.branch}\`.`);
      return true;
    }
    const landing = landingFor(board, index, reply.files);
    if (!landing && reply.background) {
      await say(
        `⏳ ${brain.label} is still on it. When it finishes, its answer is posted here with a **Commit to the plan's branch** button; ` +
          `the next task waits for you to start it from the board.`
      );
      return false;
    }
    if (!landing) {
      const cut = /stopping after (several|\d+) tool calls/i.test(reply.text);
      await say(
        `❌ No ${mode.repo ? "patch" : "files"} came back${cut ? ` (${brain.label} kept hitting its tool limit)` : ""}, so nothing was committed to \`${pb.branch}\`. ` +
          `Reply here to carry on — what it sends then gets a commit button — or retry the task from the board.`
      );
      return false;
    }
    return await landTask(board, index, pb, landing, say);
  } finally {
    bundle.cleanup();
  }
}

/** "Commit to the plan's branch" under a patch sent in a task thread after the task ended. */
async function handleLandTask(interaction: ButtonInteraction, ctx: Ctx): Promise<void> {
  if (!isOwner(ctx, interaction.user.id)) {
    await interaction.reply({ content: "Only the owner can commit to a plan's branch~", flags: MessageFlags.Ephemeral });
    return;
  }
  const pending = takeLand(interaction.message.id);
  const board = pending && getTaskBoard(pending.boardId);
  const repo = pending && board ? planTaskRepo(board, pending.index) : undefined;
  if (!pending || !board || !repo) {
    await interaction.reply({ content: "This patch expired (Choomfie restarted) — ask for it again.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.update({ components: [] });
  const say = (content: string) => interaction.followUp({ content, allowedMentions: { parse: [] } }).catch(() => {});
  let ok = false;
  try {
    ok = await landTask(board, pending.index, await planBranchFor(ctx, board, repo), pending, say);
  } catch (e) {
    await say(`❌ Couldn't set up a branch on **${repo}**: ${errorText(e).slice(0, 1500)}`);
  }
  if (!ok) return;
  const state = board.states[pending.index];
  board.states[pending.index] = { kind: "done", url: state && state.kind !== "idle" ? state.url : interaction.message.url };
  saveTaskBoards();
  // Redraw the board, wherever it is.
  const channel = board.channelId ? await ctx.discord?.channels.fetch(board.channelId).catch(() => null) : null;
  const msg = channel && "messages" in channel ? await channel.messages.fetch(pending.boardId).catch(() => null) : null;
  await msg?.edit({ components: taskBoardRows(board) }).catch(() => {});
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
