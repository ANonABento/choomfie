import { defineProvider } from "@choomfie/apibrain";

/** Aion Labs: roleplay and storytelling models, small daily allowance. */
export default defineProvider({
  id: "aion",
  label: "Aion Labs",
  baseURL: "https://api.aionlabs.ai/v1",
  keyEnv: "AION_API_KEY",
  signup: "https://www.aionlabs.ai/app/api-keys/",
  note: "roleplay models; 20k tokens a day",
  contextTokens: 6_000,
  limits: { rpm: 15, tpd: 20_000 },
});
