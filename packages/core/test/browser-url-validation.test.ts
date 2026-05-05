/**
 * F-SSRF-1: validate that the browser plugin's URL validation rejects
 * file://, javascript:, and private/loopback hosts unless explicitly opted in.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { validateBrowseUrl } from "@choomfie/browser/session.ts";

describe("browser URL validation (F-SSRF-1)", () => {
  const original = process.env.CHOOMFIE_BROWSER_ALLOW_PRIVATE;
  beforeAll(() => {
    delete process.env.CHOOMFIE_BROWSER_ALLOW_PRIVATE;
  });
  afterAll(() => {
    if (original === undefined) {
      delete process.env.CHOOMFIE_BROWSER_ALLOW_PRIVATE;
    } else {
      process.env.CHOOMFIE_BROWSER_ALLOW_PRIVATE = original;
    }
  });

  test("rejects file:// URLs", () => {
    const result = validateBrowseUrl("file:///etc/passwd");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("scheme not allowed");
  });

  test("rejects javascript: URLs", () => {
    const result = validateBrowseUrl("javascript:alert(1)");
    expect(result.ok).toBe(false);
  });

  test("rejects chrome:// URLs", () => {
    const result = validateBrowseUrl("chrome://gpu");
    expect(result.ok).toBe(false);
  });

  test("rejects data: URLs", () => {
    const result = validateBrowseUrl("data:text/html,<script>1</script>");
    expect(result.ok).toBe(false);
  });

  test("rejects malformed URLs", () => {
    expect(validateBrowseUrl("not a url").ok).toBe(false);
    expect(validateBrowseUrl("").ok).toBe(false);
  });

  test("rejects loopback (127.x and localhost)", () => {
    expect(validateBrowseUrl("http://127.0.0.1/").ok).toBe(false);
    expect(validateBrowseUrl("http://127.42.0.1/").ok).toBe(false);
    expect(validateBrowseUrl("http://localhost:8080/").ok).toBe(false);
    expect(validateBrowseUrl("http://app.localhost/").ok).toBe(false);
  });

  test("rejects link-local (169.254.x — cloud metadata)", () => {
    expect(validateBrowseUrl("http://169.254.169.254/latest/meta-data/").ok).toBe(false);
  });

  test("rejects RFC 1918 (10.x, 192.168.x, 172.16-31.x)", () => {
    expect(validateBrowseUrl("http://10.0.0.1/").ok).toBe(false);
    expect(validateBrowseUrl("http://192.168.1.1/").ok).toBe(false);
    expect(validateBrowseUrl("http://172.16.0.1/").ok).toBe(false);
    expect(validateBrowseUrl("http://172.31.255.1/").ok).toBe(false);
  });

  test("172.32 is NOT private — accepts as public", () => {
    expect(validateBrowseUrl("http://172.32.0.1/").ok).toBe(true);
  });

  test("rejects IPv6 loopback / link-local / ULA", () => {
    expect(validateBrowseUrl("http://[::1]/").ok).toBe(false);
    expect(validateBrowseUrl("http://[fe80::1]/").ok).toBe(false);
    expect(validateBrowseUrl("http://[fc00::1]/").ok).toBe(false);
  });

  test("accepts public https URLs", () => {
    const result = validateBrowseUrl("https://example.com/path?q=1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url).toContain("https://example.com/");
  });

  test("accepts public http URLs", () => {
    expect(validateBrowseUrl("http://example.com/").ok).toBe(true);
  });

  test("CHOOMFIE_BROWSER_ALLOW_PRIVATE=1 lets private hosts through", () => {
    process.env.CHOOMFIE_BROWSER_ALLOW_PRIVATE = "1";
    try {
      expect(validateBrowseUrl("http://127.0.0.1/").ok).toBe(true);
      expect(validateBrowseUrl("http://localhost:8080/").ok).toBe(true);
      // file:// is still blocked even with the opt-in (scheme check is unconditional)
      expect(validateBrowseUrl("file:///etc/passwd").ok).toBe(false);
    } finally {
      delete process.env.CHOOMFIE_BROWSER_ALLOW_PRIVATE;
    }
  });
});
