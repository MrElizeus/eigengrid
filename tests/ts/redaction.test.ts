import { describe, expect, it } from "bun:test";
import { redactString, redactObject, redactJson } from "@eigengrid/backup";

describe("redaction", () => {
  describe("redactString", () => {
    it("redacts OpenAI API keys", () => {
      const input = "Use key sk-abc123def456ghi789jkl012 for API access";
      const result = redactString(input);
      expect(result).toContain("***REDACTED***");
      expect(result).not.toContain("sk-abc123def456ghi789jkl012");
    });

    it("redacts Anthropic API keys", () => {
      const input = "Anthropic key: sk-ant-abcdef1234567890abcdef1234";
      const result = redactString(input);
      expect(result).toContain("***REDACTED***");
      expect(result).not.toContain("sk-ant-abcdef1234567890abcdef1234");
    });

    it("redacts bearer tokens", () => {
      const input =
        "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doS68F32Gs0";
      const result = redactString(input);
      expect(result).toContain("***REDACTED***");
      expect(result).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    });

    it("redacts private key PEM blocks", () => {
      const keyPayload = "A".repeat(64); // Synthetic payload, not cryptographic key material.
      const input = `-----BEGIN PRIVATE KEY-----\n${keyPayload}\n-----END PRIVATE KEY-----`;
      const result = redactString(input);
      expect(result).toContain("***REDACTED***");
      expect(result).not.toContain(keyPayload);
    });

    it("redacts passwords in URLs", () => {
      const input = "http://user:secret123@example.com:8080/path";
      const result = redactString(input);
      expect(result).toContain("***REDACTED***");
      expect(result).not.toContain("secret123@");
    });

    it("redacts passwords containing URL-encoded at signs", () => {
      const input = "connection failed for postgres://user:SuperSecretP%40ss%21@localhost/db";
      const result = redactString(input);
      expect(result).not.toContain("SuperSecret");
      expect(result).not.toContain("P%40ss");
      expect(result).toContain("***");
    });

    it("redacts password assignments in command errors", () => {
      const result = redactString("pg_dump failed: password=SuperSecretP@ss!");
      expect(result).not.toContain("SuperSecret");
      expect(result).toContain("password=***REDACTED***");
    });

    it("redacts generic API-key assignments without leaving a replacement token", () => {
      const result = redactString('api_key="0123456789abcdef0123"');
      expect(result).toBe("api_key: ***REDACTED***");
      expect(result).not.toContain("$1");
      expect(result).not.toContain("0123456789abcdef0123");
    });

    it("redacts JWT tokens", () => {
      const input = "token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doS68F32Gs0.SomeExtra";
      const result = redactString(input);
      expect(result).toContain("***JWT-REDACTED***");
      expect(result).not.toContain("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0");
    });

    it("does not modify normal text", () => {
      const input = "This is just normal text with no secrets";
      const result = redactString(input);
      expect(result).toBe(input);
    });

    it("handles empty input", () => {
      expect(redactString("")).toBe("");
    });
  });

  describe("redactObject", () => {
    it("redacts sensitive keys in objects", () => {
      const input = {
        name: "test",
        password: "supersecret123",
        apiKey: "sk-abc123def456",
        databaseUrl: "postgres://user:password@database.test/eigengrid",
        data: { token: "some-token-value" },
      };
      const result = redactObject(input);
      expect(result.password).toBe("***REDACTED***");
      expect(result.apiKey).toBe("***REDACTED***");
      expect(result.databaseUrl).toBe("***REDACTED***");
      expect(result.data.token).toBe("***REDACTED***");
      expect(result.name).toBe("test");
      expect(input).toEqual({
        name: "test",
        password: "supersecret123",
        apiKey: "sk-abc123def456",
        databaseUrl: "postgres://user:password@database.test/eigengrid",
        data: { token: "some-token-value" },
      });
    });

    it("redacts nested objects recursively", () => {
      const input = {
        outer: {
          inner: {
            secret: "my-secret-value",
            normal: "keep-me",
          },
        },
      };
      const result = redactObject(input);
      expect((result as any).outer.inner.secret).toBe("***REDACTED***");
      expect((result as any).outer.inner.normal).toBe("keep-me");
    });

    it("redacts items in arrays", () => {
      const input = {
        items: [
          { name: "item1", apiKey: "key123" },
          { name: "item2", apiKey: "key456" },
        ],
      };
      const result = redactObject(input);
      expect((result as any).items[0].apiKey).toBe("***REDACTED***");
      expect((result as any).items[1].apiKey).toBe("***REDACTED***");
      expect((result as any).items[0].name).toBe("item1");
    });

    it("handles null and primitive values", () => {
      expect(redactObject(null)).toBe(null);
      expect(redactObject(42)).toBe(42);
      expect(redactObject("hello")).toBe("hello");
    });
  });

  describe("redactJson", () => {
    it("redacts sensitive data in JSON strings", () => {
      const input = JSON.stringify({
        apiKey: "sk-abc123def456ghi789jkl012",
        password: "hunter2",
      });
      const result = redactJson(input);
      const parsed = JSON.parse(result);
      expect(parsed.apiKey).toBe("***REDACTED***");
      expect(parsed.password).toBe("***REDACTED***");
    });

    it("falls back to plain text redaction for invalid JSON", () => {
      const input = "Some text with sk-abc123def456ghi789jkl012 key";
      const result = redactJson(input);
      expect(result).toContain("***REDACTED***");
      expect(result).not.toContain("sk-abc123def456ghi789jkl012");
    });
  });
});
