/**
 * The `free` brain: one `/brain free` that answers each message with
 * whichever free model or web brain suits it.
 *
 * Routing policy ("API models float, stateful members lock"):
 *
 *   - API members share this chat's transcript, so moving between them loses
 *     nothing: every message is classified (hard rules → zero-shot →
 *     keywords) and the bucket's best healthy API model answers it.
 *   - A web brain (Waymond) holds work in its own conversation, so a chat
 *     only goes there on its first message, through a member mode
 *     (`/mode cad`), or when you accept "Hand this to Waymond". Once it has
 *     answered, the chat is on it (`chat.model`, shown by `/model`) until
 *     `/model auto`. If it fails, nothing moves silently: the reply offers
 *     Retry and "Answer with another model".
 *
 * `/model` pins a member or `member:model`; a pinned API model that can't
 * answer falls back to the other API models, and the reply says so.
 *
 * Modes are the web members' own work modes (`/mode cad` → Waymond in cad
 * mode), so plan boards work through free too. Buckets are internal.
 */

import {
  AllUnavailableError,
  apiTurn,
  maybeCompact,
  nowIso,
  rankAcross,
  parseTarget,
  personaOf,
  recap,
  route,
  shortDuration,
  summarizer,
  systemPrompt,
  targetKey,
  userContent,
  isImage,
  estimateTokens,
  type ApiMember,
  type CallLog,
  type Classification,
  type Classifier,
  type Health,
  type Target,
  type Transcript,
} from "@choomfie/apibrain";
import {
  framePrompt,
  getBrain,
  isQuotaReached,
  mediaKindOf,
  brainsWith,
  listBrainIds,
  type Capability,
  type Brain,
  type BrainMessage,
  type BrainMode,
  type BrainModel,
  type BrainReply,
  type ChatRecord,
  type PluginContext,
} from "@choomfie/shared";
import type { FreeConfig } from "./config.ts";
import { PROVIDERS } from "./providers/index.ts";

export const FREE_BRAIN = "free";
/** Known API providers: one with no key is unavailable, not a brain to look for. */
/** Added to the system prompt only when tool work fell to a text model. */
const NO_TOOLS_FRAME = "You can't make images or files, run code, or browse here. If the request needs that, say so in a sentence and offer what you can do in text instead.";
const clipNote = (s: string) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 90 ? `${one.slice(0, 89)}…` : one;
};

const PROVIDER_IDS = new Set(PROVIDERS.map((p) => p.id));
/** `/model` value for "let the router choose" (stored as null). */
export const AUTO_MODEL = "auto";

/** Health unit for a brain member. */
const brainUnit = (id: string) => `brain:${id}`;
/** One kind of work a brain is out of ("gemini-web#music"), when its site caps them separately. */
const scoped = (id: string, kind: string) => `${id}#${kind}`;
/** A web brain that wants a login sits out this long. */
const LOGIN_COOLDOWN_MS = 3_600_000;
/** Out of quota and it didn't say until when: look again after this (one failed call finds out). */
const QUOTA_COOLDOWN_MS = 3_600_000;

export const RETRY_CHOICE = "Retry";
export const RELEASE_CHOICE = "Answer with another model";
/**
 * Under a member's reply while it holds the chat: let free pick a model per
 * message again (same as `/model auto`). Not "back to the free models": the
 * holder (Gemini web, Antigravity) is free too.
 */
export const HAND_BACK_CHOICE = "Back to auto";
export const handChoice = (label: string) => `Hand this to ${label}`;
/** Under an API answer when a much bigger model is ready: answer the same message again with it. */
export const BIGGER_CHOICE = "Try a bigger model";
/** "Bigger" means at least this many times the parameters. */
const BIGGER_FACTOR = 2;
/** "Hand this to …" buttons under one answer, at most. */
const MAX_OFFERS = 3;

/** The capability a bucket's work needs (media: by what the message asks to make). */
function capabilityFor(bucketId: string, kind?: string): Capability | undefined {
  if (bucketId === "media") return `${kind ?? "image"}-gen` as Capability;
  return ({ agentic: "agentic", local: "local", research: "web-search" } as Record<string, Capability>)[bucketId];
}

