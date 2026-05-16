export function sseJsonChunk(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

export function sseDoneChunk(): string {
  return "data: [DONE]\n\n";
}

export function encodeSSE(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
