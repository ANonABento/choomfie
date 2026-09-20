import { z } from "zod";
import {
  buildOllamaEmbeddingRequest,
  parseOllamaEmbeddingResponse,
  resolveOllamaEmbeddingConfig,
} from "./ollama-embeddings.ts";

export const EmbeddingsRequestSchema = z.object({
  input: z.union([z.string(), z.array(z.string())]),
  model: z.string().optional(),
}).passthrough();

export type EmbeddingsRequest = z.infer<typeof EmbeddingsRequestSchema>;

export interface EmbeddingProvider {
  embed(input: string[], model: string): Promise<number[][]>;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private readonly endpoint: string;
  private readonly defaultModel: string;

  constructor(env: Record<string, string | undefined> = process.env) {
    const config = resolveOllamaEmbeddingConfig(env);
    this.endpoint = config.endpoint;
    this.defaultModel = config.model;
  }

  async embed(input: string[], model: string = this.defaultModel): Promise<number[][]> {
    const embeddings: number[][] = [];
    for (const text of input) {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: buildOllamaEmbeddingRequest(model, text),
      });
      if (!response.ok) {
        throw new Error(`Ollama embeddings request failed with HTTP ${response.status}`);
      }
      const embedding = parseOllamaEmbeddingResponse(await response.json());
      if (!embedding) {
        throw new Error("Ollama embeddings response did not include an embedding");
      }
      embeddings.push(embedding);
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
