import { randomBytes } from "node:crypto";

export interface OpenAISkillSummary {
  name: string;
  description: string;
}

export interface OpenAISkillBridge {
  list(): Promise<OpenAISkillSummary[]>;
  invoke(name: string, args: Record<string, unknown>): Promise<unknown>;
}

type SkillIpcResponse =
  | { type: "openai_skills_result"; id: string; ok: true; skills?: OpenAISkillSummary[]; result?: unknown }
  | { type: "openai_skills_result"; id: string; ok: false; error: string };

export class SupervisorIpcSkillBridge implements OpenAISkillBridge {
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly timeoutMs = 120_000) {
    process.on("message", (msg: unknown) => {
      if (!msg || typeof msg !== "object") return;
      const response = msg as Partial<SkillIpcResponse>;
      if (response.type !== "openai_skills_result" || typeof response.id !== "string") return;
      const pending = this.pending.get(response.id);
      if (!pending) return;

      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.ok) {
        pending.resolve("skills" in response ? response.skills : response.result);
      } else {
        const error = (response as { error?: string }).error;
        pending.reject(new Error(error ?? "Skill bridge failed"));
      }
    });
  }

  async list(): Promise<OpenAISkillSummary[]> {
    const result = await this.request({ type: "openai_skills_list" });
    return Array.isArray(result) ? result as OpenAISkillSummary[] : [];
  }

  invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request({ type: "openai_skill_invoke", name, args });
  }

  private request(payload: Record<string, unknown>): Promise<unknown> {
    if (!process.send) {
      return Promise.reject(new Error("Skill bridge is unavailable outside supervisor mode"));
    }

    const id = `skill_${randomBytes(12).toString("base64url")}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Skill bridge request timed out"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        process.send?.({ ...payload, id });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
