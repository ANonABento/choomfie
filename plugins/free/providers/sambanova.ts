import { defineProvider } from "@choomfie/apibrain";

/** SambaNova Cloud's free tier: good open models, few requests a day. */
export default defineProvider({
  id: "sambanova",
  label: "SambaNova",
  baseURL: "https://api.sambanova.ai/v1",
  keyEnv: "SAMBANOVA_API_KEY",
  signup: "https://cloud.sambanova.ai/apis",
  note: "now asks for a card before any call (402) — benched for a week when it does",
  contextTokens: 12_000,
  limits: { rpm: 20, rpd: 20 },
  limitScope: "model",
});
