/**
 * Waymond plugin — Ambition's Waymond as a Choomfie brain, built on the
 * web-brain kit (@choomfie/webbrain). Everything Ambition-specific is in
 * adapter.ts and api.ts.
 *
 * Enable with `/plugins`, log in once with `bun run webbrain login waymond`,
 * then `/brain waymond` in a channel. No tools and no instructions: it costs
 * the Claude session nothing.
 */

import { defineWebBrain } from "@choomfie/webbrain";
import { waymondAdapter } from "./adapter.ts";

export { waymondAdapter as adapter, toApproval } from "./adapter.ts";
export { framePrompt, originalName } from "@choomfie/webbrain";

export default defineWebBrain(waymondAdapter);
