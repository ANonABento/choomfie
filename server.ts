#!/usr/bin/env bun
/**
 * Choomfie — Claude Code plugin for Discord.
 *
 * Entry point — delegates to supervisor.ts which manages the worker process.
 * See docs/supervisor-architecture.md for architecture details.
 */

import "./supervisor.ts";