export interface FreeBrainDeps {
  config: FreeConfig;
  members: Map<string, ApiMember>;
  /** Providers known but not usable (no key), for `/brain`. */
  unconfigured: { id: string; label: string; signup?: string }[];
  classifier: Classifier;
  transcript: Transcript;
  health: Health;
  /** Where routing decisions are written (`apibrain log`). */
  log?: CallLog;
  /** Defaults to the shared brain registry. */
  lookupBrain?: (id: string) => Brain | undefined;
}

/** A rule guess below this, mid-chat, continues the previous turn's bucket and model. */
const FOLLOW_UP_BELOW = 0.6;

interface Route {
  member: string;
  model?: string;
  bucket: string;
  /** The model asked for (the provider may name its answer differently). */
  asked?: string;
  by: Classification["by"] | "mode" | "pin" | "you";
  latencyMs: number;
  at: number;
}

interface Answer {
  reply: BrainReply;
  record: string;
  model?: string;
}

/** What a quick-reply button this brain offered does when clicked. */
type OfferKind =
  | { kind: "retry" }
  | { kind: "release" }
  | { kind: "hand"; to: string }
  | { kind: "handback"; from: string }
  /** Redo with a bigger model: the answer's size, what answered, the bucket, and the transcript turn to replace from. */
  | { kind: "bigger"; than: number; skip: string; bucket: string; fromTurn: number };

/** Buttons under the last reply, and the message they act on. */
interface Offer {
  message: BrainMessage;
  choices: Map<string, OfferKind>;
}

interface Decision {
  bucket: string;
  by: Route["by"];
  targets: Target[];
  /** A web member holds this chat: if it fails, say so instead of moving on. */
  locked: boolean;
  pinnedMode?: string;
  /** A pinned API target, to say when someone else answered. */
  pin?: Target;
  /** A web member this message looks like a job for (offered, not taken). */
  /** Brains to offer with a "Hand this to …" button each (best first). */
  suggest?: string[];
  confidence?: number;
  reason?: string;
  /** Answered for this message only: the chat stays with `heldBy`, and the reply says why it went elsewhere. */
  heldBy?: string;
}

