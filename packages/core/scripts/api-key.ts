#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { OpenAIAPIKeyManager } from "../lib/openai/auth.ts";
import { getOpenAIEndpointDataDir } from "../lib/openai/config.ts";

function usage(): never {
  console.error(`Usage:
  choomfie api-key issue <app> --scopes chat,models
  choomfie api-key list
  choomfie api-key revoke <id-or-prefix>`);
  process.exit(2);
}

function parseScopes(args: string[]): string[] {
  const equalsArg = args.find((arg) => arg.startsWith("--scopes="));
  if (equalsArg) {
    return equalsArg.slice("--scopes=".length).split(",");
  }

  const index = args.indexOf("--scopes");
  if (index >= 0 && args[index + 1]) {
    return args[index + 1].split(",");
  }

  return ["chat", "models"];
}

const [command, ...args] = process.argv.slice(2);
if (!command) usage();

const dataDir = getOpenAIEndpointDataDir();
mkdirSync(dataDir, { recursive: true });
const manager = new OpenAIAPIKeyManager(dataDir);

try {
  if (command === "issue") {
    const app = args[0];
    if (!app || app.startsWith("-")) usage();

    const issued = manager.issue(app, parseScopes(args.slice(1)));
    console.log(`Token: ${issued.token}`);
    console.log(`Key ID: ${issued.key.id}`);
    console.log(`App: ${issued.key.app}`);
    console.log(`Scopes: ${issued.key.scopes.join(",")}`);
    console.log("Store: hash-only");
  } else if (command === "list") {
    const keys = manager.list();
    if (keys.length === 0) {
      console.log("No OpenAI endpoint API keys found.");
    } else {
      for (const key of keys) {
        const status = key.revoked_at ? `revoked ${key.revoked_at}` : "active";
        console.log(`${key.id}\t${key.prefix}\t${key.app}\t${key.scopes.join(",")}\t${status}`);
      }
    }
  } else if (command === "revoke") {
    const selector = args[0];
    if (!selector) usage();

    const revoked = manager.revoke(selector);
    if (!revoked) {
      console.error(`API key not found: ${selector}`);
      process.exit(1);
    }
    console.log(`Revoked ${revoked.id} (${revoked.prefix})`);
  } else {
    usage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
