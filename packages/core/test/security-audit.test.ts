/**
 * Regression tests for the 2026-05-04 security audit findings.
 * See docs/security-audit-2026-05-04.md.
 */

import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, statSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageFlags } from "discord.js";
import { buttonHandlers, modalHandlers } from "@choomfie/shared";
import { saveAccess, SECRET_FILE_MODE } from "../lib/context.ts";
import { validateAttachmentPath } from "../lib/tools/discord-tools.ts";
import { isOwner } from "../lib/access.ts";
import type { AppContext } from "../lib/types.ts";

beforeAll(async () => {
  await import("../lib/handlers/permission-buttons.ts");
  await import("../lib/handlers/modals.ts");
});

type Spy = ((...args: any[]) => any) & { calls: any[][] };
function spy(): Spy {
  const fn: any = (...args: any[]) => {
    fn.calls.push(args);
  };
  fn.calls = [];
  return fn;
}

// --- F-PERM-1: permission button bypass when no owner is set ---

describe("F-PERM-1: permission button rejects in bootstrap mode", () => {
  function makeFakes(opts: { ownerUserId: string | null; userId: string }) {
    const interaction = {
      user: { id: opts.userId },
      message: { embeds: [] },
      reply: spy(),
      update: spy(),
    } as any;
    const ctx = {
      ownerUserId: opts.ownerUserId,
      mcp: { notification: spy() },
    } as any;
    return { interaction, ctx };
  }

  test("ownerUserId=null and any userId -> rejected, no notification fired", async () => {
    const handler = buttonHandlers.get("permission")!;
    const { interaction, ctx } = makeFakes({ ownerUserId: null, userId: "anyone" });
    await handler(interaction, ["permission", "allow", "abcde"], ctx);

    expect(ctx.mcp.notification.calls).toHaveLength(0);
    expect(interaction.update.calls).toHaveLength(0);
    expect(interaction.reply.calls[0][0].content).toContain("Only the owner");
  });

  test("ownerUserId set, non-owner click -> rejected (regression)", async () => {
    const handler = buttonHandlers.get("permission")!;
    const { interaction, ctx } = makeFakes({ ownerUserId: "owner", userId: "intruder" });
    await handler(interaction, ["permission", "allow", "abcde"], ctx);

    expect(ctx.mcp.notification.calls).toHaveLength(0);
    expect(interaction.reply.calls[0][0].content).toContain("Only the owner");
  });

  test("ownerUserId set, owner click -> accepted (regression)", async () => {
    const handler = buttonHandlers.get("permission")!;
    const { interaction, ctx } = makeFakes({ ownerUserId: "owner", userId: "owner" });
    await handler(interaction, ["permission", "allow", "abcde"], ctx);

    expect(ctx.mcp.notification.calls).toHaveLength(1);
    expect(interaction.reply.calls).toHaveLength(0);
  });
});

// --- F-PERM-2: permission reply (discord.ts) gating uses isOwner ---
//
// discord.ts now calls isOwner(ctx, userId) directly to gate the
// `yes <code>` / `no <code>` permission reply path. Pin the bootstrap-mode
// and non-owner cases so a future refactor can't reintroduce the
// "any allowlisted user can approve" bypass.

describe("F-PERM-2: isOwner gates permission replies (discord.ts)", () => {
  test("bootstrap mode (ownerUserId=null): allowlisted user is rejected", () => {
    const ctx = {
      ownerUserId: null,
      allowedUsers: new Set(["buddy"]),
    } as unknown as AppContext;
    expect(isOwner(ctx, "buddy")).toBe(false);
  });

  test("bootstrap mode: any user is rejected", () => {
    const ctx = {
      ownerUserId: null,
      allowedUsers: new Set<string>(),
    } as unknown as AppContext;
    expect(isOwner(ctx, "anyone")).toBe(false);
  });

  test("owner set: non-owner allowlisted user is rejected", () => {
    const ctx = {
      ownerUserId: "owner",
      allowedUsers: new Set(["owner", "buddy"]),
    } as unknown as AppContext;
    expect(isOwner(ctx, "buddy")).toBe(false);
  });

  test("owner set: matching userId returns true", () => {
    const ctx = {
      ownerUserId: "owner",
      allowedUsers: new Set(["owner"]),
    } as unknown as AppContext;
    expect(isOwner(ctx, "owner")).toBe(true);
  });
});

