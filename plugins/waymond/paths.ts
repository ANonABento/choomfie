import { mkdirSync } from "node:fs";
import { join } from "node:path";

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const waymondDir = (dataDir: string) => ensure(join(dataDir, "waymond"));
export const profileDir = (dataDir: string) => ensure(join(waymondDir(dataDir), "profile"));
export const chatMapPath = (dataDir: string) => join(waymondDir(dataDir), "chats.json");
