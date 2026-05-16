import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

export const ResponsesRequestSchema = z.object({
  model: z.string().optional(),
  input: z.union([z.string(), z.array(z.unknown())]),
  previous_response_id: z.string().optional(),
  stream: z.boolean().optional(),
}).passthrough();

export type ResponsesRequest = z.infer<typeof ResponsesRequestSchema>;

interface ResponseRow {
  id: string;
  response_json: string;
  input_json: string;
  previous_response_id: string | null;
  created_at: number;
  expires_at: number;
}

export class ResponseStore {
  private readonly db: Database;

  constructor(dataDir: string) {
    this.db = new Database(join(dataDir, "choomfie.db"), { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS openai_responses (
        id TEXT PRIMARY KEY,
        response_json TEXT NOT NULL,
        input_json TEXT NOT NULL,
        previous_response_id TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    this.ensureColumn("previous_response_id", "TEXT");
    this.ensureColumn("expires_at", "INTEGER NOT NULL DEFAULT 0");
  }

  save(
    response: Record<string, unknown>,
    input: unknown,
    options: { previousResponseId?: string | null; ttlDays: number },
  ): Record<string, unknown> {
    const id = response.id;
    if (typeof id !== "string") throw new Error("Response id is required");
    const createdAt = typeof response.created_at === "number"
      ? response.created_at
      : Math.floor(Date.now() / 1000);
    const expiresAt = createdAt + options.ttlDays * 24 * 60 * 60;
    this.db
      .query(`
        INSERT INTO openai_responses (id, response_json, input_json, previous_response_id, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        JSON.stringify(response),
        JSON.stringify(input),
        options.previousResponseId ?? null,
        createdAt,
        expiresAt,
      );
    return response;
  }

  get(id: string): Record<string, unknown> | null {
    this.cleanupExpired();
    const row = this.row(id);
    return row ? JSON.parse(row.response_json) as Record<string, unknown> : null;
  }

  inputItems(id: string): Record<string, unknown> | null {
    this.cleanupExpired();
    const row = this.row(id);
    if (!row) return null;
    const input = JSON.parse(row.input_json) as unknown;
    return {
      object: "list",
      data: Array.isArray(input)
        ? input.map((item, index) => ({ id: `input_${index}`, object: "response.input_item", content: item }))
        : [{ id: "input_0", object: "response.input_item", content: input }],
    };
  }

  delete(id: string): boolean {
    const result = this.db.query("DELETE FROM openai_responses WHERE id = ?").run(id);
    return result.changes > 0;
  }

  contextMessages(id: string): Array<{ role: "user" | "assistant"; content: string }> {
    this.cleanupExpired();
    const chain: ResponseRow[] = [];
    let currentId: string | null = id;
    const seen = new Set<string>();

    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const row = this.row(currentId);
      if (!row) break;
      chain.unshift(row);
      currentId = row.previous_response_id;
    }

    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const row of chain) {
      messages.push({ role: "user", content: responseInputToText(JSON.parse(row.input_json) as ResponsesRequest["input"]) });
      const assistant = responseOutputText(JSON.parse(row.response_json) as Record<string, unknown>);
      if (assistant) messages.push({ role: "assistant", content: assistant });
    }
    return messages;
  }

  cleanupExpired(now = Math.floor(Date.now() / 1000)): number {
    const result = this.db
      .query("DELETE FROM openai_responses WHERE expires_at > 0 AND expires_at <= ?")
      .run(now);
    return result.changes;
  }

  close() {
    this.db.close();
  }

  private row(id: string): ResponseRow | null {
    if (!/^resp_[A-Za-z0-9_-]+$/.test(id)) return null;
    return this.db
      .query("SELECT id, response_json, input_json, previous_response_id, created_at, expires_at FROM openai_responses WHERE id = ?")
      .get(id) as ResponseRow | null;
  }

  private ensureColumn(name: string, definition: string) {
    const columns = this.db.query("PRAGMA table_info(openai_responses)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`ALTER TABLE openai_responses ADD COLUMN ${name} ${definition}`);
    }
  }
}

export function createResponseObject(
  model: string,
  text: string,
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {},
) {
  const createdAt = Math.floor(Date.now() / 1000);
  return {
    id: `resp_${randomBytes(12).toString("base64url")}`,
    object: "response",
    created_at: createdAt,
    status: "completed",
    model,
    previous_response_id: null,
    output: [
      {
        id: `msg_${randomBytes(12).toString("base64url")}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text,
          },
        ],
      },
    ],
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)),
    },
  };
}

export function responseInputToText(input: ResponsesRequest["input"]): string {
  if (typeof input === "string") return input;
  return JSON.stringify(input);
}

export function responseOutputText(response: Record<string, unknown>): string {
  const output = response.output;
  if (!Array.isArray(output)) return "";
  const texts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const record = part as Record<string, unknown>;
      if (record.type === "output_text" && typeof record.text === "string") {
        texts.push(record.text);
      }
    }
  }
  return texts.join("\n");
}
