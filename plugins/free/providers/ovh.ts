import { defineProvider } from "@choomfie/apibrain";

/** OVHcloud AI Endpoints, anonymous: no key, 2 requests a minute per model, hosted in the EU. A key would be pay-as-you-go, so none is used. */
export default defineProvider({
  id: "ovh",
  label: "OVHcloud",
  baseURL: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
  noKey: true,
  note: "no key; 2 requests a minute per model; EU",
  vision: (model) => /-vl|vl-|omni|gemma-[3-9]|qwen3\.[5-9]/i.test(model),
  contextTokens: 16_000,
  limits: { rpm: 2 },
  limitScope: "model",
});
