import { defineProvider } from "@choomfie/apibrain";

/** Cloudflare Workers AI: 10k "neurons" a day free, prompts not used for training. Needs the account id too. */
export default defineProvider({
  id: "cloudflare",
  label: "Cloudflare AI",
  baseURL: "https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1",
  vars: { accountId: "CLOUDFLARE_ACCOUNT_ID" },
  keyEnv: "CLOUDFLARE_API_KEY",
  signup: "https://dash.cloudflare.com/profile/api-tokens",
  note: "10k neurons a day; also needs CLOUDFLARE_ACCOUNT_ID",
  // Workers AI has no OpenAI-style model list, so these are what it tries.
  fallbackModels: ["@cf/openai/gpt-oss-120b", "@cf/openai/gpt-oss-20b", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"],
  listsModels: false,
  contextTokens: 8_000,
});
