/**
 * Core agent — wraps Claude Code CLI via Agent SDK.
 * All channels (Discord, terminal) route through here.
 */

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentOptions {
  sessionId: string;
  systemPrompt?: string;
  workingDir?: string;
}

export interface AgentResponse {
  content: string;
  sessionId: string;
}

export async function runAgent(
  message: string,
  options: AgentOptions
): Promise<AgentResponse> {
  // TODO: Replace with Agent SDK subprocess call
  // For now, uses claude CLI directly
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  const args = ["--print", message];

  if (options.systemPrompt) {
    args.unshift("--system-prompt", options.systemPrompt);
  }

  const { stdout } = await execFileAsync("claude", args, {
    cwd: options.workingDir || process.cwd(),
    maxBuffer: 1024 * 1024 * 10, // 10MB
  });

  return {
    content: stdout.trim(),
    sessionId: options.sessionId,
  };
}
