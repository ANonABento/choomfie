/**
 * SRS singleton — breaks circular dependency between index.ts and tools.ts.
 */

import type { SRSManager } from "./srs.ts";

let _srs: SRSManager | null = null;

export function setSRS(manager: SRSManager | null) {
  _srs = manager;
}

export function getSRS(): SRSManager | null {
  return _srs;
}
