import { defineProvider } from "@choomfie/apibrain";

/**
 * Models on this machine. No key, so it's only used when config enables it:
 * `"free": { "providers": { "ollama": { "enabled": true } } }`. With no models
 * configured it uses whatever `ollama list` has.
 */
export default defineProvider({
  id: "ollama",
  label: "Ollama (local)",
  baseURL: "http://127.0.0.1:11434/v1",
  noKey: true,
  optIn: true,
  note: "models on this machine; turn on with free.providers.ollama.enabled",
  contextTokens: 8_000,
});
