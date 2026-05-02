import { Database } from "bun:sqlite";
import { nowUTC } from "@choomfie/shared";

export interface ReactionRole {
  guildId: string;
  channelId: string;
  messageId: string;
  emojiKey: string;
  roleId: string;
}

interface ReactionRoleRow {
  guild_id: string;
  channel_id: string;
  message_id: string;
  emoji_key: string;
  role_id: string;
}

export class ReactionRoleDB {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reaction_roles (
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        emoji_key TEXT NOT NULL,
        role_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, message_id, emoji_key)
      );

      CREATE INDEX IF NOT EXISTS idx_reaction_roles_lookup
        ON reaction_roles(guild_id, channel_id, message_id, emoji_key);
    `);
  }

  upsert(entry: ReactionRole): void {
    const now = nowUTC();
    this.db
      .query(
        `INSERT INTO reaction_roles
           (guild_id, channel_id, message_id, emoji_key, role_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(guild_id, message_id, emoji_key) DO UPDATE SET
           channel_id = excluded.channel_id,
           role_id = excluded.role_id,
           updated_at = excluded.updated_at`
      )
      .run(
        entry.guildId,
        entry.channelId,
        entry.messageId,
        entry.emojiKey,
        entry.roleId,
        now,
        now
      );
  }

  get(
    guildId: string,
    channelId: string,
    messageId: string,
    emojiKey: string
  ): ReactionRole | null {
    const row = this.db
      .query(
        `SELECT guild_id, channel_id, message_id, emoji_key, role_id
         FROM reaction_roles
         WHERE guild_id = ? AND channel_id = ? AND message_id = ? AND emoji_key = ?`
      )
      .get(guildId, channelId, messageId, emojiKey) as ReactionRoleRow | null;

    return row ? rowToReactionRole(row) : null;
  }

  close(): void {
    this.db.close();
  }
}

function rowToReactionRole(row: ReactionRoleRow): ReactionRole {
  return {
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    emojiKey: row.emoji_key,
    roleId: row.role_id,
  };
}
