/**
 * ask_brain: the tool face of askBrain (lib/ask-brain.ts). Claude hands a job
 * to another brain (Waymond's image generation, …) and gets its answer back as
 * text plus files saved on disk.
 *
 * Owner only, checked in code (`callerIsOwner`) as well as by the security
 * rules: a web brain acts as the owner's account.
 */

import { join } from "node:path";
import { askBrain, AskBrainError, type AskBrainResult } from "../ask-brain.ts";
import { callerIsOwner } from "../caller.ts";
import type { ToolDef } from "../types.ts";
import { err, text } from "../types.ts";

/** The whole call, including results the brain finishes in the background. Under the worker's 50 min limit for this tool. */
export const ASK_BRAIN_WAIT_MS = 48 * 60_000;

function describe(r: AskBrainResult, brainId: string): string {
  const lines = [`${r.label} answered:`, "", r.text || "(no text)"];
  if (r.files.length) lines.push("", "Files:", ...r.files.map((p) => `- ${p}`));
  if (r.choices.length) lines.push("", `It offered: ${r.choices.join(" | ")} (answer with ask_brain again)`);
  if (r.approvals.length) lines.push("", `It wants approval for: ${r.approvals.join(", ")}; the owner approves in a /brain ${brainId} chat.`);
  if (r.stillWorking) lines.push("", `${r.label} is still working; the rest will be posted in the conversation when it lands.`);
  if (r.stopped) lines.push("", "(stopped before finishing)");
  return lines.join("\n");
}

export const brainTools: ToolDef[] = [
  {
    definition: {
      name: "ask_brain",
      description:
        "Owner only. Send a prompt (and optional files) to another brain, e.g. Waymond (it can generate images), and get its answer back: text plus the files it made, saved to disk. Waits for the answer, including work it finishes in the background (up to 48 min). Use for things only that brain can do, like image generation; not for chat.",
      inputSchema: {
        type: "object" as const,
        properties: {
          brain: { type: "string", description: 'Brain id, e.g. "waymond"' },
          prompt: { type: "string", description: "What to ask. Self-contained: the brain doesn't see this conversation." },
          chat_id: { type: "string", description: "The Discord chat you're answering in." },
          conversation: {
            type: "string",
            description:
              "Channel or thread id of the brain's conversation to continue (default: chat_id). Use the thread where the owner worked with that brain, so it keeps that context. Its status line shows there.",
          },
          files: { type: "array", items: { type: "string" }, description: "Absolute paths of files to send (reference images, …)" },
          save_to: { type: "string", description: "Absolute folder for the files the brain hands back (default: a new folder under the data dir)" },
        },
        required: ["brain", "prompt", "chat_id"],
      },
    },
    handler: async (args, ctx, caller = { via: "local" }) => {
      if (!callerIsOwner(caller, args)) return err("ask_brain is owner only, and the latest message in this chat isn't from the owner.");
      const to = String(args.brain ?? "");
      const chatId = String(args.chat_id ?? "");
      if (!chatId) return err("chat_id is required");
      try {
        const result = await askBrain(
          {
            to,
            prompt: String(args.prompt ?? ""),
            conversation: args.conversation ? String(args.conversation) : chatId,
            files: Array.isArray(args.files) ? args.files.map(String) : [],
            saveTo: args.save_to
              ? String(args.save_to)
              : join(ctx.DATA_DIR, "brain-files", to, new Date().toISOString().replace(/[:.]/g, "-")),
            from: "Claude (ask_brain)",
            waitMs: ASK_BRAIN_WAIT_MS,
          },
          ctx
        );
        return text(describe(result, to));
      } catch (e) {
        if (e instanceof AskBrainError) return err(e.message);
        throw e;
      }
    },
  },
];
