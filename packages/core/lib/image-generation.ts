import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { errorMessage } from "@choomfie/shared";

export interface GeneratedImage {
  filePath: string;
  prompt: string;
  provider: "openai" | "anthropic-svg" | "local-svg";
  fallbackReason?: string;
}

const DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-1";
const DEFAULT_OPENAI_IMAGE_SIZE = "1024x1024";
const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-haiku-latest";

export function formatGeneratedImageMessage(
  image: GeneratedImage,
  baseMessage = `Image: ${image.prompt}`,
): string {
  const fallbackReason = image.fallbackReason?.split("\n")[0];
  return fallbackReason
    ? `${baseMessage}\n\nFallback render used because ${fallbackReason}`
    : baseMessage;
}

function sanitizeFilenamePart(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || "image";
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrapText(value: string, maxChars: number, maxLines: number): string[] {
  const words = value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => word.match(new RegExp(`.{1,${maxChars}}`, "g")) ?? []);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
    if (lines.length >= maxLines) break;
  }

  if (current && lines.length < maxLines) lines.push(current);
  return lines.length > 0 ? lines : ["Untitled image prompt"];
}

async function writeInboxFile(
  dataDir: string,
  prompt: string,
  extension: "png" | "svg",
  data: string | ArrayBuffer | Uint8Array,
): Promise<string> {
  const inboxDir = join(dataDir, "inbox");
  await mkdir(inboxDir, { recursive: true });
  const filename = [
    Date.now(),
    randomUUID(),
    sanitizeFilenamePart(prompt),
  ].join("_") + `.${extension}`;
  const filePath = join(inboxDir, basename(filename));
  const payload = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  await writeFile(filePath, payload);
  return filePath;
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status}`);
  }
  return response.arrayBuffer();
}

async function generateWithOpenAI(
  prompt: string,
  dataDir: string,
): Promise<GeneratedImage | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_IMAGE_MODEL || DEFAULT_OPENAI_IMAGE_MODEL,
      prompt,
      size: process.env.OPENAI_IMAGE_SIZE || DEFAULT_OPENAI_IMAGE_SIZE,
      n: 1,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`OpenAI image generation failed: HTTP ${response.status}${detail ? ` ${detail.slice(0, 240)}` : ""}`);
  }

  const json = (await response.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };
  const image = json.data?.[0];
  if (!image) throw new Error("OpenAI image generation returned no image data");

  const bytes = image.b64_json
    ? Buffer.from(image.b64_json, "base64")
    : image.url
      ? await fetchArrayBuffer(image.url)
      : null;
  if (!bytes) throw new Error("OpenAI image generation returned an unsupported image payload");

  return {
    filePath: await writeInboxFile(dataDir, prompt, "png", bytes),
    prompt,
    provider: "openai",
  };
}

async function describeWithAnthropic(prompt: string): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
      max_tokens: 220,
      messages: [
        {
          role: "user",
          content: `Turn this image prompt into a concise visual art direction for an SVG fallback. Do not mention limitations. Prompt: ${prompt}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Anthropic fallback description failed: HTTP ${response.status}${detail ? ` ${detail.slice(0, 240)}` : ""}`);
  }

  const json = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  return json.content?.find((part) => part.type === "text")?.text?.trim() || null;
}

function renderSvg(prompt: string, description: string, fallbackReason?: string): string {
  const title = wrapText(prompt, 36, 3);
  const body = wrapText(description, 58, 7);
  const titleTspans = title
    .map((line, index) => `<tspan x="80" y="${132 + index * 46}">${escapeXml(line)}</tspan>`)
    .join("");
  const bodyTspans = body
    .map((line, index) => `<tspan x="80" y="${330 + index * 32}">${escapeXml(line)}</tspan>`)
    .join("");
  const footer = fallbackReason
    ? `Fallback render: ${fallbackReason.replace(/\s+/g, " ").slice(0, 120)}`
    : "Fallback render";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#f7f3e8"/>
      <stop offset="46%" stop-color="#a8d8cf"/>
      <stop offset="100%" stop-color="#263d59"/>
    </linearGradient>
    <linearGradient id="sun" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ffcf70"/>
      <stop offset="100%" stop-color="#f26b4f"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#sky)"/>
  <circle cx="786" cy="188" r="118" fill="url(#sun)" opacity="0.92"/>
  <path d="M0 724 C132 610 276 638 410 724 C544 810 704 752 1024 594 L1024 1024 L0 1024 Z" fill="#132c38" opacity="0.88"/>
  <path d="M0 806 C184 722 358 792 522 842 C690 894 838 804 1024 764 L1024 1024 L0 1024 Z" fill="#0e2028" opacity="0.92"/>
  <rect x="52" y="64" width="920" height="560" rx="28" fill="#fffaf0" opacity="0.86"/>
  <text font-family="Inter, Arial, sans-serif" font-size="40" font-weight="700" fill="#172026">${titleTspans}</text>
  <line x1="80" y1="266" x2="888" y2="266" stroke="#172026" stroke-opacity="0.18" stroke-width="3"/>
  <text font-family="Inter, Arial, sans-serif" font-size="25" fill="#263238">${bodyTspans}</text>
  <text x="80" y="586" font-family="Inter, Arial, sans-serif" font-size="18" fill="#4f5b62">${escapeXml(footer)}</text>
</svg>`;
}

export async function generateImage(
  prompt: string,
  dataDir: string,
): Promise<GeneratedImage> {
  const cleanPrompt = prompt.trim();
  if (!cleanPrompt) throw new Error("Prompt is required.");

  try {
    const openaiImage = await generateWithOpenAI(cleanPrompt, dataDir);
    if (openaiImage) return openaiImage;
  } catch (error) {
    return generateFallbackSvg(cleanPrompt, dataDir, errorMessage(error));
  }

  return generateFallbackSvg(cleanPrompt, dataDir, "OPENAI_API_KEY is not configured");
}

async function generateFallbackSvg(
  prompt: string,
  dataDir: string,
  fallbackReason: string,
): Promise<GeneratedImage> {
  let description = prompt;
  let provider: GeneratedImage["provider"] = "local-svg";

  try {
    const anthropicDescription = await describeWithAnthropic(prompt);
    if (anthropicDescription) {
      description = anthropicDescription;
      provider = "anthropic-svg";
    }
  } catch (error) {
    fallbackReason = `${fallbackReason}; ${errorMessage(error)}`;
  }

  const svg = renderSvg(prompt, description, fallbackReason);
  return {
    filePath: await writeInboxFile(dataDir, prompt, "svg", svg),
    prompt,
    provider,
    fallbackReason,
  };
}
