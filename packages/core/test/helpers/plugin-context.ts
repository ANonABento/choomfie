import type { PluginContext } from "@choomfie/shared";

export const testPluginContext: PluginContext = {
  DATA_DIR: "/tmp/choomfie-test",
  config: {
    getConfig: () => ({}),
    getEnabledPlugins: () => [],
    getVoiceConfig: () => ({ stt: "mock", tts: "mock" }),
    getSocialsConfig: () => undefined,
  },
};
