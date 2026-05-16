import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OPENAI_API_KEY_FILE_MODE,
  OPENAI_API_KEYS_FILE,
  OpenAIAPIKeyManager,
} from "../lib/openai/auth.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "choomfie-openai-auth-"));
  tempDirs.push(dir);
  return dir;
}

test("API key issue stores only a hash in a 0600 key file", () => {
  const dir = makeTempDir();
  const manager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));

  const issued = manager.issue("ExampleApp", ["models", "chat"]);
  const keyPath = join(dir, OPENAI_API_KEYS_FILE);

  expect(existsSync(keyPath)).toBe(true);
  expect(statSync(keyPath).mode & 0o777).toBe(OPENAI_API_KEY_FILE_MODE);

  const rawStore = readFileSync(keyPath, "utf-8");
  expect(rawStore).not.toContain(issued.token);
  expect(issued.key.prefix).toBe("sk-choomfie-exampleapp");
  expect(issued.key.token_hash.startsWith("sha256:")).toBe(true);
  expect(issued.key.scopes).toEqual(["chat", "models"]);
});

test("API key verification accepts bearer tokens by scope and updates last_used_at", () => {
  const dir = makeTempDir();
  let now = new Date("2026-05-16T00:00:00.000Z");
  const manager = new OpenAIAPIKeyManager(dir, () => now);
  const issued = manager.issue("exampleapp", ["chat"]);

  now = new Date("2026-05-16T00:01:00.000Z");
  const verified = manager.verifyAuthorizationHeader(`Bearer ${issued.token}`, ["models", "chat"]);

  expect(verified?.key.id).toBe(issued.key.id);
  expect(manager.list()[0].last_used_at).toBe("2026-05-16T00:01:00.000Z");
  expect(statSync(join(dir, OPENAI_API_KEYS_FILE)).mode & 0o777).toBe(OPENAI_API_KEY_FILE_MODE);
  expect(manager.verifyAuthorizationHeader(`Bearer ${issued.token}`, ["memory"])).toBeNull();
  expect(manager.verifyAuthorizationHeader(issued.token, ["chat"])).toBeNull();
});

test("API key revoke disables future verification", () => {
  const dir = makeTempDir();
  const manager = new OpenAIAPIKeyManager(dir, () => new Date("2026-05-16T00:00:00.000Z"));
  const issued = manager.issue("exampleapp", ["chat"]);

  const revoked = manager.revoke(issued.key.id);

  expect(revoked?.id).toBe(issued.key.id);
  expect(revoked?.revoked_at).toBe("2026-05-16T00:00:00.000Z");
  expect(statSync(join(dir, OPENAI_API_KEYS_FILE)).mode & 0o777).toBe(OPENAI_API_KEY_FILE_MODE);
  expect(manager.verify(issued.token, ["chat"])).toBeNull();
});

test("choomfie api-key CLI issues one visible token and stores hash-only metadata", () => {
  const dir = makeTempDir();
  const result = Bun.spawnSync(
    ["bun", "packages/core/scripts/api-key.ts", "issue", "exampleapp", "--scopes", "chat,models"],
    {
      cwd: process.cwd(),
      env: { ...process.env, CHOOMFIE_DATA_DIR: dir },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  expect(result.exitCode).toBe(0);
  const stdout = new TextDecoder().decode(result.stdout);
  const token = stdout.match(/Token: (sk-choomfie-exampleapp-[^\s]+)/)?.[1];
  expect(token).toBeTruthy();
  expect(stdout.match(/sk-choomfie-exampleapp-/g)).toHaveLength(1);

  const rawStore = readFileSync(join(dir, OPENAI_API_KEYS_FILE), "utf-8");
  expect(rawStore).not.toContain(token!);
  expect(rawStore).toContain("sha256:");
});

test("choomfie api-key CLI lists and revokes issued keys", () => {
  const dir = makeTempDir();
  const env = { ...process.env, CHOOMFIE_DATA_DIR: dir };
  const issue = Bun.spawnSync(
    ["bun", "packages/core/scripts/api-key.ts", "issue", "exampleapp", "--scopes", "chat,models"],
    {
      cwd: process.cwd(),
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(issue.exitCode).toBe(0);
  const issueStdout = new TextDecoder().decode(issue.stdout);
  const keyId = issueStdout.match(/Key ID: (key_[^\s]+)/)?.[1];
  const token = issueStdout.match(/Token: (sk-choomfie-exampleapp-[^\s]+)/)?.[1];
  expect(keyId).toBeTruthy();
  expect(token).toBeTruthy();

  const listBefore = Bun.spawnSync(
    ["bun", "packages/core/scripts/api-key.ts", "list"],
    {
      cwd: process.cwd(),
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const listBeforeStdout = new TextDecoder().decode(listBefore.stdout);
  expect(listBefore.exitCode).toBe(0);
  expect(listBeforeStdout).toContain(keyId!);
  expect(listBeforeStdout).toContain("sk-choomfie-exampleapp");
  expect(listBeforeStdout).toContain("chat,models");
  expect(listBeforeStdout).toContain("active");
  expect(listBeforeStdout).not.toContain(token!);

  const revoke = Bun.spawnSync(
    ["bun", "packages/core/scripts/api-key.ts", "revoke", keyId!],
    {
      cwd: process.cwd(),
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const revokeStdout = new TextDecoder().decode(revoke.stdout);
  expect(revoke.exitCode).toBe(0);
  expect(revokeStdout).toContain(`Revoked ${keyId}`);

  const listAfter = Bun.spawnSync(
    ["bun", "packages/core/scripts/api-key.ts", "list"],
    {
      cwd: process.cwd(),
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const listAfterStdout = new TextDecoder().decode(listAfter.stdout);
  expect(listAfter.exitCode).toBe(0);
  expect(listAfterStdout).toContain(keyId!);
  expect(listAfterStdout).toContain("revoked ");
});
