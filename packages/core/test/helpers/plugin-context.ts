import type { PluginContext, AutomodConfig } from "@choomfie/shared";

const DEFAULT_TEST_AUTOMOD: AutomodConfig = {
  maxMessagesPerMinute: 20,
  bannedWords: [],
  action: "warn",
};

export const testPluginContext: PluginContext = {
  DATA_DIR: "/tmp/choomfie-test",
  config: {
    getConfig: () => ({}),
    getEnabledPlugins: () => [],
    getVoiceConfig: () => ({ stt: "mock", tts: "mock" }),
    getSocialsConfig: () => undefined,
    getAutomodConfig: () => ({ ...DEFAULT_TEST_AUTOMOD, bannedWords: [...DEFAULT_TEST_AUTOMOD.bannedWords] }),
    setAutomodConfig: () => {},
  },
};
