import { z } from "zod";

export const EmbeddingsRequestSchema = z.object({
  input: z.union([z.string(), z.array(z.string())]),
  model: z.string().optional(),
}).passthrough();

export type EmbeddingsRequest = z.infer<typeof EmbeddingsRequestSchema>;

export interface EmbeddingProvider {
  embed(input: string[], model: string): Promise<number[][]>;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.baseUrl = (env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    this.defaultModel = env.OLLAMA_EMBEDDING_MODEL ?? "mxbai-embed-large";
  }

  async embed(input: string[], model: string = this.defaultModel): Promise<number[][]> {
    const embeddings: number[][] = [];
    for (const text of input) {
      const response = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: text }),
      });
      if (!response.ok) {
        throw new Error(`Ollama embeddings request failed with HTTP ${response.status}`);
      }
      const body = await response.json() as { embedding?: unknown };
      if (!Array.isArray(body.embedding)) {
        throw new Error("Ollama embeddings response did not include an embedding");
      }
      embeddings.push(body.embedding.filter((value): value is number => typeof value === "number"));
    }
    return embeddings;
  }
}

export function normalizeEmbeddingInput(request: EmbeddingsRequest): string[] {
  return Array.isArray(request.input) ? request.input : [request.input];
}

export function createEmbeddingsResponse(model: string, input: string[], embeddings: number[][]) {
  return {
    object: "list",
    data: embeddings.map((embedding, index) => ({
      object: "embedding",
      embedding,
      index,
    })),
    model,
    usage: {
      prompt_tokens: input.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0),
      total_tokens: input.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0),
    },
  };
}
