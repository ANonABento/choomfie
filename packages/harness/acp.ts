/**
 * One harness turn over ACP (Agent Client Protocol: JSON-RPC 2.0, one message
 * per line, on the CLI's stdin/stdout): `opencode acp`, `agy acp`.
 *
 * Instead of print mode's single answer at the end, the agent streams: its
 * text, each tool call and how it went (so a long run can say what it's
 * doing), and a permission request before anything its mode won't do on its
 * own (Antigravity's `auto` mode asks before irreversible actions), which the
 * brain turns into an Allow / Deny card.
 *
 * One process per turn, like print mode: the conversation lives in the CLI
 * (`session/load` resumes it), so nothing is held open between messages.
 * Checked Nov 25 against opencode 1.19.6 and agy 1.5.17.
 */

import { basename } from "node:path";

/** A tool call as the agent describes it (fields vary by agent; all optional). */
export interface AcpToolCall {
  toolCallId?: string;
  title?: string;
  /** read | edit | delete | move | search | execute | think | fetch | other */
  kind?: string;
  status?: string;
  rawInput?: Record<string, unknown>;
  /** Antigravity sends its own names alongside the standard ones. */
  args?: Record<string, unknown>;
  locations?: { path?: string }[];
  content?: { type?: string; path?: string; content?: { type?: string; text?: string } }[];
}

export interface PermissionAsk {
  title: string;
  /** What it would do: the command, or the file and change. */
  detail: string;
  kind?: string;
}

export interface AcpTurnInput {
  cmd: string[];
  cwd: string;
  prompt: string;
  /** Session to resume. */
  ref?: string;
  /** The agent's own mode id (`build`, `auto`, `plan`). */
  mode?: string;
  model?: string;
  signal: AbortSignal;
  timeoutMs: number;
  progress?(line: string): void;
  /** Ask the owner; resolves true to allow once. Absent: everything asked is denied. */
  permission?(ask: PermissionAsk): Promise<boolean>;
}

export interface AcpTurnOutput {
  text: string;
  ref?: string;
  actions: string[];
  /** Tools that failed. */
  toolErrors: string[];
  tokens?: { in: number; out: number };
  stopped?: boolean;
  timedOut?: boolean;
  /** No answer: why (an RPC error, the process died). */
  failed?: string;
  /** The session to resume couldn't be loaded, so this turn started a new one. */
  restarted?: boolean;
  stderr: string;
}

/** The pipe to the agent: lines out, lines in. Swapped for an in-process fake in tests. */
export interface AcpTransport {
  write(line: string): void;
  lines: AsyncIterable<string>;
  kill(): void;
  exited: Promise<number | null>;
  stderr(): Promise<string>;
}

export type AcpSpawn = (cmd: string[], cwd: string) => AcpTransport;

export const spawnAcp: AcpSpawn = (cmd, cwd) => {
  const proc = Bun.spawn(cmd, { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1", PWD: cwd } });
  const err = new Response(proc.stderr).text();
  async function* lines() {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) yield line;
      }
    }
    if (buf.trim()) yield buf;
  }
  return {
    write(line) {
      try {
        proc.stdin.write(`${line}\n`);
        proc.stdin.flush();
      } catch {
        /* the process is gone; the read loop notices */
      }
    },
    lines: lines(),
    kill: () => proc.kill(),
    exited: proc.exited,
    stderr: () => err,
  };
};

