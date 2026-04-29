/**
 * Permission relay — forwards tool approval requests to Discord owner DM.
 */

import type { AppContext } from "./types.ts";
import {
  buildPermissionMessage,
  buildPermissionTextFallback,
} from "./handlers/permission-buttons.ts";
import {
  PermissionRequestNotificationSchema,
  requirePermissionRequestParams,
} from "./permission-schema.ts";

export function registerPermissionRelay(ctx: AppContext) {
  ctx.mcp.setNotificationHandler(
    PermissionRequestNotificationSchema,
    async ({ params }) => {
      const permissionParams = requirePermissionRequestParams(params);
      const message = buildPermissionMessage(permissionParams);
      const textFallback = buildPermissionTextFallback(permissionParams);

      // Only send permission requests to the owner (security layer 3)
      const permTarget = ctx.ownerUserId
        ? [ctx.ownerUserId]
        : [...ctx.allowedUsers];
      for (const uid of permTarget) {
        let user;
        try {
          user = await ctx.discord.users.fetch(uid);
        } catch {
          continue;
        }
        try {
          await user.send(message);
        } catch {
          // Embed/components send failed (component quota, API change, etc.).
          // Fall back to plain text so `yes <code>` / `no <code>` still works
          // via PERMISSION_REPLY_RE in discord.ts.
          try {
            await user.send(textFallback);
          } catch {
            // DMs disabled — give up silently.
          }
        }
      }
    }
  );
}
