import { defineProvider } from "@choomfie/apibrain";

/** Kilo Code's gateway: its `:free` models answer with no key. Free providers there may log prompts. */
export default defineProvider({
  id: "kilo",
  label: "Kilo",
  baseURL: "https://api.kilo.ai/api/gateway",
  noKey: true,
  note: "no key; 200 requests an hour; free models may log prompts",
  isFree: (model, info) => model.endsWith(":free") || (info?.pricing?.prompt === 0 && info.pricing.completion === 0),
  contextTokens: 16_000,
  limits: { rpm: 10, rpd: 1_000 },
});
