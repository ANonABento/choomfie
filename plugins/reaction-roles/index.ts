import {
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type Client,
  type Role,
} from "discord.js";
import type { Plugin, PluginContext } from "@choomfie/shared";
import { errorMessage, registerCommand } from "@choomfie/shared";
import { ReactionRoleDB } from "./db.ts";
import {
  type ReactionEmoji,
  emojiKeyFromInput,
  emojiKeyFromReaction,
} from "./emoji.ts";

type ReactionRoleAction = "add" | "remove";
type ReactionRoleStore = Pick<ReactionRoleDB, "get">;

interface ReactionRoleMember {
  roles: {
    add(roleId: string, reason?: string): Promise<unknown>;
    remove(roleId: string, reason?: string): Promise<unknown>;
  };
}

interface ReactionRoleGuild {
  id: string;
  members: {
    fetch(userId: string): Promise<ReactionRoleMember>;
  };
}

interface ReactionRoleEvent {
  partial: boolean;
  fetch?: () => Promise<ReactionRoleEvent>;
  emoji: ReactionEmoji;
  message: {
    id?: string | null;
    channelId?: string | null;
    guild?: ReactionRoleGuild | null;
    guildId?: string | null;
    client?: {
      guilds: {
        fetch(guildId: string): Promise<ReactionRoleGuild | null>;
      };
    };
  };
}

interface ReactionRoleUser {
  partial: boolean;
  fetch?: () => Promise<ReactionRoleUser>;
  bot?: boolean;
  id: string;
}

type ReactionRoleContext = {
  guild: ReactionRoleGuild;
  channelId: string;
  messageId: string;
  emojiKey: string;
};
type ReactionRoleHandler = (
  reaction: ReactionRoleEvent,
  user: ReactionRoleUser
) => Promise<void>;
type ReactionRoleReasonByAction = Record<ReactionRoleAction, string>;

const REACTION_ROLE_REASONS: ReactionRoleReasonByAction = {
  add: "Reaction role added",
  remove: "Reaction role removed",
};

let db: ReactionRoleDB | null = null;
let reactionAddHandler: ReactionRoleHandler | null = null;
let reactionRemoveHandler: ReactionRoleHandler | null = null;
let discordClient: Client | null = null;

registerCommand("reactionrole", {
  data: new SlashCommandBuilder()
    .setName("reactionrole")
    .setDescription("Configure reaction role mappings")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("Assign a role when users react with an emoji")
        .addStringOption((option) =>
          option
            .setName("message_id")
            .setDescription("Message ID to watch in this channel")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("emoji")
            .setDescription("Emoji to watch, such as ✅ or <:name:id>")
            .setRequired(true)
        )
        .addRoleOption((option) =>
          option
            .setName("role")
            .setDescription("Role to assign")
            .setRequired(true)
        )
    )
    .toJSON(),
  handler: async (interaction, ctx) => {
    const replyEphemeral = async (content: string): Promise<void> => {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    };

    if (!interaction.guild || !interaction.channel) {
      await replyEphemeral("Reaction roles can only be configured in a server channel.");
      return;
    }

    if (!ctx.ownerUserId || interaction.user.id !== ctx.ownerUserId) {
      await replyEphemeral("Only the Choomfie owner can configure reaction roles.");
      return;
    }

    if (!db) {
      await replyEphemeral("Reaction roles plugin is not initialized.");
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand !== "add") return;

    const messageId = interaction.options.getString("message_id", true);
    const emojiInput = interaction.options.getString("emoji", true).trim();
    const role = interaction.options.getRole("role", true) as Role;
    const emojiKey = emojiKeyFromInput(emojiInput);

    if (role.id === interaction.guild.id || role.managed) {
      await replyEphemeral("Choose a normal assignable server role.");
      return;
    }

    let botMember = interaction.guild.members.me;
    if (!botMember) {
      try {
        botMember = await interaction.guild.members.fetchMe();
      } catch {
        botMember = null;
      }
    }

    if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      await replyEphemeral(
        "I need the Manage Roles permission before I can assign reaction roles."
      );
      return;
    }

    if (!botMember.permissions.has(PermissionFlagsBits.AddReactions)) {
      await replyEphemeral(
        "I need the Add Reactions permission before I can validate emoji setup."
      );
      return;
    }

    if (botMember.roles.highest.comparePositionTo(role) <= 0) {
      await replyEphemeral(
        `Move my highest role above ${role} before using it for reaction roles.`
      );
      return;
    }

    const channel = interaction.channel;
    if (!channel.isTextBased() || !("messages" in channel)) {
      await replyEphemeral(
        "Run this command in the text channel that contains the target message."
      );
      return;
    }

    try {
      const message = await channel.messages.fetch(messageId);
      await message.react(emojiInput);
      db.upsert({
        guildId: interaction.guild.id,
        channelId: interaction.channelId,
        messageId,
        emojiKey,
        roleId: role.id,
      });
    } catch {
      await replyEphemeral(
        "I could not find that message in this channel or react with that emoji."
      );
      return;
    }

    await replyEphemeral(
      `Reaction role configured: ${emojiInput} on message \`${messageId}\` assigns ${role}.`
    );
  },
});

