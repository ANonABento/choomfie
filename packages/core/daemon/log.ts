import { FLAG_VERBOSE } from "./flags.ts";

export function log(msg: string): void {
  console.error(`[daemon] ${new Date().toISOString()} ${msg}`);
}

export function verbose(msg: string): void {
  if (FLAG_VERBOSE) console.error(`[daemon:debug] ${new Date().toISOString()} ${msg}`);
}
