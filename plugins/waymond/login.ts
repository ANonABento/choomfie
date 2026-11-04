#!/usr/bin/env bun
/**
 * One-time Waymond login. Opens a visible browser on the plugin's own profile;
 * sign in to Ambition, then close the window. The headless driver reuses the
 * saved session afterwards.
 *
 *   bun run waymond:login
 *
 * Stop Choomfie first (or at least don't message a Waymond channel meanwhile):
 * two browsers can't share one profile directory.
 */

import { resolveDataDir } from "@choomfie/shared";
import { APP_ORIGIN } from "./api.ts";
import { launchWaymondContext } from "./driver.ts";
import { profileDir } from "./paths.ts";

const dir = profileDir(resolveDataDir());
console.error(`Opening Ambition with profile ${dir}`);
console.error("Sign in, check that the Waymond chat loads, then close the window.");

const context = await launchWaymondContext(dir, false);
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(`${APP_ORIGIN}/chat`);
await new Promise<void>((resolve) => context.on("close", () => resolve()));
console.error("Saved. Choomfie's Waymond brain will use this session.");
