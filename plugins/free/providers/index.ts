/**
 * Every API provider the free brain knows, in no particular order (routing
 * order is `buckets.ts` and config). A new provider: a file beside these,
 * one line here, its key in the data dir's `.env`. See docs/free-brain.md.
 */

import type { ApiProviderSpec } from "@choomfie/apibrain";
import aion from "./aion.ts";
import axforge from "./axforge.ts";
import cerebras from "./cerebras.ts";
import cloudflare from "./cloudflare.ts";
import cohere from "./cohere.ts";
import gemini from "./gemini.ts";
import gonka from "./gonka.ts";
import groq from "./groq.ts";
import kilo from "./kilo.ts";
import llm7 from "./llm7.ts";
import lmstudio from "./lmstudio.ts";
import mistral from "./mistral.ts";
import nvidia from "./nvidia.ts";
import ollama from "./ollama.ts";
import openrouter from "./openrouter.ts";
import ovh from "./ovh.ts";
import runcrate from "./runcrate.ts";
import sambanova from "./sambanova.ts";
import zai from "./zai.ts";

export const PROVIDERS: ApiProviderSpec[] = [
  // A key from their site (`bun run apibrain keys`).
  groq, gemini, openrouter, cerebras, mistral, nvidia, sambanova, cloudflare, cohere, zai, aion, axforge, gonka, runcrate,
  // No key: anonymous free tiers, on unless config turns them off.
  kilo, llm7, ovh,
  // Opt-in: a local server.
  ollama, lmstudio,
];
