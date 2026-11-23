import { defineProvider } from "@choomfie/apibrain";

/** Many free models behind one key. Free = a `:free` id or zero pricing; anything else is refused. */
export default defineProvider({
  id: "openrouter",
  label: "OpenRouter",
  baseURL: "https://openrouter.ai/api/v1",
  keyEnv: "OPENROUTER_API_KEY",
  signup: "https://openrouter.ai/keys",
  defaultModels: [
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "google/gemma-4-31b-it:free",
    "nvidia/nemotron-3.5-super-vl:free",
    "openrouter/free",
  ],
  isFree: (model, info) =>
    model.endsWith(":free") || model === "openrouter/free" || (info?.pricing?.prompt === 0 && info.pricing.completion === 0),
  vision: (model) => /gemma-4|-vl|omni|openrouter\/free/.test(model),
  headers: { "X-Title": "Choomfie" },
  contextTokens: 12_000,
  // Free models share one allowance per account: 20/min, 50/day (1000/day once $10 has ever been added).
  limits: { rpm: 20, rpd: 50 },
});
