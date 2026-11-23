/**
 * The kinds of message the free brain tells apart, and who answers each.
 *
 * One table: the zero-shot classifier's prompt is built from `description`,
 * `/mode` lists `id`/`label`, and `targets` is the default routing — tried in
 * order, failing over down the list, then down `free.priority`. A target is
 * `member[:model]`: an API provider (`groq`, optionally pinned to a model) or
 * any registered brain (`waymond`). `@bucket` splices in another bucket's list.
 * config.json `free.buckets.<id>` replaces a bucket's targets.
 */

import type { BucketDef } from "@choomfie/apibrain";

export interface Bucket extends BucketDef {
  targets: string[];
}

export const BUCKETS: Bucket[] = [
  {
    id: "chat",
    label: "Chat",
    description: "small talk, greetings, opinions, jokes, quick factual questions, short everyday help",
    targets: ["groq:llama-3.3-70b-versatile", "gemini:gemini-3.5-flash-lite", "groq:openai/gpt-oss-20b", "cloudflare", "openrouter", "ollama"],
  },
  {
    id: "quality",
    label: "Think it through",
    description: "needs careful thinking or good writing: analysis, comparisons, plans, long explanations, math, editing or rewriting text",
    targets: [
      "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free",
      "gemini:gemini-flash-latest",
      "nvidia:nvidia/nemotron-3-ultra-550b-a55b",
      "groq:openai/gpt-oss-120b",
      "sambanova",
    ],
  },
  {
    id: "code",
    label: "Code",
    description: "about programming, answered in the reply itself: explain, write, review or debug code, errors, shell commands, regex, SQL",
    targets: [
      "groq:openai/gpt-oss-120b",
      "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free",
      "nvidia:z-ai/glm-5.3-flash",
      "gemini:gemini-flash-latest",
      "groq:qwen/qwen3.8-27b",
      "sambanova",
    ],
  },
  {
    id: "agentic",
    label: "Do the work",
    description:
      "asks the assistant to DO work with tools, not just answer: change a repo, make or edit files, run code, build an app, a website or a 3D/CAD part, browse sites, multi-step tasks",
    targets: ["waymond", "@code"],
  },
  {
    id: "research",
    label: "Research",
    description: "needs current or sourced information from the web: news, today's prices, recent releases, looking something up, citations",
    targets: ["waymond", "gemini:gemini-flash-latest", "openrouter"],
  },
  {
    id: "vision",
    label: "Images",
    description: "about an attached image",
    targets: [
      "gemini:gemini-flash-latest",
      "openrouter:nvidia/nemotron-3.5-super-vl:free",
      "openrouter:google/gemma-4-31b-it:free",
      "nvidia:nvidia/nemotron-3.5-super-vl-120b-a12b",
    ],
  },
  {
    id: "long",
    label: "Long input",
    description: "a very long document or message to read",
    targets: ["gemini:gemini-flash-latest", "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free", "openrouter"],
  },
];

/** When a bucket's list is spent: anything that can answer at all. */
export const DEFAULT_PRIORITY = ["groq", "gemini", "openrouter", "nvidia", "sambanova", "cloudflare", "ollama"];

/** Small, fast models for the zero-shot classifier (it runs on most messages: keep it off scarce quotas like OpenRouter's 50/day). */
export const DEFAULT_CLASSIFIER_TARGETS = ["groq:llama-3.1-8b-instant", "groq:openai/gpt-oss-20b", "gemini:gemini-3.5-flash-lite", "cloudflare:@cf/openai/gpt-oss-20b", "ollama"];

/** For background summaries: cheap and plentiful. */
export const DEFAULT_SUMMARY_TARGETS = ["groq:llama-3.3-70b-versatile", "gemini:gemini-3.5-flash-lite", "groq:openai/gpt-oss-20b", "cloudflare", "ollama"];
