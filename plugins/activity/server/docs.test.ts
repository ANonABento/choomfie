import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/** Every Developer Portal field the Activity needs (Req 10) */
const PORTAL_FIELDS = [
  "Enable Activities",
  "URL Mappings",
  "Prefix",
  "Target",
  "Redirects",
  "Client ID",
  "Client Secret",
  "identify",
  "applications.commands",
  "Installation Contexts",
  "ACTIVITY_ALLOWLIST",
];

const read = (rel: string) => Bun.file(join(import.meta.dirname, "../../..", rel)).text();

describe("activity docs", () => {
  test("docs/activity.md lists every portal field", async () => {
    const doc = await read("docs/activity.md");
    for (const field of PORTAL_FIELDS) expect(doc).toContain(field);
  });

  test("voice docs explain switching pipelines", async () => {
    const doc = await read("docs/voice-plugin.md");
    expect(doc).toContain("## Switching voice pipelines");
    expect(doc).toContain('"pipeline": "realtime"');
  });
});
