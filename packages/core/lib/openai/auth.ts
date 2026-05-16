import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";

export const OPENAI_API_KEYS_FILE = "openai-api-keys.json";
export const OPENAI_API_KEY_FILE_MODE = 0o600;

export interface OpenAIAPIKeyMetadata {
  id: string;
  prefix: string;
  token_hash: string;
  app: string;
  scopes: string[];
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface OpenAIAPIKeyStore {
  keys: OpenAIAPIKeyMetadata[];
}

export interface IssuedOpenAIAPIKey {
  token: string;
  key: OpenAIAPIKeyMetadata;
}

export interface VerifiedOpenAIAPIKey {
  key: OpenAIAPIKeyMetadata;
}

function normalizeApp(app: string): string {
  return app.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeScopes(scopes: string[]): string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
}

function sha256Token(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

function hashMatches(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

function readStore(path: string): OpenAIAPIKeyStore {
  if (!existsSync(path)) return { keys: [] };
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<OpenAIAPIKeyStore>;
  return { keys: Array.isArray(parsed.keys) ? parsed.keys : [] };
}

function writeStore(path: string, store: OpenAIAPIKeyStore) {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(store, null, 2), { mode: OPENAI_API_KEY_FILE_MODE });
  chmodSync(tmpPath, OPENAI_API_KEY_FILE_MODE);
  renameSync(tmpPath, path);
  chmodSync(path, OPENAI_API_KEY_FILE_MODE);
}

export class OpenAIAPIKeyManager {
  readonly path: string;

  constructor(dataDir: string, private readonly now: () => Date = () => new Date()) {
    this.path = join(dataDir, OPENAI_API_KEYS_FILE);
  }

  list(): OpenAIAPIKeyMetadata[] {
    return readStore(this.path).keys;
  }

  issue(app: string, scopes: string[]): IssuedOpenAIAPIKey {
    const normalizedApp = normalizeApp(app);
    if (!normalizedApp) {
      throw new Error("App name is required");
    }

    const normalizedScopes = normalizeScopes(scopes);
    if (normalizedScopes.length === 0) {
      throw new Error("At least one scope is required");
    }

    const token = `sk-choomfie-${normalizedApp}-${randomBytes(24).toString("base64url")}`;
    const createdAt = this.now().toISOString();
    const key: OpenAIAPIKeyMetadata = {
      id: randomId("key"),
      prefix: `sk-choomfie-${normalizedApp}`,
      token_hash: sha256Token(token),
      app: normalizedApp,
      scopes: normalizedScopes,
      created_at: createdAt,
      revoked_at: null,
      last_used_at: null,
    };

    const store = readStore(this.path);
    store.keys.push(key);
    writeStore(this.path, store);

    return { token, key };
  }

  revoke(idOrPrefix: string): OpenAIAPIKeyMetadata | null {
    const selector = idOrPrefix.trim();
    if (!selector) return null;

    const store = readStore(this.path);
    const key = store.keys.find((candidate) => {
      return candidate.id === selector || candidate.prefix === selector || candidate.prefix.startsWith(selector);
    });

    if (!key) return null;
    if (!key.revoked_at) key.revoked_at = this.now().toISOString();
    writeStore(this.path, store);
    return key;
  }

  verify(token: string, requiredAnyScopes: string[] = []): VerifiedOpenAIAPIKey | null {
    const tokenHash = sha256Token(token);
    const store = readStore(this.path);
    const key = store.keys.find((candidate) => hashMatches(candidate.token_hash, tokenHash));
    if (!key || key.revoked_at) return null;

    if (requiredAnyScopes.length > 0 && !requiredAnyScopes.some((scope) => key.scopes.includes(scope))) {
      return null;
    }

    key.last_used_at = this.now().toISOString();
    writeStore(this.path, store);
    return { key };
  }

  verifyAuthorizationHeader(
    authorization: string | null,
    requiredAnyScopes: string[] = [],
  ): VerifiedOpenAIAPIKey | null {
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    return this.verify(match[1], requiredAnyScopes);
  }
}
