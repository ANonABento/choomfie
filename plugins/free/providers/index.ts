/**
 * Every API provider the free brain knows, in no particular order (routing
 * order is `buckets.ts` and config). A new provider: a file beside these,
 * one line here, its key in the data dir's `.env`. See docs/free-brain.md.
 */

import type { ApiProviderSpec } from "@choomfie/apibrain";
import cloudflare from "./cloudflare.ts";
import gemini from "./gemini.ts";
import groq from "./groq.ts";
import nvidia from "./nvidia.ts";
import ollama from "./ollama.ts";
import openrouter from "./openrouter.ts";
import sambanova from "./sambanova.ts";

export const PROVIDERS: ApiProviderSpec[] = [openrouter, groq, gemini, nvidia, sambanova, cloudflare, ollama];
