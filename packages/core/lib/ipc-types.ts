/**
 * IPC message types for supervisor ↔ worker communication.
 *
 * Supervisor spawns worker as a child process via Bun.spawn({ ipc }).
 * Messages are JSON-serialized automatically by Bun's IPC.
 */

// --- Worker → Supervisor ---

export interface IpcReady {
  type: "ready";
  tools: IpcToolDef[];
  instructions: string;
}

export interface IpcToolResult {
  type: "tool_result";
  id: string;
  result: { content: Array<{ type: "text"; text: string }>; isError?: boolean };
}

export interface IpcNotification {
  type: "notification";
  method: string;
  params: Record<string, unknown>;
}

export interface IpcLog {
  type: "log";
  level: "error" | "info";
  message: string;
}

export interface IpcRequestRestart {
  type: "request_restart";
  reason: string;
  /** Channel to send confirmation after restart completes */
  chat_id?: string;
}

export type WorkerMessage =
  | IpcReady
  | IpcToolResult
  | IpcNotification
  | IpcLog
  | IpcRequestRestart;

// --- Supervisor → Worker ---

/**
 * Who made a tool call, as far as the process that received it can tell. Tools
 * that act with the owner's authority check it (`callerIsOwner`) instead of
 * trusting the prompt.
 * - `session`: a daemon chat session; its endpoint token is bound to `location`.
 * - `remote`: the remote MCP endpoint (a cloud agent holding the owner's token).
 * - `local`: the supervisor's one stdio session, which serves every chat.
 */
export type ToolCaller = { via: "session"; location: string } | { via: "remote" } | { via: "local" };

export interface IpcToolCall {
  type: "tool_call";
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Absent from an older host: treated as `local`. */
  caller?: ToolCaller;
}

export interface IpcPermissionRequest {
  type: "permission_request";
  method: string;
  params: Record<string, unknown>;
}

export interface IpcShutdown {
  type: "shutdown";
}

export interface IpcRestartConfirmation {
  type: "restart_confirmation";
  reason: string;
  chat_id: string;
}

export type SupervisorMessage =
  | IpcToolCall
  | IpcPermissionRequest
  | IpcShutdown
  | IpcRestartConfirmation;

// --- Shared ---

/**
 * MCP tool annotations: hints a client uses to decide how to ask (Ambition asks
 * twice for a tool it takes as destructive). Unset, MCP says to assume the
 * worst: not read-only, destructive.
 */
export interface ToolHints {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Only reads. */
export const READ_ONLY: ToolHints = { readOnlyHint: true, openWorldHint: false };

export interface IpcToolDef {
  name: string;
  description: string;
  inputSchema: object;
  annotations?: ToolHints;
}
