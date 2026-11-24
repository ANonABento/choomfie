import { defineProvider } from "@choomfie/apibrain";

/** Z.ai (Zhipu) international: its GLM "-flash" models are free; the rest are paid and never called. */
export default defineProvider({
  id: "zai",
  label: "Z.ai",
  baseURL: "https://api.z.ai/api/paas/v4",
  keyEnv: "ZAI_API_KEY",
  signup: "https://z.ai/manage-apikey/apikey-list",
  note: "older GLM flash models free (4.5/4.6v/4.7); one request at a time",
  isFree: (model) => /-flash$/i.test(model),
  // Free, answering, and missing from /models (checked Nov 24). The listed glm-5.3-flash asks for a balance.
  unlistedModels: ["glm-4.7-flash", "glm-4.6v-flash", "glm-4.5-flash"],
  vision: (model) => /\dv\b|\dv-|vision/i.test(model),
  contextTokens: 16_000,
  limits: { rpm: 10 },
});
