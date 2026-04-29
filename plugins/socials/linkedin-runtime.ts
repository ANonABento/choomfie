import type { PluginContext } from "@choomfie/shared";
import { LinkedInClient } from "./providers/linkedin/api.ts";
import { LinkedInMonitor } from "./providers/linkedin/monitor.ts";
import { LinkedInScheduler } from "./providers/linkedin/scheduler.ts";
import { requireNonEmptyString } from "./config.ts";

let linkedInClient: LinkedInClient | null = null;
let linkedInMonitor: LinkedInMonitor | null = null;
let linkedInScheduler: LinkedInScheduler | null = null;

export function getLinkedInClient(ctx: PluginContext): LinkedInClient {
  if (linkedInClient) return linkedInClient;

  const config = ctx.config.getConfig();
  const socialsConfig = config.socials?.linkedin;

  if (!socialsConfig?.clientId || !socialsConfig?.clientSecret) {
    throw new Error(
      "LinkedIn not configured. Add socials.linkedin.clientId and socials.linkedin.clientSecret to config.json. " +
      "Create a LinkedIn app at https://developer.linkedin.com first.",
    );
  }

  linkedInClient = new LinkedInClient(
    ctx.DATA_DIR,
    requireNonEmptyString(socialsConfig.clientId, "socials.linkedin.clientId"),
    requireNonEmptyString(socialsConfig.clientSecret, "socials.linkedin.clientSecret"),
  );
  return linkedInClient;
}

export function getLinkedInMonitor(ctx: PluginContext): LinkedInMonitor | null {
  if (linkedInMonitor) return linkedInMonitor;
  try {
    const client = getLinkedInClient(ctx);
    linkedInMonitor = new LinkedInMonitor(`${ctx.DATA_DIR}/choomfie.db`, client);
    return linkedInMonitor;
  } catch {
    return null;
  }
}

export function getLinkedInScheduler(ctx: PluginContext): LinkedInScheduler | null {
  if (linkedInScheduler) return linkedInScheduler;
  try {
    const client = getLinkedInClient(ctx);
    const monitor = getLinkedInMonitor(ctx);
    linkedInScheduler = new LinkedInScheduler(`${ctx.DATA_DIR}/choomfie.db`, client, monitor);
    return linkedInScheduler;
  } catch {
    return null;
  }
}

export function destroyLinkedInClient(): void {
  linkedInScheduler?.destroy();
  linkedInScheduler = null;
  linkedInMonitor?.destroy();
  linkedInMonitor = null;
  linkedInClient?.destroy();
  linkedInClient = null;
}
