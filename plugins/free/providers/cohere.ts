import { defineProvider } from "@choomfie/apibrain";

/** Cohere's trial key: 1,000 calls a month, non-commercial. Lists models on its native API. */
export default defineProvider({
  id: "cohere",
  label: "Cohere",
  baseURL: "https://api.cohere.ai/compatibility/v1",
  modelsURL: "https://api.cohere.com/v1/models?endpoint=chat&page_size=200",
  keyEnv: "COHERE_API_KEY",
  signup: "https://dashboard.cohere.com/api-keys",
  note: "trial key: 1,000 calls a month, non-commercial use",
  contextTokens: 16_000,
  // ~1,000 a month.
  limits: { rpm: 20, rpd: 30 },
});
