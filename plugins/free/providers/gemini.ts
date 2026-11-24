import { defineProvider } from "@choomfie/apibrain";

/** Google AI Studio's free tier, through its OpenAI-compatible endpoint. Sees images; long context. Free-tier prompts may be used for training. */
export default defineProvider({
  id: "gemini",
  label: "Gemini",
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
  keyEnv: "GEMINI_API_KEY",
  signup: "https://aistudio.google.com/apikey",
  note: "big context, sees images; free prompts may be used for training",
  vision: (model) => !/tts|embed/.test(model),
  contextTokens: 32_000,
  limits: { rpm: 10, rpd: 250 },
  limitScope: "model",
  resetTimeZone: "America/Los_Angeles",
});
