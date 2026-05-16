import { spawn } from "node:child_process";
import type { ChatBackend, ChatBackendInput, ChatBackendOutput } from "./chat.ts";
import type { OpenAIEndpointConfig } from "./config.ts";

export interface HermesAdapter {
  isAvailable(config: OpenAIEndpointConfig): Promise<boolean>;
  passThrough(req: Request, config: OpenAIEndpointConfig): Promise<Response>;
  chat(prompt: string, model?: string): Promise<string>;
}

export class DefaultHermesAdapter implements HermesAdapter {
  private availableUntil = 0;
  private unavailableUntil = 0;

  async isAvailable(config: OpenAIEndpointConfig): Promise<boolean> {
    const now = Date.now();
    if (now < this.availableUntil) return true;
    if (now < this.unavailableUntil) return false;

    try {
      const response = await fetch(hermesHealthUrl(config), {
        signal: AbortSignal.timeout(1000),
      });
      const ok = response.ok;
      if (ok) this.availableUntil = now + 5000;
      else this.unavailableUntil = now + 5000;
      return ok;
    } catch {
      this.unavailableUntil = now + 5000;
      return false;
    }
  }

  async passThrough(req: Request, config: OpenAIEndpointConfig): Promise<Response> {
    const target = hermesTargetUrl(req, config);
    return fetch(target, {
      method: req.method,
      headers: req.headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      duplex: "half",
      signal: req.signal,
    } as RequestInit & { duplex?: "half" });
  }

  chat(prompt: string, model?: string): Promise<string> {
    const hermesBin = process.env.HERMES_BIN ?? "hermes";
    const args = ["-p", process.env.CHOOMFIE_HERMES_PROFILE ?? "choomfie", "chat", "-q", prompt];
    if (model) args.push("--model", model);

    return new Promise((resolve, reject) => {
      const child = spawn(hermesBin, args, {
        env: {
          ...process.env,
          HERMES_HOME: process.env.CHOOMFIE_HERMES_HOME ?? process.env.HERMES_HOME,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(stderr.trim() || `hermes chat exited with code ${code}`));
      });
    });
  }
}

export class HermesCLIChatBackend implements ChatBackend {
  constructor(
    private readonly adapter: HermesAdapter,
    private readonly config: OpenAIEndpointConfig,
  ) {}

  async complete(input: ChatBackendInput): Promise<ChatBackendOutput> {
    const content = await this.adapter.chat(formatChatPrompt(input.messages), input.backendModel);
    return {
      content,
      finishReason: "stop",
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };
  }
}

export function isStandardOpenAIPath(pathname: string): boolean {
  return (
    pathname === "/v1/models" ||
    pathname === "/v1/chat/completions" ||
    pathname === "/v1/embeddings" ||
    pathname === "/v1/files" ||
    pathname.startsWith("/v1/files/") ||
    pathname === "/v1/responses" ||
    pathname.startsWith("/v1/responses/")
  );
}

export function isHermesCliFallbackChat(req: Request, body: unknown): boolean {
  if (req.method !== "POST") return false;
  const pathname = new URL(req.url).pathname;
  if (pathname !== "/v1/chat/completions") return false;
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  return (body as Record<string, unknown>).stream !== true;
}

function hermesHealthUrl(config: OpenAIEndpointConfig): string {
  const base = new URL(config.routing.hermesBaseUrl);
  base.pathname = base.pathname.replace(/\/v1\/?$/, "/health");
  if (!base.pathname.endsWith("/health")) base.pathname = "/health";
  base.search = "";
  return base.toString();
}

function hermesTargetUrl(req: Request, config: OpenAIEndpointConfig): string {
  const incoming = new URL(req.url);
  const target = new URL(config.routing.hermesBaseUrl);
  const basePath = target.pathname.replace(/\/$/, "");
  const incomingPath = incoming.pathname.replace(/^\/v1/, "");
  target.pathname = `${basePath}${incomingPath}`;
  target.search = incoming.search;
  return target.toString();
}

function formatChatPrompt(messages: ChatBackendInput["messages"]): string {
  return messages
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join("\n\n");
}
