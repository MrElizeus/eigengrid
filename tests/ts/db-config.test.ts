import { describe, expect, it } from "bun:test";
import { resolveDbConfig, redactDatabaseUrl } from "@eigengrid/db";
import type { Config } from "@eigengrid/core";

describe("db provider config", () => {
  it("requires explicit PostgreSQL in production and rejects misspelled profiles", () => {
    const config: Config = {
      databasePath: "/tmp/test.sqlite",
      jobsDir: "/tmp/jobs",
      logsDir: "/tmp/logs",
      outputsDir: "/tmp/outputs",
      pythonCommand: "python",
      sessionsDir: "/tmp/sessions",
    };
    expect(() => resolveDbConfig(config, { EIGENGRID_DEPLOYMENT_PROFILE: "production" })).toThrow(
      /Production requires/,
    );
    expect(() =>
      resolveDbConfig(
        { ...config, dbProvider: "sqlite" },
        { EIGENGRID_DEPLOYMENT_PROFILE: "production" },
      ),
    ).toThrow(/Production requires/);
    expect(() => resolveDbConfig(config, { EIGENGRID_DEPLOYMENT_PROFILE: "prodution" })).toThrow(
      /Unknown/,
    );
    expect(
      resolveDbConfig(
        { ...config, dbProvider: "postgres", databaseUrl: "postgresql://test@localhost/eigengrid" },
        { EIGENGRID_DEPLOYMENT_PROFILE: "production" },
      ).production,
    ).toBe(true);
  });
  it("defaults to sqlite when no provider set", () => {
    const config: Config = {
      databasePath: "/tmp/test.sqlite",
      dbProvider: "sqlite",
      jobsDir: "/tmp/jobs",
      logsDir: "/tmp/logs",
      outputsDir: "/tmp/outputs",
      pythonCommand: "python",
      sessionsDir: "/tmp/sessions",
    };
    const result = resolveDbConfig(config);
    expect(result.provider).toBe("sqlite");
    expect(result.databasePath).toBe("/tmp/test.sqlite");
  });

  it("resolves sqlite provider explicitly", () => {
    const config: Config = {
      databasePath: "/tmp/test.sqlite",
      dbProvider: "sqlite",
      jobsDir: "/tmp/jobs",
      logsDir: "/tmp/logs",
      outputsDir: "/tmp/outputs",
      pythonCommand: "python",
      sessionsDir: "/tmp/sessions",
    };
    const result = resolveDbConfig(config);
    expect(result.provider).toBe("sqlite");
    expect(result.databaseUrl).toBeUndefined();
  });

  it("resolves postgres provider with databaseUrl", () => {
    const config: Config = {
      databasePath: "/tmp/test.sqlite",
      dbProvider: "postgres",
      databaseUrl: "postgres://user:pass@localhost:5432/eigengrid",
      jobsDir: "/tmp/jobs",
      logsDir: "/tmp/logs",
      outputsDir: "/tmp/outputs",
      pythonCommand: "python",
      sessionsDir: "/tmp/sessions",
    };
    const result = resolveDbConfig(config);
    expect(result.provider).toBe("postgres");
    expect(result.databaseUrl).toBe("postgres://user:pass@localhost:5432/eigengrid");
  });

  it("throws actionable error when postgres selected but no DATABASE_URL", () => {
    const config: Config = {
      databasePath: "/tmp/test.sqlite",
      dbProvider: "postgres",
      jobsDir: "/tmp/jobs",
      logsDir: "/tmp/logs",
      outputsDir: "/tmp/outputs",
      pythonCommand: "python",
      sessionsDir: "/tmp/sessions",
    };
    expect(() => resolveDbConfig(config)).toThrow(/DATABASE_URL/);
  });
});

describe("DATABASE_URL redaction", () => {
  it("redacts password from postgres:// URL", () => {
    const url = "postgres://admin:supersecret@db.example.com:5432/eigengrid";
    const redacted = redactDatabaseUrl(url);
    expect(redacted).toContain("admin");
    expect(redacted).not.toContain("supersecret");
    expect(redacted).toContain("***");
  });

  it("redacts password from postgresql:// URL", () => {
    const url = "postgresql://user:my-secret-pw@localhost:5432/db";
    const redacted = redactDatabaseUrl(url);
    expect(redacted).not.toContain("my-secret-pw");
    expect(redacted).toContain("***");
  });

  it("handles URLs without credentials gracefully", () => {
    const url = "postgres://localhost:5432/eigengrid";
    const redacted = redactDatabaseUrl(url);
    expect(redacted).toBe(url); // unchanged
  });

  it("does not leak an at-sign-containing password", () => {
    const url = "postgres://user:SuperSecretP%40ss%21@db.example.com:5432/eigengrid";
    const redacted = redactDatabaseUrl(url);
    expect(redacted).toBe("postgres://user:***@db.example.com:5432/eigengrid");
    expect(redacted).not.toContain("SuperSecret");
    expect(redacted).not.toContain("P%40ss");
  });
});
