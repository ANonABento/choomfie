import { defineProvider } from "@choomfie/apibrain";

/** NVIDIA's hosted catalog (build.nvidia.com): large open models, meant for prototyping. */
export default defineProvider({
  id: "nvidia",
  label: "NVIDIA NIM",
  baseURL: "https://integrate.api.nvidia.com/v1",
  keyEnv: "NVIDIA_API_KEY",
  signup: "https://build.nvidia.com",
  defaultModels: ["nvidia/nemotron-3-ultra-550b-a55b", "z-ai/glm-5.3-flash", "google/gemma-4-31b-it", "nvidia/nemotron-3.5-super-vl-120b-a12b"],
  vision: (model) => /-vl-|gemma-4|omni/.test(model),
  contextTokens: 16_000,
  limits: { rpm: 40 },
});
