import type { AnyObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z } from "zod";

export const PERMISSION_REQUEST_METHOD =
  "notifications/claude/channel/permission_request" as const;

export interface PermissionRequestParams {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
}

export interface PermissionRequestNotification {
  method: typeof PERMISSION_REQUEST_METHOD;
  params: PermissionRequestParams;
}

export function requirePermissionRequestParams(
  params: Record<string, unknown>
): PermissionRequestParams {
  const { request_id, tool_name, description, input_preview } = params;
  if (
    typeof request_id !== "string" ||
    typeof tool_name !== "string" ||
    typeof description !== "string" ||
    typeof input_preview !== "string"
  ) {
    throw new Error("Invalid permission request notification params.");
  }

  return {
    request_id,
    tool_name,
    description,
    input_preview,
  };
}

const permissionRequestNotificationSchema = z.object({
  method: z.literal(PERMISSION_REQUEST_METHOD),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

// Avoid TypeScript's deep-instantiation limit when MCP infers from nested Zod.
export const PermissionRequestNotificationSchema =
  permissionRequestNotificationSchema as unknown as AnyObjectSchema;