export function createFreeBrain(deps: FreeBrainDeps, ctx: PluginContext): Brain {
  const { config, members, transcript, health } = deps;
  const lookup = deps.lookupBrain ?? getBrain;
  const chats = ctx.chats;
  if (!chats) throw new Error("the free brain needs Choomfie's chat store (ctx.chats)");

  const lastRoute = new Map<string, Route>();
  const recent: (Route & { text: string })[] = [];
  const running = new Map<string, { abort: AbortController; member?: string }>();
  const offers = new Map<string, Offer>();
  /** Brain members (or `id#kind`) whose last call said that allowance is spent, and what it said. */
  const spent = new Map<string, string>();
  /** Why `id` can't take a message of this kind (out of quota), if it can't. */
  const spentFor = (id: string, kind?: string) => spent.get(id) ?? (kind ? spent.get(scoped(id, kind)) : undefined);
  const bucket = (id: string) => config.buckets.find((b) => b.id === id);
  const isApi = (t: Target) => members.has(t.member);

  /** Every target id that isn't an API provider: brains the router may hand to. */
  const brainMemberIds = (): string[] => {
    const all = [
      ...[...config.priority, ...config.buckets.flatMap((b) => [...b.brains, ...(b.targets ?? [])])].map((t) => parseTarget(t).member),
      // A brain that says what it can do is a member too, with no config line (a new site, a new harness).
      ...listBrainIds().filter((id) => !!getBrain(id)?.capabilities?.length),
    ];
    return [...new Set(all)].filter((id) => !members.has(id) && id !== FREE_BRAIN && !config.providers[id] && !PROVIDER_IDS.has(id));
  };
  const isBrainMember = (id: string) => brainMemberIds().includes(id) && !!lookup(id);
  const brainMembers = (): Brain[] => brainMemberIds().flatMap((id) => (lookup(id) ? [lookup(id)!] : []));
  /** The web member this chat is on, if any. */
  const holderOf = (chat: ChatRecord): string | undefined => {
    const m = chat.model ? parseTarget(chat.model).member : undefined;
    return m && isBrainMember(m) ? m : undefined;
  };

  /** The web member that owns a mode. */
  const memberMode = (mode: string): { brain: Brain; mode: BrainMode } | undefined => {
    for (const b of brainMembers()) {
      const m = b.modes?.find((x) => x.id === mode);
      if (m) return { brain: b, mode: m };
    }
    return undefined;
  };

  const waitMs = (t: Target, tokens: number, kind?: string): number => {
    const api = members.get(t.member);
    if (api) return api.waitMs(t.model, tokens);
    if (config.providers[t.member] || PROVIDER_IDS.has(t.member)) return Infinity; // a provider with no key, or disabled
    if (!lookup(t.member) || t.member === FREE_BRAIN) return Infinity;
    // Out of one kind (music) only benches it for messages asking for that kind.
    return Math.max(health.waitMs(brainUnit(t.member)), kind ? health.waitMs(brainUnit(scoped(t.member, kind))) : 0);
  };

  /** Brain members that share a bucket with `id` and can take a call now (where its work can go when it's out). */
  function siblingsOf(id: string, kind?: string): string[] {
    // Out of one kind of media: only a brain that makes that kind can do that work.
    const ids = kind ? brainsFor("media", kind) : config.buckets.filter((b) => b.brains.includes(id)).flatMap((b) => brainsFor(b.id));
    return [...new Set(ids)].filter((x) => x !== id && isBrainMember(x) && waitMs({ member: x }, 0, kind) === 0).slice(0, 2);
  }

  /**
   * The brains for a bucket's work: the ones config lists, minus any that say
   * they can't do it (a song: only brains with `music-gen`), plus any other
   * loaded brain that says it can (a new media site needs no config line).
   */
  function brainsFor(bucketId: string, kind?: string): string[] {
    const cap = capabilityFor(bucketId, kind);
    const listed = (bucket(bucketId)?.brains ?? []).filter((id) => {
      const caps = lookup(id)?.capabilities;
      return !cap || !caps || caps.includes(cap);
    });
    const more = cap ? brainsWith(cap).map((b) => b.id).filter((id) => id !== FREE_BRAIN && !listed.includes(id)) : [];
    return [...listed, ...more];
  }

  function targetsFor(bucketId: string, kind?: string): Target[] {
    if (config.strategy === "priority") return config.priority.map(parseTarget);
    const b = bucket(bucketId);
    // Pinned in config, or: this kind of work's brains, then the best live models for its need.
    const planned = b?.targets ? b.targets.map(parseTarget) : [...brainsFor(bucketId, kind).map((id) => ({ member: id })), ...rankAcross(members.values(), b?.need ?? "fast")];
    return [...planned, ...config.priority.map(parseTarget)];
  }

  async function decide(
    message: BrainMessage,
    chat: ChatRecord,
    framed: string,
    tokens: number,
    signal: AbortSignal,
    force?: OfferKind
  ): Promise<Decision> {
    if (force?.kind === "hand") return { bucket: "handoff", by: "you", targets: [{ member: force.to }], locked: true };
    if (force?.kind === "bigger") return { bucket: force.bucket, by: "you", targets: [...biggerThan(force.than, force.skip), ...rankAcross(members.values(), "strong")], locked: false };
    const released = force?.kind === "release";
    const hasImages = message.filePaths.some(isImage);

    if (!released && chat.mode) {
      const owned = memberMode(chat.mode);
      if (owned) return { bucket: chat.mode, by: "mode", targets: [{ member: owned.brain.id }], locked: true, pinnedMode: chat.mode };
    }
    // A model asked for this message only (`delegate` with `model`): it answers, whoever holds the chat.
    const oneOff = typeof message.meta?.model === "string" && message.meta.model !== "auto" ? parseTarget(message.meta.model) : undefined;
    const holder = released || (oneOff && isApi(oneOff)) ? undefined : holderOf(chat);
    if (holder) {
      // The holder can't make what's asked (a song from Waymond): if it really is a media request,
      // this one message goes to a brain that can, and the chat stays with the holder.
      const kind = mediaKindOf(message.content);
      const caps = lookup(holder)?.capabilities;
      if (kind && caps && !caps.includes(`${kind}-gen` as Capability) && bucket("media")) {
        const c = await deps.classifier.classify({ text: framed, hasImages, tokens, recent: [] }, signal);
        if (c.bucket === "media") {
          const targets = targetsFor("media", kind).filter((t) => t.member !== holder && (isApi(t) || isBrainMember(t.member)));
          return { bucket: "media", by: c.by, targets, locked: false, confidence: c.confidence, reason: `${holder} can't make ${kind}`, heldBy: holder };
        }
      }
      return { bucket: "pinned", by: "pin", targets: [{ member: holder }], locked: true };
    }
    const pin = oneOff && isApi(oneOff) ? oneOff : !released && chat.model ? parseTarget(chat.model) : undefined;
    if (pin && isApi(pin)) {
      const api = members.get(pin.member)!;
      // An image the pinned model can't see goes to a vision model for this one turn.
      if (!(hasImages && !api.vision(pin.model))) {
        return { bucket: "pinned", by: "pin", targets: [pin, ...rankAcross(members.values(), "strong"), ...config.priority.map(parseTarget).filter(isApi)], locked: false, pin };
      }
    }

    const first = !transcript.live(chat.id).length && !transcript.summary(chat.id);
    let chosen: string;
    let by: Route["by"];
    let confidence = 1;
    let reason: string | undefined;
    if (config.strategy === "priority") {
      chosen = "priority";
      by = "rule";
    } else {
      const decision = await deps.classifier.classify(
        { text: framed, hasImages, tokens, recent: transcript.live(chat.id).slice(-2).map((t) => ({ role: t.role, content: t.content })) },
        signal
      );
      chosen = decision.bucket;
      by = decision.by;
      confidence = decision.confidence;
      reason = decision.reason;
    }
    // A weak guess mid-chat ("5090 ones", "table please") continues the last
    // turn: same bucket, and the model that answered it first.
    const prev = lastRoute.get(message.chatKey);
    const follow = !first && !released && by === "rule" && confidence < FOLLOW_UP_BELOW && prev && bucket(prev.bucket) ? prev : undefined;
    if (follow) {
      chosen = follow.bucket;
      reason = `follow-up, stays on ${follow.bucket}`;
    }
    const kind = mediaKindOf(message.content);
    const planned = targetsFor(chosen, kind);
    const again = follow && members.has(follow.member) ? { member: follow.member, ...(follow.asked ? { model: follow.asked } : {}) } : undefined;
    const targets = again ? [again, ...planned.filter((t) => t.member !== again.member || t.model !== again.model)] : planned;
    // A first message may go anywhere: nothing is lost if a web brain takes it.
    const why = { confidence, ...(reason ? { reason } : {}) };
    if (first && !released) return { bucket: chosen, by, targets, locked: false, ...why };
    // Mid-chat, only API members answer; the brains that can do this work are offered instead, a button each.
    const b = bucket(chosen);
    const own = [...brainsFor(chosen, kind).map((id) => ({ member: id }) as Target), ...(b?.targets ?? []).map(parseTarget)];
    const offers =
      released || confidence < config.classifier.suggestAt
        ? []
        : [...new Set(own.filter((t) => !isApi(t) && isBrainMember(t.member) && waitMs(t, 0, kind) === 0).map((t) => t.member))].slice(0, MAX_OFFERS);
    return { bucket: chosen, by, targets: targets.filter(isApi), locked: false, ...why, ...(offers.length ? { suggest: offers } : {}) };
  }

  async function answerWithApi(member: ApiMember, t: Target, chatId: string, framed: string, filePaths: string[], signal: AbortSignal, bucketId?: string): Promise<Answer> {
    const current = userContent(framed, filePaths, member.vision(t.model));
    const budget = Math.min(member.contextTokens, config.contextTokens ?? Infinity);
    const persona = personaOf(ctx);
    // Only on the turns that need it: work meant for a brain with tools, answered by a text model.
    const frame = bucket(bucketId ?? "")?.brains.length ? NO_TOOLS_FRAME : undefined;
    const r = await apiTurn({ member, model: t.model, transcript, chatId, system: systemPrompt(persona, frame, ctx.memoryContext?.()), persona, current, signal, budget });
    return { reply: { text: r.text || `(${member.label} sent an empty reply)` }, record: current.record, model: r.model };
  }

  async function answerWithBrain(brain: Brain, message: BrainMessage, chatId: string, framed: string, d: Decision): Promise<Answer> {
    // The member's own chat at this location: put it in the mode this message wants.
    const own = chats!.current(message.chatKey, brain.id, message.content);
    const want = d.pinnedMode ?? (brain.modes?.some((m) => m.id === d.bucket) ? d.bucket : own.mode);
    if (chats!.setMode && own.mode !== want) chats!.setMode(own.id, want);

    const since = transcript.lastAnsweredBy(chatId, brain.id);
    const summary = transcript.summary(chatId);
    const missed = transcript.live(chatId).filter((t) => t.id > since);
    const context = recap(summary && since < summary.uptoId ? summary : null, missed);
    const kind = mediaKindOf(message.content);
    try {
      const reply = await brain.send(context ? { ...message, content: `${context}\n\n${message.content}` } : message, ctx);
      health.ok(brainUnit(brain.id));
      spent.delete(brain.id);
      if (kind && reply.files?.length) {
        health.ok(brainUnit(scoped(brain.id, kind)));
        spent.delete(scoped(brain.id, kind));
      }
      return { reply, record: framed };
    } catch (e) {
      if (isQuotaReached(e)) {
        // Not broken, just done until the reset: bench it that long, no exponential failures.
        // Out of one kind (Gemini's music cap): only that kind is benched; it still takes everything else.
        const unit = e.scope ? scoped(brain.id, e.scope) : brain.id;
        spent.set(unit, e.message);
        const ms = e.resetAt ? Math.max(60_000, e.resetAt - Date.now()) : QUOTA_COOLDOWN_MS;
        health.cool(brainUnit(unit), ms, e.resetAt ? "out of quota" : "out of quota (reset time unknown)");
      } else if ((e as { name?: string })?.name === "LoginRequiredError") health.cool(brainUnit(brain.id), LOGIN_COOLDOWN_MS, "needs a login");
      else health.fail(brainUnit(brain.id), e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  const summarize = async (text: string) =>
    (
      await route(config.summaryTargets ? config.summaryTargets.map(parseTarget) : rankAcross(members.values(), "fast", 4), {
        waitMs: (t) => (members.has(t.member) ? members.get(t.member)!.waitMs(t.model) : Infinity),
        attempt: (t) => summarizer(members.get(t.member)!)(text),
      })
    ).value;
  const budget = () => config.contextTokens ?? 8_000;

  const label = (member: string) => members.get(member)?.label ?? lookup(member)?.label ?? member;

  /** Every usable API model with its size. */
  const sized = () => [...members.values()].flatMap((m) => (m.configured ? m.ranked("strong").map((t) => ({ member: m.id, model: t.id, params: t.params })) : []));
  const paramsOf = (member: string, model?: string) => (model ? sized().find((t) => t.member === member && t.model === model)?.params : undefined);
  /** Ready models at least BIGGER_FACTOR× the size, biggest first. */
  function biggerThan(params: number, skip: string): Target[] {
    return sized()
      .filter((t) => t.params >= params * BIGGER_FACTOR && `${t.member}:${t.model}` !== skip && waitMs(t, 0) === 0)
      .sort((a, b) => b.params - a.params)
      .slice(0, 4)
      .map(({ member, model }) => ({ member, model }));
  }

  function footer(r: Route): string {
    const model = r.model ? ` · ${r.model.replace(/^[^/]+\//, "")}` : "";
    return `\n-# via ${label(r.member)}${model} · ${r.bucket}`;
  }

  /** Attach this brain's own buttons to a reply, and remember what they do. */
  function withOffer(reply: BrainReply, message: BrainMessage, kinds: [string, OfferKind][]): BrainReply {
    if (!kinds.length) return reply;
    offers.set(message.chatKey, { message, choices: new Map(kinds) });
    return { ...reply, choices: [...(reply.choices ?? []), ...kinds.map(([text]) => text)] };
  }

  const brain: Brain = {
    id: FREE_BRAIN,
    label: "Free",
    // Its vision and long-context models; tool work goes to members.
    capabilities: ["vision", "long-context"],
    summarize: (text) => summarize(text),

    // Read by core on each `/mode`: brain members can load after this one.
    get modes(): BrainMode[] {
      // Two members with the same mode id (both harnesses have `work`): the first one listed owns it.
      const seen = new Set<string>();
      return brainMembers().flatMap((b) =>
        (b.modes ?? []).filter((m) => !seen.has(m.id) && seen.add(m.id)).map((m) => ({ ...m, description: `${b.label}: ${m.description}` }))
      );
    },

    models(): BrainModel[] {
      const out: BrainModel[] = [{ id: AUTO_MODEL, description: "picks the best model for each message (default)" }];
      for (const b of brainMembers()) out.push({ id: b.id, description: `${b.label} web brain — keeps the chat until /model auto` });
      for (const m of members.values()) {
        const models = m.models();
        if (!models.length) continue;
        out.push({ id: m.id, description: `any ${m.label} model, best first (${models.length} free now)` });
        for (const id of models) out.push({ id: `${m.id}:${id}`, description: [m.label, m.describe(id)].filter(Boolean).join(" · ") });
      }
      return out;
    },

    async send(incoming): Promise<BrainReply> {
      const chat = chats.current(incoming.chatKey, FREE_BRAIN, incoming.content);
      // A click on one of our own buttons acts on the message it was offered for.
      const offer = offers.get(incoming.chatKey);
      offers.delete(incoming.chatKey);
      const typed = incoming.content.trim();
      const held = holderOf(chat) ?? (chat.mode ? memberMode(chat.mode)?.brain.id : undefined);
      // An older reply's Hand back button still works: its offer is gone, but the chat is still held.
      const force: OfferKind | undefined = incoming.filePaths.length
        ? undefined
        : (offer?.choices.get(typed) ?? (typed === HAND_BACK_CHOICE && held ? { kind: "handback", from: held } : undefined));
      const message = force ? { ...offer!.message, meta: incoming.meta } : incoming;
      if (force?.kind === "handback") {
        // The member's replies are already in this chat's transcript, so the free models pick up from there.
        if (chat.model) chats.setModel?.(chat.id, null);
        if (chat.mode && memberMode(chat.mode)) chats.setMode?.(chat.id, null);
        lastRoute.delete(incoming.chatKey);
        return { text: `↩️ Back to auto: free picks the model per message again, and it has ${label(force.from)}'s replies in this chat's history; \`/model ${force.from}\` to hand it back.` };
      }
      if (force?.kind === "release" && holderOf(chat)) {
        chats.setModel?.(chat.id, null);
        chat.model = null;
      }
      // The smaller model's exchange is replaced, so the message isn't in the history twice.
      if (force?.kind === "bigger") {
        transcript.dropFrom(chat.id, force.fromTurn);
        // Evidence: that answer wasn't good enough.
        const t = parseTarget(force.skip);
        if (t.model) members.get(t.member)?.redone(t.model);
      }

      const framed = framePrompt(message.content, message.meta);
      const kind = mediaKindOf(message.content);
      // Model lists are fetched at startup; a message in the first seconds waits for them.
      await Promise.all([...members.values()].map((m) => m.ready()));
      const abort = new AbortController();
      const run: { abort: AbortController; member?: string } = { abort };
      running.set(message.chatKey, run);
      let d: Decision | undefined;
      let routeLog: ((f: { passed: string[]; error?: string }) => void) | undefined;
      try {
        const tokens = estimateTokens(framed);
        const decision = await decide(message, chat, framed, tokens, abort.signal, force);
        d = decision;
        const plan = decision.targets.map(targetKey);
        const logRoute = (fields: { answered?: string; ms?: number; passed: string[]; error?: string; offered?: string }) =>
          deps.log?.write({
            type: "route",
            at: nowIso(),
            chat: chat.id,
            brain: FREE_BRAIN,
            text: message.content.slice(0, 200),
            bucket: decision.bucket,
            by: decision.by,
            ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
            ...(decision.reason ? { reason: decision.reason } : {}),
            plan,
            ...fields,
          });
        routeLog = logRoute;
        const routed = await route(decision.targets, {
          signal: abort.signal,
          waitMs: (t) => waitMs(t, tokens, kind),
          attempt: (t) => {
            run.member = t.member;
            const api = members.get(t.member);
            if (api) return answerWithApi(api, t, chat.id, framed, message.filePaths, abort.signal, decision.bucket);
            return answerWithBrain(lookup(t.member)!, message, chat.id, framed, decision);
          },
        });
        const { reply, record, model } = routed.value;
        const member = routed.target.member;
        const r: Route = { member, model, ...(routed.target.model ? { asked: routed.target.model } : {}), bucket: decision.bucket, by: decision.by, latencyMs: routed.latencyMs, at: Date.now() };
        const userTurn = transcript.add(chat.id, "user", record);
        // A picture or track alone still goes in the transcript, so the next model knows it was sent.
        const sent = reply.files?.length ? `[attached: ${reply.files.map((f) => f.name).join(", ")}]` : "";
        // A harness's work (files changed, commands run) too: after a hand-back, the next model knows what changed.
        const said = [reply.text, sent, reply.record ?? ""].filter(Boolean).join("\n");
        if (said) transcript.add(chat.id, "assistant", said, member, model);
        // A web member that answered now holds the chat (until `/model auto`).
        if (!members.has(member) && chat.model !== member && !decision.heldBy) chats.setModel?.(chat.id, member);
        lastRoute.set(message.chatKey, r);
        recent.unshift({ ...r, text: message.content.slice(0, 40) });
        recent.length = Math.min(recent.length, 5);
        if (routed.passed.length) console.error(`[free] ${targetKey(routed.target)} answered after: ${routed.passed.join("; ")}`);
        logRoute({ answered: model ? `${member}:${model}` : member, ms: routed.latencyMs, passed: routed.passed, ...(decision.suggest ? { offered: decision.suggest.join(",") } : {}) });
        void maybeCompact({ transcript, chatId: chat.id, budget: budget(), summarize });

        let text = reply.text;
        // A brain with tools was meant to take this and couldn't: say so, so a text answer isn't mistaken for the real thing.
        const skipped = members.has(member) ? decision.targets.find((t) => !members.has(t.member))?.member : undefined;
        const skippedWhy = skipped ? routed.passed.find((p) => p.startsWith(`${skipped}:`)) : undefined;
        if (decision.heldBy && !reply.stopped) {
          const why = skippedWhy ?? routed.passed.find((p) => !p.startsWith(`${member}:`));
          const raw = why?.replace(/^[^:]+:\s*/, "").replace(/\.$/, "");
          text += `\n-# ${label(decision.heldBy)} holds this chat but can't make ${kind ?? "media"}, so ${label(member)} took this one${raw ? ` (tried first: ${clipNote(raw)})` : ""}. The chat stays with ${label(decision.heldBy)}.`;
        } else if (skipped && !reply.stopped) {
          const raw = skippedWhy?.slice(skipped.length + 1).trim();
          // Benched from an earlier message: say why, not just "cooling down".
          const why = (raw === "cooling down" ? (spentFor(skipped, kind) ?? raw) : raw)?.replace(/\.$/, "");
          // "Gemini web is out of its free music allowance for now — answered by …" reads on its own.
          text += why && / is out of its free /.test(why)
            ? `\n-# ${clipNote(why)} — answered by ${label(member)}, which can't make files or use tools.`
            : `\n-# ${label(skipped)} couldn't take this${why ? ` (${clipNote(why)})` : ""} — answered by ${label(member)}, which has no tools.`;
        }
        else if (decision.pin && member !== decision.pin.member && !reply.stopped) text += `\n-# ${label(decision.pin.member)} couldn't answer — ${label(member)} did.`;
        else if (config.footer && !reply.stopped) text += footer(r);
        // A small model answered and a much bigger one is ready: offer it (not when you picked the model).
        const asked = routed.target.model ?? model;
        const size = members.has(member) && !decision.pin && decision.by !== "you" ? paramsOf(member, asked) : undefined;
        const bigger: [string, OfferKind][] =
          size && biggerThan(size, `${member}:${asked}`).length ? [[BIGGER_CHOICE, { kind: "bigger", than: size, skip: `${member}:${asked}`, bucket: decision.bucket, fromTurn: userTurn }]] : [];
        const offered: [string, OfferKind][] =
          reply.stopped ? []
          : decision.suggest ? [...decision.suggest.map((to): [string, OfferKind] => [handChoice(label(to)), { kind: "hand", to }]), ...bigger]
          // A member now holds this chat: one click gives it back when the work is done.
          : decision.heldBy ? [[HAND_BACK_CHOICE, { kind: "handback", from: decision.heldBy }]]
          : !members.has(member) ? [[HAND_BACK_CHOICE, { kind: "handback", from: member }]]
          : bigger;
        return withOffer({ ...reply, text }, message, offered);
      } catch (e) {
        if (abort.signal.aborted) return { text: "⏹️ Stopped.", stopped: true };
        routeLog?.({ passed: e instanceof AllUnavailableError ? e.attempts : [], error: e instanceof Error ? e.message : String(e) });
        if (!(e instanceof AllUnavailableError)) throw e;
        console.error(`[free] nothing answered: ${e.attempts.join("; ")}`);
        if (d?.locked) {
          // A web member holds this chat: don't move it behind your back.
          const holder = d.targets[0].member;
          const why = e.attempts[0]?.replace(/^[^:]+:\s*/, "") ?? "unavailable";
          // Out of quota: retrying won't help, but a member that does the same kind of work might.
          const outWhy = spentFor(holder, kind);
          const out = outWhy !== undefined;
          const scopedOut = out && !spent.has(holder);
          const others = out ? siblingsOf(holder, scopedOut ? kind : undefined) : [];
          const back = waitMs({ member: holder }, 0, kind);
          const text = out
            ? `⚠️ ${label(holder)} is out of its free ${scopedOut ? `${kind} ` : ""}allowance${back && back !== Infinity ? ` (back in ~${shortDuration(back)})` : ""}.${others.length ? "" : " Nothing else that does this kind of work is free right now."}${scopedOut ? ` It still answers everything else.` : ""}`
            : `⚠️ ${label(holder)} couldn't answer: ${why.slice(0, 200)}`;
          return withOffer({ text }, message, [
            ...(out ? [] : [[RETRY_CHOICE, { kind: "retry" }] as [string, OfferKind]]),
            ...others.map((id): [string, OfferKind] => [handChoice(label(id)), { kind: "hand", to: id }]),
            [RELEASE_CHOICE, { kind: "release" }],
          ]);
        }
        const when = e.retryInMs ? ` Try again in ~${shortDuration(e.retryInMs)},` : " Try again later,";
        return { text: `All free providers are limited or unavailable right now.${when} or switch with \`/brain claude\`.` };
      } finally {
        if (running.get(message.chatKey) === run) running.delete(message.chatKey);
      }
    },

    async stop(chatKey) {
      const run = running.get(chatKey);
      if (!run) return false;
      const member = run.member && !members.has(run.member) ? lookup(run.member) : undefined;
      if (member?.stop) {
        // A web brain stops on its own side and returns what it has.
        return member.stop(chatKey);
      }
      run.abort.abort();
      return true;
    },

    async resolveApproval(chatKey, approvalId, approve) {
      const last = lastRoute.get(chatKey)?.member;
      const candidates = [...(last ? [lookup(last)] : []), ...brainMembers()].filter(
        (b): b is Brain => !!b?.resolveApproval && !!chats.bound(chatKey, b.id)
      );
      if (!candidates.length) throw new Error("no brain here has an approval waiting");
      return candidates[0].resolveApproval!(chatKey, approvalId, approve);
    },

    // Core has already started a fresh free chat here; start fresh member chats too.
    async reset(chatKey) {
      running.get(chatKey)?.abort.abort();
      lastRoute.delete(chatKey);
      offers.delete(chatKey);
      for (const b of brainMembers()) {
        if (!chats.bound(chatKey, b.id)) continue;
        chats.start(chatKey, b.id);
        await b.reset?.(chatKey);
      }
    },

    async compact(chatKey) {
      const chat = chats.bound(chatKey, FREE_BRAIN);
      if (!chat) return "Nothing to compact here yet.";
      const done = await maybeCompact({ transcript, chatId: chat.id, budget: budget(), summarize, force: true });
      const holder = holderOf(chat);
      const note = holder ? ` ${label(holder)} keeps its own context on its side.` : "";
      return (done ? "Summarized the older half of this chat; the rest stays word for word." : "Too short to compact yet.") + note;
    },

    async status() {
      const lines = [
        `**Free brain** — ${config.strategy === "smart" ? `smart routing, ${config.classifier.embeddings ? "embeddings + " : ""}${config.classifier.type} classifier` : "priority order"}${config.footer ? " · route footer on" : ""}`,
        ...[...members.values()].map((m) => m.statusLine()),
        ...brainMemberIds().map((id) => {
          const b = lookup(id);
          if (!b) return `• **${id}** — not loaded (\`/plugins\`)`;
          const wait = health.waitMs(brainUnit(id));
          return `• **${b.label}** — ${wait ? `cooling ${shortDuration(wait)} (${health.get(brainUnit(id)).reason ?? "failing"})` : "ready"}`;
        }),
      ];
      if (deps.unconfigured.length) lines.push(`-# No key: ${deps.unconfigured.map((p) => p.label).join(", ")} — add one to the data dir's \`.env\` (docs/free-brain.md).`);
      if (recent.length) {
        lines.push(`-# Recent: ${recent.slice(0, 3).map((r) => `${r.bucket} → ${label(r.member)} (${(r.latencyMs / 1000).toFixed(1)}s, ${r.by})`).join(" · ")}`);
      }
      return lines;
    },
  };
  return brain;
}
