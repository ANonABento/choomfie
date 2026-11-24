import { defineProvider } from "@choomfie/apibrain";

/** AxForge: 3M tokens every 30 days across its open models, hosted in the EU, nothing logged. */
export default defineProvider({
  id: "axforge",
  label: "AxForge",
  baseURL: "https://api.axforge.ai/v1",
  keyEnv: "AXFORGE_API_KEY",
  signup: "https://console.axforge.ai/keys",
  note: "3M tokens per 30 days; EU, no logging; don't add a balance (then it bills)",
  contextTokens: 16_000,
  limits: { rpm: 30 },
});
