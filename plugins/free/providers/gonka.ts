import { defineProvider } from "@choomfie/apibrain";

/** Gonka Broker: ~1M tokens a month after an SMS check; its lineup rotates (the live list says what's there). */
export default defineProvider({
  id: "gonka",
  label: "Gonka",
  baseURL: "https://proxy.gonkabroker.com/v1",
  keyEnv: "GONKA_API_KEY",
  signup: "https://app.gonkabroker.com/signup",
  note: "~1M tokens a month; needs a real phone number",
  contextTokens: 16_000,
  limits: { rpm: 10 },
});
