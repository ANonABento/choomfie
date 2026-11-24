import { defineProvider } from "@choomfie/apibrain";

/** Z.ai (Zhipu) international: its GLM "-flash" models are free; the rest are paid and never called. */
export default defineProvider({
  id: "zai",
  label: "Z.ai",
  baseURL: "https://api.z.ai/api/paas/v4",
  keyEnv: "ZAI_API_KEY",
  signup: "https://z.ai/manage-apikey/apikey-list",
  note: "GLM flash models free; one request at a time",
  isFree: (model) => /-flash$/i.test(model),
  vision: (model) => /\dv\b|\dv-|vision/i.test(model),
  contextTokens: 16_000,
  limits: { rpm: 10 },
});
