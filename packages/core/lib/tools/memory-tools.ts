/**
 * Memory tools — save, search, list, delete, conversation summary, stats.
 */

import type { ToolDef } from "../types.ts";
import { text } from "../types.ts";

export const memoryTools: ToolDef[] = [
  {
    definition: {
      name: "save_memory",
      description:
        "Save a fact to persistent memory. Proactively save user preferences, project context, and personal details. Core memories are always in context; archival are searchable long-term storage.",
      inputSchema: {
        type: "object" as const,
        properties: {
          key: {
            type: "string",
            description:
              "Memory key (e.g. 'user_name', 'favorite_language', 'current_project')",
          },
          value: {
            type: "string",
            description: "The information to remember",
          },
          type: {
            type: "string",
            enum: ["core", "archival"],
            description:
              "core = always in context, archival = searchable long-term storage",
          },
          tags: {
            type: "string",
            description: "Comma-separated tags (archival only)",
          },
        },
        required: ["key", "value"],
      },
    },
    handler: async (args, ctx) => {
      const memType = (args.type as string) || "core";
      if (memType === "archival") {
        ctx.memory.addArchival(
          `${args.key}: ${args.value}`,
          (args.tags as string) || ""
        );
      } else {
        ctx.memory.setCoreMemory(args.key as string, args.value as string);
      }
      return text(`Saved ${memType} memory: ${args.key}`);
    },
  },
  {
    definition: {
      name: "search_memory",
      description:
        "Search archival memory for past context, facts, or conversation history.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search term" },
          limit: { type: "number", description: "Max results (default 10)" },
        },
        required: ["query"],
      },
    },
    handler: async (args, ctx) => {
      const results = ctx.memory.searchArchival(
        args.query as string,
        (args.limit as number) || 10
      );
      if (results.length === 0) return text("No memories found.");
      const formatted = results
        .map((r) => `- ${r.content} [${r.tags}] (${r.createdAt})`)
        .join("\n");
      return text(formatted);
    },
  },
  {
    definition: {
      name: "list_memories",
      description:
        "List all core memories (always-loaded context about the user).",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    handler: async (_args, ctx) => {
      const core = ctx.memory.getCoreMemory();
      if (core.length === 0) return text("No core memories stored yet.");
      const formatted = core
        .map((m) => `- ${m.key}: ${m.value} (updated: ${m.updatedAt})`)
        .join("\n");
      return text(formatted);
    },
  },
  {
    definition: {
      name: "delete_memory",
      description: "Delete a core memory by key.",
      inputSchema: {
        type: "object" as const,
        properties: {
          key: { type: "string" },
        },
        required: ["key"],
      },
    },
    handler: async (args, ctx) => {
      ctx.memory.deleteCoreMemory(args.key as string);
      return text(`Deleted memory: ${args.key}`);
    },
  },
  {
    definition: {
      name: "save_conversation_summary",
      description:
        "Archive a conversation summary. Call after meaningful conversations to preserve context for future sessions.",
      inputSchema: {
        type: "object" as const,
        properties: {
          summary: {
            type: "string",
            description:
              "Brief summary of what was discussed, decided, or accomplished",
          },
          user: {
            type: "string",
            description: "Discord username of the conversation partner",
          },
          tags: {
            type: "string",
            description:
              "Comma-separated tags (e.g. 'coding, nextjs, debugging')",
          },
        },
        required: ["summary"],
      },
    },
    handler: async (args, ctx) => {
      const user = (args.user as string) || "unknown";
      const summary = args.summary as string;
      const tags = (args.tags as string) || "conversation";
      const timestamp = new Date().toISOString().split("T")[0];
      ctx.memory.addArchival(
        `[${timestamp}] Conversation with ${user}: ${summary}`,
        tags
      );
      return text(`Conversation summary saved to archival memory.`);
    },
  },
  {
    definition: {
      name: "memory_stats",
      description:
        "Get statistics about Choomfie's memory (counts, oldest/newest entries).",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    handler: async (_args, ctx) => {
      const stats = ctx.memory.getStats();
      const lines = [
        `Core memories: ${stats.coreCount}`,
        `Archival memories: ${stats.archivalCount}`,
        `Active reminders: ${stats.reminderCount}`,
        stats.oldestMemory ? `Oldest archival: ${stats.oldestMemory}` : null,
        stats.newestMemory ? `Newest archival: ${stats.newestMemory}` : null,
      ].filter(Boolean);
      return text(lines.join("\n"));
    },
  },
];
