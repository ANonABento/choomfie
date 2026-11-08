/**
 * ask_brain — Claude hands a job to another brain (Waymond, …) and gets its
 * answer back as text plus files saved on disk.
 *
 * The brain runs exactly as it does for a `/brain` channel: same conversation
 * per (chat, brain), same status line in the chat while it works. The only
 * difference is who reads the answer: Claude, not the channel. Files the brain
 * hands back (generated images, renders) are written to `save_to` or a fresh
 * folder under `<data dir>/brain-files/`, and their paths returned, so Claude
 * can look at them, post them, or pass them to a local tool.
 *
 * Owner-only by the security allowlist (it isn't on the role="user" list): a
 * web brain acts as the owner's account.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { getBrain, listBrainIds, CLAUDE_BRAIN } from "@choomfie/shared";
import type { ToolDef } from "../types.ts";
import { err, text } from "../types.ts";

/** A file name that can't climb out of the folder it's written to. */
function safeName(name: string, i: number): string {
  const base = basename(name).replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "");
  return base || `file-${i + 1}`;
}

export const brainTools: ToolDef[] = [
  {
    definition: {
      name: "ask_brain",
      description:
        "Owner only. Send a prompt (and optional files) to another brain, e.g. Waymond (it can generate images), and get its answer back: text plus the files it made, saved to disk. Waits for the answer (up to 50 min). The brain's status line shows in chat_id while it works. Use for things only that brain can do, like image generation; not for chat.",
      inputSchema: {
        type: "object" as const,
        properties: {
          brain: { type: "string", description: "Brain id, e.g. \"waymond\"" },
          prompt: { type: "string", description: "What to ask. Self-contained: the brain doesn't see this conversation." },
          chat_id: {
            type: "string",
            description: "The Discord chat you're answering in. The brain keeps one conversation per chat, so follow-ups continue it.",
          },
          files: { type: "array", items: { type: "string" }, description: "Absolute paths of files to send (reference images, …)" },
          save_to: { type: "string", description: "Absolute folder for the files the brain hands back (default: a new folder under the data dir)" },
        },
        required: ["brain", "prompt", "chat_id"],
      },
    },
    handler: async (args, ctx) => {
      const id = String(args.brain ?? "");
      const prompt = String(args.prompt ?? "");
      const chatId = String(args.chat_id ?? "");
      const files = Array.isArray(args.files) ? args.files.map(String) : [];
      if (!prompt.trim()) return err("prompt is empty");
      if (!chatId) return err("chat_id is required");
      const brain = id === CLAUDE_BRAIN ? undefined : getBrain(id);
      if (!brain) {
        const others = listBrainIds().filter((b) => b !== CLAUDE_BRAIN);
        return err(`no brain "${id}" loaded${others.length ? ` (loaded: ${others.join(", ")})` : " (none loaded)"}`);
      }
      for (const f of files) {
        if (!isAbsolute(f) || !existsSync(f)) return err(`file not found (absolute path needed): ${f}`);
      }
      const saveTo = args.save_to ? String(args.save_to) : join(ctx.DATA_DIR, "brain-files", id, new Date().toISOString().replace(/[:.]/g, "-"));
      if (!isAbsolute(saveTo)) return err("save_to must be an absolute path");

      const reply = await brain.send(
        { chatKey: chatId, content: prompt, filePaths: files, meta: { chat_id: chatId, user: "Claude (ask_brain)", role: "owner" } },
        ctx
      );

      const saved: string[] = [];
      if (reply.files?.length) {
        mkdirSync(saveTo, { recursive: true });
        reply.files.forEach((f, i) => {
          let path = join(saveTo, safeName(f.name, i));
          if (saved.includes(path)) path = join(saveTo, `${i + 1}-${safeName(f.name, i)}`);
          writeFileSync(path, f.data);
          saved.push(path);
        });
      }

      const lines = [`${brain.label} answered:`, "", reply.text || "(no text)"];
      if (saved.length) lines.push("", "Files:", ...saved.map((p) => `- ${p}`));
      if (reply.choices?.length) lines.push("", `It offered: ${reply.choices.join(" | ")} (answer with ask_brain again)`);
      if (reply.approvals?.length) lines.push("", `It wants approval for: ${reply.approvals.map((a) => a.title).join(", ")}; the owner approves in a /brain ${id} chat.`);
      if (reply.background) lines.push("", `${brain.label} is still working; the rest will be posted in the chat when it lands.`);
      if (reply.stopped) lines.push("", "(stopped before finishing)");
      return text(lines.join("\n"));
    },
  },
];
