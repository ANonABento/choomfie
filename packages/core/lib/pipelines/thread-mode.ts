/**
 * A thread put on a pipeline (`/pipeline <name>`): its brain, Claude or
 * another, is told once per chat what the thread is for and which tool runs
 * it. Nothing is added anywhere else, so chats that never use a pipeline pay
 * nothing for it (the tool itself is deferred: only its name is listed).
 *
 * Told again when the thread starts a new chat (`/new`, `/resume`), since that
 * session hasn't seen it.
 */

import type { PipelineConfig } from "./config.ts";
import type { AppContext } from "../types.ts";

export function pipelineNoteText(p: PipelineConfig): string {
  return (
    `[From Choomfie (not the user): this thread drives the ${p.name} pipeline${p.about ? `. ${p.about}` : ""} ` +
    `Requests here go through the \`pipeline\` tool (action "run", pipeline "${p.name}", this chat's chat_id); ` +
    `follow each result's next step, and show the user its pictures and choices before going on.]`
  );
}

/** The note for this location's chat if it's on a pipeline and this chat hasn't been told. Marks it told. */
export function pipelineNote(ctx: AppContext, location: string, chatId: string): string | undefined {
  const at = ctx.chats.pipelineAt(location);
  if (!at || at.toldChat === chatId) return undefined;
  const p = ctx.config.getPipelines().get(at.pipeline);
  if (!p) return undefined;
  ctx.chats.markPipelineTold(location, chatId);
  return pipelineNoteText(p);
}