async function resolveReaction(
  reaction: ReactionRoleEvent
): Promise<ReactionRoleEvent> {
  try {
    if (reaction.partial && reaction.fetch) {
      return await reaction.fetch();
    }
    return reaction;
  } catch {
    return reaction;
  }
}

async function resolveUser(
  user: ReactionRoleUser
): Promise<ReactionRoleUser | null> {
  try {
    if (user.partial && user.fetch) {
      return await user.fetch();
    }
    return user;
  } catch {
    return null;
  }
}

async function resolveGuild(
  reaction: ReactionRoleEvent
): Promise<ReactionRoleGuild | null> {
  if (reaction.message.guild) return reaction.message.guild;

  const guildId = reaction.message.guildId;
  if (!guildId || !reaction.message.client) return null;

  try {
    return await reaction.message.client.guilds.fetch(guildId);
  } catch {
    return null;
  }
}

async function resolveReactionContext(
  reaction: ReactionRoleEvent
): Promise<ReactionRoleContext | null> {
  const resolvedReaction = await resolveReaction(reaction);
  const guild = await resolveGuild(resolvedReaction);
  if (!guild) return null;

  const message = resolvedReaction.message;
  const emojiKey = emojiKeyFromReaction(resolvedReaction);
  if (!message.id || !message.channelId || !emojiKey) return null;

  return {
    guild,
    channelId: message.channelId,
    messageId: message.id,
    emojiKey,
  };
}

async function handleReaction(
  reaction: ReactionRoleEvent,
  user: ReactionRoleUser,
  action: ReactionRoleAction
): Promise<void> {
  if (!db) return;
  await applyReactionRole(db, reaction, user, action);
}

export async function applyReactionRole(
  store: ReactionRoleStore,
  reaction: ReactionRoleEvent,
  user: ReactionRoleUser,
  action: ReactionRoleAction
): Promise<void> {
  const resolvedUser = await resolveUser(user);
  if (!resolvedUser || resolvedUser.bot) return;

  const reactionContext = await resolveReactionContext(reaction);
  if (!reactionContext) return;

  const mapping = store.get(
    reactionContext.guild.id,
    reactionContext.channelId,
    reactionContext.messageId,
    reactionContext.emojiKey
  );
  if (!mapping) return;

  try {
    const member = await reactionContext.guild.members.fetch(resolvedUser.id);
    if (action === "add") {
      await member.roles.add(mapping.roleId, REACTION_ROLE_REASONS.add);
    } else {
      await member.roles.remove(mapping.roleId, REACTION_ROLE_REASONS.remove);
    }
  } catch (e) {
    console.error(
      `Reaction roles: failed to ${action} role ${mapping.roleId}: ${errorMessage(e)}`
    );
  }
}

const reactionRolesPlugin: Plugin = {
  name: "reaction-roles",

  intents: [GatewayIntentBits.GuildMessageReactions],

  async init(ctx: PluginContext) {
    if (!ctx.discord) {
      console.error("Reaction roles: Discord unavailable, plugin disabled");
      return;
    }

    db = new ReactionRoleDB(`${ctx.DATA_DIR}/reaction-roles.db`);
    discordClient = ctx.discord;

    reactionAddHandler = (reaction, user) =>
      handleReaction(reaction, user, "add");
    reactionRemoveHandler = (reaction, user) =>
      handleReaction(reaction, user, "remove");

    ctx.discord.on(Events.MessageReactionAdd, reactionAddHandler);
    ctx.discord.on(Events.MessageReactionRemove, reactionRemoveHandler);
    console.error("Reaction roles plugin initialized");
  },

  async destroy() {
    if (discordClient && reactionAddHandler) {
      discordClient.off(Events.MessageReactionAdd, reactionAddHandler);
    }
    if (discordClient && reactionRemoveHandler) {
      discordClient.off(Events.MessageReactionRemove, reactionRemoveHandler);
    }
    reactionAddHandler = null;
    reactionRemoveHandler = null;
    discordClient = null;
    db?.close();
    db = null;
  },
};

export default reactionRolesPlugin;