class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number
  ) {
    super(message);
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** "ran `npm test`", "edited app.ts", or nothing for a step that only looked. */
export function describeAction(t: AcpToolCall): string | undefined {
  const input = { ...(t.args ?? {}), ...(t.rawInput ?? {}) };
  const command = str(input.command) ?? str(input.CommandLine) ?? str(input.cmd);
  const path = str(input.filePath) ?? str(input.path) ?? str(input.Path) ?? str(input.TargetFile) ?? t.locations?.[0]?.path;
  if (t.kind === "execute") {
    const c = command ?? t.title;
    return c ? `ran \`${c.length > 80 ? `${c.slice(0, 79)}…` : c}\`` : undefined;
  }
  if (t.kind === "edit") return path ? `edited ${basename(path)}` : t.title ? `edited (${t.title})` : undefined;
  if (t.kind === "delete") return path ? `deleted ${basename(path)}` : undefined;
  if (t.kind === "move") return path ? `moved ${basename(path)}` : undefined;
  return undefined;
}

/** What a permission card shows: the command, or the file and the change (clipped). */
export function permissionAsk(t: AcpToolCall): PermissionAsk {
  const input = { ...(t.args ?? {}), ...(t.rawInput ?? {}) };
  const command = str(input.command) ?? str(input.CommandLine);
  const diff = t.content?.find((c) => c.type === "diff") as { path?: string; newText?: string } | undefined;
  const path = diff?.path ?? str(input.filePath) ?? str(input.Path) ?? t.locations?.[0]?.path;
  const detail = command
    ? `\`\`\`sh\n${command.slice(0, 1_500)}\n\`\`\``
    : path
      ? `\`${path}\`${diff?.newText ? `\n\`\`\`\n${diff.newText.slice(0, 1_200)}\n\`\`\`` : ""}`
      : JSON.stringify(input).slice(0, 1_500);
  return { title: t.title ?? t.kind ?? "a tool", detail, kind: t.kind };
}

type PermOption = { optionId: string; name?: string; kind?: string };

function pickOption(options: PermOption[], allow: boolean): string | undefined {
  const want = allow ? "allow_once" : "reject_once";
  const byName = allow ? /allow|yes|accept|approve|proceed/i : /reject|deny|no\b|decline|cancel/i;
  return (options.find((o) => o.kind === want) ?? options.find((o) => o.kind?.startsWith(allow ? "allow" : "reject")) ?? options.find((o) => byName.test(o.name ?? "")))?.optionId;
}

export async function acpTurn(input: AcpTurnInput, spawn: AcpSpawn = spawnAcp): Promise<AcpTurnOutput> {
  const t = spawn(input.cmd, input.cwd);
  let nextId = 0;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  const send = (msg: object) => t.write(JSON.stringify({ jsonrpc: "2.0", ...msg }));
  const request = <T = Record<string, unknown>>(method: string, params: object) =>
    new Promise<T>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      send({ id, method, params });
    });

  // What the turn produced. Updates count only once the prompt is sent (a session/load replays history first).
  let listening = false;
  const texts: string[] = [];
  let lastMessageId: string | undefined;
  const tools = new Map<string, AcpToolCall>();
  const actions: string[] = [];
  const toolErrors: string[] = [];
  let sessionId: string | undefined;
  let stopped = false;
  let timedOut = false;

  const onUpdate = (u: Record<string, unknown>) => {
    if (!listening) return;
    const kind = u.sessionUpdate;
    if (kind === "agent_message_chunk") {
      const text = (u.content as { text?: string } | undefined)?.text ?? "";
      const id = str(u.messageId);
      if (id && lastMessageId && id !== lastMessageId && texts.length) texts.push("\n\n");
      if (id) lastMessageId = id;
      texts.push(text);
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      const id = str(u.toolCallId) ?? `t${tools.size}`;
      const call = { ...(tools.get(id) ?? {}), ...(u as AcpToolCall) };
      tools.set(id, call);
      if (call.status === "in_progress" && call.kind !== "think") input.progress?.(`🔧 ${call.title ?? call.kind ?? "working"}`);
      if (call.status === "completed" && !(call as { counted?: boolean }).counted) {
        (call as { counted?: boolean }).counted = true;
        const a = describeAction(call);
        if (a) actions.push(a);
      } else if (call.status === "failed") toolErrors.push(call.title ?? call.kind ?? "tool");
    }
  };

  const onRequest = async (id: number | string, method: string, params: Record<string, unknown>) => {
    if (method !== "session/request_permission") {
      // No file system or terminal offered: the agent uses its own tools.
      send({ id, error: { code: -32601, message: `${method} isn't offered by this client` } });
      return;
    }
    const options = (params.options as PermOption[]) ?? [];
    if (input.signal.aborted || stopped) return send({ id, result: { outcome: { outcome: "cancelled" } } });
    const allow = input.permission ? await input.permission(permissionAsk((params.toolCall ?? {}) as AcpToolCall)).catch(() => false) : false;
    const optionId = pickOption(options, allow);
    send({ id, result: { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } } });
  };

  const reader = (async () => {
    for await (const line of t.lines) {
      let m: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string; code?: number } };
      try {
        m = JSON.parse(line);
      } catch {
        continue; // a log line on stdout
      }
      if (m.method && m.id !== undefined) void onRequest(m.id, m.method, m.params ?? {});
      else if (m.method === "session/update") onUpdate((m.params?.update ?? {}) as Record<string, unknown>);
      else if (m.id !== undefined && pending.has(Number(m.id))) {
        const p = pending.get(Number(m.id))!;
        pending.delete(Number(m.id));
        if (m.error) p.reject(new RpcError(m.error.message ?? "error", m.error.code));
        else p.resolve(m.result ?? {});
      }
    }
    // Stdout closed: the process is gone. Anything still waiting fails.
    for (const p of pending.values()) p.reject(new RpcError("the agent exited"));
    pending.clear();
  })();

  const cancel = () => {
    if (sessionId) send({ method: "session/cancel", params: { sessionId } });
    // Give it a moment to end the turn cleanly, then make sure.
    setTimeout(() => t.kill(), 5_000);
  };
  const onAbort = () => {
    stopped = true;
    cancel();
  };
  input.signal.addEventListener("abort", onAbort);
  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, input.timeoutMs);

  let restarted = false;
  let tokens: AcpTurnOutput["tokens"];
  let failed: string | undefined;
  try {
    const init = await request<{ agentCapabilities?: { loadSession?: boolean } }>("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const session = { cwd: input.cwd, mcpServers: [] };
    if (input.ref && init.agentCapabilities?.loadSession) {
      try {
        await request("session/load", { sessionId: input.ref, ...session });
        sessionId = input.ref;
      } catch {
        restarted = true;
      }
    } else if (input.ref) restarted = true;
    sessionId ??= (await request<{ sessionId: string }>("session/new", session)).sessionId;
    // Mode and model: the standard call, then the config-option form some agents use instead. Best effort.
    const setOption = async (method: string, key: string, configId: string, value?: string) => {
      if (!value) return;
      await request(method, { sessionId, [key]: value }).catch(() => request("session/set_config_option", { sessionId, configId, value }).catch(() => {}));
    };
    await setOption("session/set_mode", "modeId", "mode", input.mode);
    await setOption("session/set_model", "modelId", "model", input.model);
    if (stopped) return { text: "", ref: sessionId, actions, toolErrors, stopped, stderr: "" };

    listening = true;
    const r = await request<{ stopReason?: string; usage?: { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number } }>("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: input.prompt }],
    });
    if (r.usage) tokens = { in: (r.usage.inputTokens ?? 0) + (r.usage.cachedReadTokens ?? 0), out: r.usage.outputTokens ?? 0 };
    if (r.stopReason === "cancelled") stopped ||= !timedOut;
    else if (r.stopReason === "refusal") failed = "it refused";
  } catch (e) {
    failed = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", onAbort);
    t.kill();
  }
  await reader.catch(() => {});
  const text = texts.join("").trim();
  return {
    text,
    ref: sessionId,
    actions,
    toolErrors,
    ...(tokens ? { tokens } : {}),
    ...(stopped ? { stopped } : {}),
    ...(timedOut ? { timedOut } : {}),
    ...(failed && !stopped && !timedOut ? { failed } : {}),
    ...(restarted ? { restarted } : {}),
    stderr: await t.stderr().catch(() => ""),
  };
}
