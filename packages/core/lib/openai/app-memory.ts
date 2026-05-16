import { Database } from "bun:sqlite";
import { join } from "node:path";

export interface AppMemoryRow {
  app: string;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

interface Row {
  app: string;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

export class AppMemoryStore {
  private readonly db: Database;

  constructor(dataDir: string) {
    this.db = new Database(join(dataDir, "choomfie.db"), { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_memory (
        app TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (app, key)
      );
    `);
  }

  get(app: string, key: string): AppMemoryRow | null {
    return this.db
      .query("SELECT app, key, value, created_at, updated_at FROM app_memory WHERE app = ? AND key = ?")
      .get(app, key) as Row | null;
  }

  set(app: string, key: string, value: string): AppMemoryRow {
    this.db
      .query(`
        INSERT INTO app_memory (app, key, value, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(app, key) DO UPDATE SET
          value = excluded.value,
          updated_at = datetime('now')
      `)
      .run(app, key, value);

    const row = this.get(app, key);
    if (!row) throw new Error("Failed to write app memory");
    return row;
  }

  delete(app: string, key: string): boolean {
    const result = this.db
      .query("DELETE FROM app_memory WHERE app = ? AND key = ?")
      .run(app, key);
    return result.changes > 0;
  }

  close() {
    this.db.close();
  }
}
