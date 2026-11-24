import { defineProvider } from "@choomfie/apibrain";

/** Runcrate: a weekly free allowance on a few open models (sign in with GitHub). The probe finds which answer. */
export default defineProvider({
  id: "runcrate",
  label: "Runcrate",
  baseURL: "https://api.runcrate.ai/v1",
  keyEnv: "RUNCRATE_API_KEY",
  signup: "https://www.runcrate.ai/dashboard/api-keys",
  note: "weekly free allowance on five models; sign up with GitHub (Google sign-up needs a card)",
  contextTokens: 16_000,
  limits: { rpm: 20 },
});
