import { defineProvider } from "@choomfie/apibrain";

/** LLM7.io: its "turbo" models answer with no key. Undocumented, so it may stop without notice. */
export default defineProvider({
  id: "llm7",
  label: "LLM7",
  baseURL: "https://api.llm7.io/v1",
  noKey: true,
  note: "no key; turbo models only; undocumented, may vanish",
  isFree: (_model, info) => info?.tier === "turbo",
  contextTokens: 8_000,
  limits: { rpm: 10 },
});
