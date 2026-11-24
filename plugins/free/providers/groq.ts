import { defineProvider } from "@choomfie/apibrain";

/** Very fast. Limits are per model, so a busy model leaves the others free. */
export default defineProvider({
  id: "groq",
  label: "Groq",
  baseURL: "https://api.groq.com/openai/v1",
  keyEnv: "GROQ_API_KEY",
  signup: "https://console.groq.com/keys",
  // Free tier TPM is a few thousand per model: keep prompts small.
  contextTokens: 6_000,
  limits: { rpm: 30, rpd: 1_000 },
  limitScope: "model",
});
