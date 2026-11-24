import { defineProvider } from "@choomfie/apibrain";

/** Cerebras: very fast big open models. Free tier keeps prompts short. */
export default defineProvider({
  id: "cerebras",
  label: "Cerebras",
  baseURL: "https://api.cerebras.ai/v1",
  keyEnv: "CEREBRAS_API_KEY",
  signup: "https://cloud.cerebras.ai/platform",
  note: "very fast; free tier caps context around 8k",
  contextTokens: 7_000,
  limits: { rpm: 30 },
  limitScope: "model",
});
