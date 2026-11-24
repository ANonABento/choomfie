import { defineProvider } from "@choomfie/apibrain";

/** NVIDIA's hosted catalog (build.nvidia.com): large open models, meant for prototyping. */
export default defineProvider({
  id: "nvidia",
  label: "NVIDIA NIM",
  baseURL: "https://integrate.api.nvidia.com/v1",
  keyEnv: "NVIDIA_API_KEY",
  signup: "https://build.nvidia.com",
  note: "100+ open models for prototyping (NVIDIA developer account)",
  vision: (model) => /-vl\b|-vl-|vision|omni|gemma-[3-9]/.test(model),
  contextTokens: 16_000,
  limits: { rpm: 40 },
});
