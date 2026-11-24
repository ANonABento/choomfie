/**
 * `defineApiBrain(member)` — one API provider as a Choomfie brain
 * (`/brain groq`). Also exports `apiTurn`, the turn itself, which the free
 * router uses for every API target so both paths build prompts the same way.
 */

import { framePrompt, type Brain, type BrainReply, type PluginContext } from "@choomfie/shared";
import { maybeCompact, SUMMARY_PROMPT } from "./compact.ts";
import { buildMessages, stripSpeakerLabel, systemPrompt, userContent, type Persona, type UserContent } from "./context.ts";
import type { ApiMember, Completion } from "./member.ts";
import type { Transcript } from "./transcript.ts";

export interface ApiTurnInput {
  member: ApiMember;
  model?: string;
  transcript: Transcript;
  chatId: string;
  system: string;
  current: UserContent;
  signal?: AbortSignal;
  /** Override the member's own input budget. */
  budget?: number;
  /** Who the model speaks as: a leading "Name:" label is cut from the reply. */
  persona?: Persona;
}

/** One answer from one API member, with the chat's history to its budget. Records nothing. */
export async function apiTurn(input: ApiTurnInput): Promise<Completion & { tokens: number }> {
  const built = buildMessages({
    system: input.system,
    summary: input.transcript.summary(input.chatId),
    history: input.transcript.live(input.chatId),
    current: input.current,
    budget: input.budget ?? input.member.contextTokens,
  });
  const r = await input.member.complete(built.messages, { model: input.model, signal: input.signal, tokens: built.tokens, purpose: "answer", chatId: input.chatId });
  return { ...r, text: stripSpeakerLabel(r.text, input.persona), tokens: built.tokens };
}

/** Summarize with a member (cheap, short). */
export function summarizer(member: ApiMember): (text: string) => Promise<string> {
  return async (text) =>
    (
      await member.complete(
        [
          { role: "system", content: SUMMARY_PROMPT },
          { role: "user", content: text },
        ],
        { maxTokens: 600, temperature: 0.2, timeoutMs: 60_000, purpose: "summary" }
      )
    ).text;
}

/** The active persona, if the host offers one. */
export function personaOf(ctx: PluginContext): Persona | undefined {
  return ctx.config.getActivePersona?.();
}

export interface ApiBrainDeps {
  transcript: Transcript;
}

export function defineApiBrain(member: ApiMember, deps: ApiBrainDeps): (ctx: PluginContext) => Brain {
  return (ctx) => {
    const chats = ctx.chats;
    if (!chats) throw new Error(`${member.label} needs Choomfie's chat store (ctx.chats)`);
    const running = new Map<string, AbortController>();

    return {
      id: member.id,
      label: member.label,

      async send(message): Promise<BrainReply> {
        const chat = chats.current(message.chatKey, member.id, message.content);
        await member.ready();
        // The chat's `/model`, while the provider still lists it; otherwise its models in order.
        const model = chat.model && member.models().includes(chat.model) ? chat.model : undefined;
        const current = userContent(framePrompt(message.content, message.meta), message.filePaths, member.vision(model));
        const abort = new AbortController();
        running.set(message.chatKey, abort);
        try {
          const persona = personaOf(ctx);
          const r = await apiTurn({ member, model, transcript: deps.transcript, chatId: chat.id, system: systemPrompt(persona), persona, current, signal: abort.signal });
          deps.transcript.add(chat.id, "user", current.record);
          deps.transcript.add(chat.id, "assistant", r.text, member.id, r.model);
          void maybeCompact({ transcript: deps.transcript, chatId: chat.id, budget: member.contextTokens, summarize: summarizer(member) });
          return { text: r.text || `(${member.label} sent an empty reply)` };
        } catch (e) {
          if (abort.signal.aborted) return { text: "⏹️ Stopped.", stopped: true };
          throw e;
        } finally {
          if (running.get(message.chatKey) === abort) running.delete(message.chatKey);
        }
      },

      async stop(chatKey) {
        const abort = running.get(chatKey);
        abort?.abort();
        return !!abort;
      },

      async reset(chatKey) {
        running.get(chatKey)?.abort();
      },

      async status() {
        return [member.statusLine()];
      },

      models() {
        return member.models().map((id) => ({ id, description: member.describe(id) || member.label }));
      },

      async compact(chatKey) {
        const chat = chats.bound(chatKey, member.id);
        if (!chat) return "Nothing to compact here yet.";
        const done = await maybeCompact({ transcript: deps.transcript, chatId: chat.id, budget: member.contextTokens, summarize: summarizer(member), force: true });
        return done ? "Summarized the older half of this chat; the rest stays word for word." : "Too short to compact yet.";
      },
    };
  };
}
