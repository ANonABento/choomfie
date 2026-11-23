import { defineProvider } from "@choomfie/apibrain";

/** SambaNova Cloud's free tier: good open models, few requests a day. */
export default defineProvider({
  id: "sambanova",
  label: "SambaNova",
  baseURL: "https://api.sambanova.ai/v1",
  keyEnv: "SAMBANOVA_API_KEY",
  signup: "https://cloud.sambanova.ai/apis",
  defaultModels: ["gpt-oss-120b", "gemma-4-31B-it", "MiniMax-M3.1-Flash"],
  contextTokens: 12_000,
  limits: { rpm: 20, rpd: 20 },
  limitScope: "model",
});
