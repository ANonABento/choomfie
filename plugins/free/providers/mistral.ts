import { defineProvider } from "@choomfie/apibrain";

/** Mistral La Plateforme's free "Experiment" plan: every Mistral model, low rate. Prompts may be used for training. */
export default defineProvider({
  id: "mistral",
  label: "Mistral",
  baseURL: "https://api.mistral.ai/v1",
  keyEnv: "MISTRAL_API_KEY",
  signup: "https://console.mistral.ai/api-keys",
  note: "free Experiment plan (phone check); prompts may be used for training",
  vision: (model) => /pixtral|vision|medium|small-3/.test(model),
  contextTokens: 16_000,
  limits: { rpm: 30 },
});
