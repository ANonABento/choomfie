/**
 * LocalMcpStub — stand-in for the MCP transport in local mode.
 *
 * In supervisor mode, ctx.mcp is the real MCP Server (or McpProxy in worker)
 * and code calls ctx.mcp.notification(...) to push Discord events to Claude.
 * In local mode, those calls are no-ops since there's no Claude Code to ping.
 *
 * Permission requests are auto-allowed (the user is the operator on a personal
 * machine — no remote Claude is requesting elevation).
 */

import type { McpTransport, NotificationMessage } from "@choomfie/shared";

export class LocalMcpStub implements McpTransport {
  notification(_msg: NotificationMessage): void {
    // No-op: nobody to notify.
  }

  requestRestart(reason: string, _chat_id?: string): void {
    console.error(`[local] restart requested (${reason}) — local mode does not auto-restart`);
  }

  setNotificationHandler(
    _schema: unknown,
    _handler: (msg: { params: Record<string, unknown> }) => Promise<void>,
  ): void {
    // No notifications ever arrive in local mode.
  }
}
