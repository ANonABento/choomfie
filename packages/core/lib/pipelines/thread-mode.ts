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

/**
 * Worded for a brain that rightly ignores instructions it can't trace to the
 * user (Waymond did, to "From Choomfie (not the user)"): it says the owner set
 * this up and how, names the connector the tool is on (brains load connector
 * tools only when they look for one), and carries the chat_id, which a web
 * brain never sees.
 */
export function pipelineNoteText(p: PipelineConfig, chatId: string): string {
  return (
    `[Choomfie, the bot relaying this Discord thread: the owner ran /pipeline ${p.name} here, so requests in this thread are for ` +
    `the ${p.name} pipeline on their Mac.${p.about ? ` ${p.about}` : ""} Use the \`pipeline\` tool on the choomfie connector ` +
    `with action "run", pipeline "${p.name}" and chat_id "${chatId}"; follow each result's next step, and show the user its ` +
    `pictures and choices before going on.]`
  );
}

/** The note for this location's chat if it's on a pipeline and this chat hasn't been told. Marks it told. */
export function pipelineNote(ctx: AppContext, location: string, chatId: string): string | undefined {
  const at = ctx.chats.pipelineAt(location);
  if (!at || at.toldChat === chatId) return undefined;
  const p = ctx.config.getPipelines().get(at.pipeline);
  if (!p) return undefined;
  ctx.chats.markPipelineTold(location, chatId);
  return pipelineNoteText(p, location);
}
