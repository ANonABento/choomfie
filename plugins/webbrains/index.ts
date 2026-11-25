/**
 * Web brains plugin — chat websites as Choomfie brains, one file per site in
 * `sites/`, on the web-brain kit (`@choomfie/webbrain`, docs/webbrain.md).
 *
 * Each site whose profile is logged in (`bun run webbrain login <id>`)
 * registers as a brain when the plugin is enabled; `webbrain sites` lists
 * them. Adding a site: one file in `sites/` and a line below.
 *
 * Waymond stays its own plugin: it brings tools, approval cards and plan boards.
 */

import { defineWebBrains, type SiteAdapter } from "@choomfie/webbrain";
import { geminiAdapter } from "./sites/gemini.ts";

export const adapters: SiteAdapter[] = [geminiAdapter];

export default defineWebBrains("webbrains", adapters);
