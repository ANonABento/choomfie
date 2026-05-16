import { randomBytes } from "node:crypto";

export interface OpenAINotifyInput {
  app: string;
  content: string;
  channelId?: string;
}

export interface OpenAINotifyResult {
  delivered: boolean;
  mode: "owner_dm" | "channel" | "unavailable";
}

export interface OpenAINotifier {
  notify(input: OpenAINotifyInput): Promise<OpenAINotifyResult>;
}

interface IpcNotifyResponse {
  type: "openai_notify_result";
  id: string;
  ok: boolean;
  mode?: "owner_dm" | "channel";
  error?: string;
}

export class SupervisorIpcNotifier implements OpenAINotifier {
  private readonly pending = new Map<string, {
    resolve: (result: OpenAINotifyResult) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly timeoutMs = 10_000) {
    process.on("message", (msg: unknown) => {
      if (!msg || typeof msg !== "object") return;
      const response = msg as Partial<IpcNotifyResponse>;
      if (response.type !== "openai_notify_result" || typeof response.id !== "string") return;
      const pending = this.pending.get(response.id);
      if (!pending) return;

      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.ok) {
        pending.resolve({
          delivered: true,
          mode: response.mode ?? "owner_dm",
        });
      } else {
        pending.reject(new Error(response.error ?? "Notification failed"));
      }
    });
  }

  notify(input: OpenAINotifyInput): Promise<OpenAINotifyResult> {
    if (!process.send) {
      return Promise.resolve({ delivered: false, mode: "unavailable" });
    }

    const id = `notify_${randomBytes(12).toString("base64url")}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Notification timed out"));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      try {
        process.send?.({
          type: "openai_notify",
          id,
          app: input.app,
          content: input.content,
          channel_id: input.channelId,
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
