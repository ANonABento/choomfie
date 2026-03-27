/**
 * System tools — worker-side system operations.
 *
 * The restart tool has moved to supervisor.ts (supervisor-owned).
 * This file is kept for any future worker-side system tools.
 */

import type { ToolDef } from "../types.ts";

export const systemTools: ToolDef[] = [];