// --- F-PERM-3: modal handlers re-check ownership ---

describe("F-PERM-3: modal handlers reject non-owner submissions", () => {
  function makeModalFakes(opts: {
    ownerUserId: string | null;
    userId: string;
    fields: Record<string, string>;
  }) {
    const interaction = {
      user: { id: opts.userId },
      fields: {
        getTextInputValue: (key: string) => opts.fields[key] ?? "",
      },
      reply: spy(),
    } as any;
    const setCoreMemory = spy();
    const savePersona = spy();
    const ctx = {
      ownerUserId: opts.ownerUserId,
      memory: { setCoreMemory },
      config: { savePersona },
    } as any;
    return { interaction, ctx, setCoreMemory, savePersona };
  }

  test("modal-persona: non-owner is rejected, savePersona never called", async () => {
    const handler = modalHandlers.get("modal-persona")!;
    const { interaction, ctx, savePersona } = makeModalFakes({
      ownerUserId: "owner",
      userId: "intruder",
      fields: { key: "evil", name: "Evil", personality: "rm -rf" },
    });
    await handler(interaction, ["modal-persona"], ctx);

    expect(savePersona.calls).toHaveLength(0);
    expect(interaction.reply.calls[0][0].content).toContain("Only the owner");
    expect(interaction.reply.calls[0][0].flags).toBe(MessageFlags.Ephemeral);
  });

  test("modal-persona: bootstrap mode (owner=null) rejects everyone", async () => {
    const handler = modalHandlers.get("modal-persona")!;
    const { interaction, ctx, savePersona } = makeModalFakes({
      ownerUserId: null,
      userId: "anyone",
      fields: { key: "evil", name: "Evil", personality: "x" },
    });
    await handler(interaction, ["modal-persona"], ctx);

    expect(savePersona.calls).toHaveLength(0);
    expect(interaction.reply.calls[0][0].content).toContain("Only the owner");
  });

  test("modal-memory: non-owner is rejected, setCoreMemory never called", async () => {
    const handler = modalHandlers.get("modal-memory")!;
    const { interaction, ctx, setCoreMemory } = makeModalFakes({
      ownerUserId: "owner",
      userId: "intruder",
      fields: { key: "evil", value: "bad" },
    });
    await handler(interaction, ["modal-memory"], ctx);

    expect(setCoreMemory.calls).toHaveLength(0);
    expect(interaction.reply.calls[0][0].content).toContain("Only the owner");
  });

  test("modal-persona: owner submission is accepted (regression)", async () => {
    const handler = modalHandlers.get("modal-persona")!;
    const { interaction, ctx, savePersona } = makeModalFakes({
      ownerUserId: "owner",
      userId: "owner",
      fields: { key: "Pirate Bob", name: "Bob", personality: "Arr." },
    });
    await handler(interaction, ["modal-persona"], ctx);

    expect(savePersona.calls).toHaveLength(1);
    expect(savePersona.calls[0]).toEqual(["pirate-bob", "Bob", "Arr."]);
  });
});

// --- F-TOKEN-1: secret files are written 0600 ---

