/**
 * @choomfie/webbrain — make any chat website a Choomfie brain.
 *
 * Write a `SiteAdapter` (how to send one message and read the answer on that
 * site), wrap it with `defineWebBrain`, and export the result as a plugin.
 * See docs/webbrain.md.
 */

export { defineWebBrain, framePrompt, originalName, answerText, type WebBrainOptions } from "./define.ts";
export {
  LoginRequiredError,
  LayoutChangedError,
  type SiteAdapter,
  type TurnInput,
  type TurnContext,
  type TurnResult,
  type LateResult,
  type Human,
  type Locator,
  type Page,
} from "./adapter.ts";
export { pageFetch, pageFetchBytes, pageFetchOk, type PageFetchResult } from "./page-fetch.ts";
export { waitForSettledText, type SettleOptions } from "./settle.ts";
export { launchContext, type EngineName } from "./engine/launch.ts";
export { siteDir, profileDir, outboxDir, profileInUse } from "./paths.ts";
export { TabPool } from "./tabs.ts";
export { LateWatch } from "./watch.ts";
