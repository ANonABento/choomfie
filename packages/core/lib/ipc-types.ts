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

export interface IpcToolCall {
  type: "tool_call";
  id: string;
  name: string;
  args: Record<string, unknown>;
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

export interface IpcToolDef {
  name: string;
  description: string;
  inputSchema: object;
}