describe("F-TOKEN-1: saveAccess writes 0600", () => {
  test("access.json mode is 0o600 after saveAccess", async () => {
    const dir = mkdtempSync(join(tmpdir(), "choomfie-audit-"));
    const accessPath = join(dir, "access.json");
    try {
      // Pre-create with 0644 to prove saveAccess tightens it
      writeFileSync(accessPath, "{}", { mode: 0o644 });
      expect(statSync(accessPath).mode & 0o777).toBe(0o644);

      const ctx = {
        accessPath,
        ownerUserId: "owner-id",
        allowedUsers: new Set(["owner-id", "buddy"]),
      } as unknown as AppContext;

      await saveAccess(ctx);

      const mode = statSync(accessPath).mode & 0o777;
      expect(mode).toBe(SECRET_FILE_MODE);
      expect(SECRET_FILE_MODE).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- F-TOKEN-1 (extension): writeFileSync({ mode }) is incomplete ---
//
// Node's `writeFileSync(path, data, { mode })` only applies the mode on file
// *creation*. When overwriting an existing file the mode arg is ignored, so
// pre-existing 0o644 token files never get tightened. Pin this behaviour
// (so the assumption stays documented) and verify that an explicit chmodSync
// after the write is what actually closes the gap.
describe("F-TOKEN-1 (extension): writeFileSync mode option does not tighten existing files", () => {
  test("writeFileSync({ mode: 0o600 }) leaves an existing 0o644 file at 0o644", () => {
    const dir = mkdtempSync(join(tmpdir(), "choomfie-tok-"));
    const file = join(dir, "tokens.json");
    try {
      writeFileSync(file, "a", { mode: 0o644 });
      expect(statSync(file).mode & 0o777).toBe(0o644);
      writeFileSync(file, "b", { mode: 0o600 });
      // Documented Node behaviour — proves why a chmodSync follow-up is needed.
      expect(statSync(file).mode & 0o777).toBe(0o644);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("explicit chmodSync after writeFileSync tightens to 0o600", () => {
    const dir = mkdtempSync(join(tmpdir(), "choomfie-tok-"));
    const file = join(dir, "tokens.json");
    try {
      writeFileSync(file, "a", { mode: 0o644 });
      writeFileSync(file, "b", { mode: 0o600 });
      chmodSync(file, 0o600);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- F-PATH-1: reply tool attachment path validation ---

describe("F-PATH-1: validateAttachmentPath blocks paths outside allowed roots", () => {
  test("rejects /etc/passwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "choomfie-audit-"));
    try {
      const result = validateAttachmentPath("/etc/passwd", dir);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("outside allowed roots");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects ~/.ssh/id_rsa", () => {
    const dir = mkdtempSync(join(tmpdir(), "choomfie-audit-"));
    try {
      const result = validateAttachmentPath(
        join(process.env.HOME ?? "/tmp", ".ssh", "id_rsa"),
        dir
      );
      expect(result.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects path with .. traversal", () => {
    const dir = mkdtempSync(join(tmpdir(), "choomfie-audit-"));
    try {
      const inbox = join(dir, "inbox");
      mkdirSync(inbox, { recursive: true });
      const traversal = join(inbox, "..", "..", "..", "etc", "passwd");
      const result = validateAttachmentPath(traversal, dir);
      expect(result.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts files in DATA_DIR/inbox", () => {
    const dir = mkdtempSync(join(tmpdir(), "choomfie-audit-"));
    try {
      const inbox = join(dir, "inbox");
      mkdirSync(inbox, { recursive: true });
      const file = join(inbox, "attached.png");
      writeFileSync(file, "x");
      const result = validateAttachmentPath(file, dir);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts files in DATA_DIR/browser/screenshots", () => {
    const dir = mkdtempSync(join(tmpdir(), "choomfie-audit-"));
    try {
      const screenshots = join(dir, "browser", "screenshots");
      mkdirSync(screenshots, { recursive: true });
      const file = join(screenshots, "shot.png");
      writeFileSync(file, "x");
      const result = validateAttachmentPath(file, dir);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects nonexistent paths (realpath fails)", () => {
    const dir = mkdtempSync(join(tmpdir(), "choomfie-audit-"));
    try {
      const result = validateAttachmentPath("/var/empty/never-exists.png", dir);
      expect(result.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects empty / non-string", () => {
    expect(validateAttachmentPath("", "/tmp").ok).toBe(false);
    expect(validateAttachmentPath("   ", "/tmp").ok).toBe(false);
  });
});
