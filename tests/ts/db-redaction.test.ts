import { describe, expect, it } from "bun:test";
import { redactObject, redactJson } from "@eigengrid/backup";

describe("DATABASE_URL redaction in manifests", () => {
  it("redacts DATABASE_URL from config manifests via backup redact", () => {
    const manifest = {
      format: "eigengrid-backup",
      config: {
        databaseUrl: "postgres://admin:SuperSecretP@ss!@db.example.com:5432/eigengrid",
        dbProvider: "postgres",
      },
    };

    const redacted = redactObject(manifest);
    const url = (redacted as any).config.databaseUrl;
    expect(url).toBe("***REDACTED***");
  });

  it("redacts password in postgres:// URLs within JSON", () => {
    const json = JSON.stringify({
      DATABASE_URL: "postgres://user:secret123@localhost:5432/db",
    });

    const redacted = redactJson(json);
    expect(redacted).not.toContain("secret123");
    expect(redacted).toContain("***");
  });

  it("redacts databaseUrl field values in config JSON", () => {
    const config = {
      databaseUrl: "postgres://myuser:MyS3cret@host:5432/mydb",
    };

    const redacted = redactObject(config);
    const url = (redacted as any).databaseUrl;
    expect(url).toBe("***REDACTED***");
  });

  it("preserves SQLite databasePath (not redacted)", () => {
    const manifest = {
      databasePath: "/home/user/.eigengrid/eigengrid.sqlite",
      dbProvider: "sqlite",
    };

    const redacted = redactObject(manifest);
    expect((redacted as any).databasePath).toBe("/home/user/.eigengrid/eigengrid.sqlite");
    expect((redacted as any).dbProvider).toBe("sqlite");
  });

  it("redacts DATABASE_URL from error messages", () => {
    const url = "postgres://admin:supersecret@localhost:5432/eigengrid";
    const errorMsg = `Cannot connect to PostgreSQL using ${url}`;
    const redacted = redactObject(errorMsg);
    expect(redacted).not.toContain("supersecret");
    expect(redacted).toContain("***");
  });
});
