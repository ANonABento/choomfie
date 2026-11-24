import { defineProvider } from "@choomfie/apibrain";

/** Many free models behind one key. Free = a `:free` id or zero pricing; anything else is refused. */
export default defineProvider({
  id: "openrouter",
  label: "OpenRouter",
  baseURL: "https://openrouter.ai/api/v1",
  keyEnv: "OPENROUTER_API_KEY",
  signup: "https://openrouter.ai/keys",
  note: "50 free requests a day (1,000 once $10 is added); free models may log prompts",
  isFree: (model, info) =>
    model.endsWith(":free") || model === "openrouter/free" || (info?.pricing?.prompt === 0 && info.pricing.completion === 0),
  // The listing says which models take images; this is only the fallback.
  vision: (model) => /-vl\b|-vl-|vision|omni|openrouter\/free/.test(model),
  headers: { "X-Title": "Choomfie" },
  contextTokens: 12_000,
  // Free models share one allowance per account: 20/min, 50/day (1000/day once $10 has ever been added).
  limits: { rpm: 20, rpd: 50 },
});
