import { defineProvider } from "@choomfie/apibrain";

/**
 * LM Studio's local server (Developer tab → Start server, or `lms server
 * start`): OpenAI-compatible on port 1234, `/v1/models` lists what's
 * downloaded. No key, so it's opt-in like Ollama:
 * `"free": { "providers": { "lmstudio": { "enabled": true } } }`
 * (`baseURL` there for another port or machine).
 */
export default defineProvider({
  id: "lmstudio",
  label: "LM Studio (local)",
  baseURL: "http://127.0.0.1:1234/v1",
  noKey: true,
  optIn: true,
  note: "models on this machine; turn on with free.providers.lmstudio.enabled",
  contextTokens: 8_000,
});
