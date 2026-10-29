import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getDefaultConfig, loadConfig } from "@eigengrid/config";

function createProject(): string {
  const root = mkdtempSync(join(tmpdir(), "eigengrid-config-"));
  mkdirSync(join(root, ".eigengrid"), { recursive: true });
  return root;
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("config loading", () => {
  it("builds built-in defaults from the project cwd", () => {
    const cwd = createProject();
    const envSnapshot = {
      EIGENGRID_PYTHON: process.env.EIGENGRID_PYTHON,
    };

    process.env.EIGENGRID_PYTHON = "env-python";

    try {
      const config = getDefaultConfig(cwd);

      expect(config.databasePath).toBe(join(cwd, ".eigengrid", "eigengrid.sqlite"));
      expect(config.jobsDir).toBe(join(cwd, ".eigengrid", "jobs"));
      expect(config.logsDir).toBe(join(cwd, ".eigengrid", "logs"));
      expect(config.outputsDir).toBe(join(cwd, ".eigengrid", "outputs"));
      expect(config.sessionsDir).toBe(join(cwd, ".eigengrid", "sessions"));
      expect(config.pythonCommand).toBe("python");
    } finally {
      restoreEnv(envSnapshot);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("loads file values from .eigengrid/eigengrid.yaml", async () => {
    const cwd = createProject();
    writeFileSync(
      join(cwd, ".eigengrid", "eigengrid.yaml"),
      ["python: /opt/pyenv/shims/python", "database: custom.sqlite"].join("\n") + "\n",
    );

    try {
      const config = await loadConfig(cwd);

      expect(config.pythonCommand).toBe("/opt/pyenv/shims/python");
      expect(config.databasePath).toBe(join(cwd, ".eigengrid", "custom.sqlite"));
      expect(config.jobsDir).toBe(join(cwd, ".eigengrid", "jobs"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("applies environment overrides over file values", async () => {
    const cwd = createProject();
    const overrideDbPath = join(cwd, ".eigengrid", "override.sqlite");
    const envSnapshot = {
      EIGENGRID_DATABASE_PATH: process.env.EIGENGRID_DATABASE_PATH,
      EIGENGRID_PYTHON: process.env.EIGENGRID_PYTHON,
    };

    writeFileSync(
      join(cwd, ".eigengrid", "eigengrid.yaml"),
      ["python: /opt/pyenv/shims/python", "database: custom.sqlite"].join("\n") + "\n",
    );

    process.env.EIGENGRID_PYTHON = "env-python";
    process.env.EIGENGRID_DATABASE_PATH = overrideDbPath;

    try {
      const config = await loadConfig(cwd);

      expect(config.pythonCommand).toBe("env-python");
      expect(config.databasePath).toBe(overrideDbPath);
    } finally {
      restoreEnv(envSnapshot);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("supports EIGENGRID_DB_PATH with precedence over aliases", async () => {
    const cwd = createProject();
    const dbPath = join(cwd, ".eigengrid", "db-path.sqlite");
    const dbPathAlias = join(cwd, ".eigengrid", "db-path-alias.sqlite");
    const dbAlias = join(cwd, ".eigengrid", "db-alias.sqlite");

    const envSnapshot = {
      EIGENGRID_DB_PATH: process.env.EIGENGRID_DB_PATH,
      EIGENGRID_DATABASE_PATH: process.env.EIGENGRID_DATABASE_PATH,
      EIGENGRID_DATABASE: process.env.EIGENGRID_DATABASE,
      EIGENGRID_PYTHON: process.env.EIGENGRID_PYTHON,
    };

    writeFileSync(
      join(cwd, ".eigengrid", "eigengrid.yaml"),
      ["python: /opt/pyenv/shims/python", "database: custom.sqlite"].join("\n") + "\n",
    );

    process.env.EIGENGRID_DB_PATH = dbPath;
    process.env.EIGENGRID_DATABASE_PATH = dbPathAlias;
    process.env.EIGENGRID_DATABASE = dbAlias;
    process.env.EIGENGRID_PYTHON = "env-python";

    try {
      const config = await loadConfig(cwd);

      expect(config.pythonCommand).toBe("env-python");
      expect(config.databasePath).toBe(dbPath);
    } finally {
      restoreEnv(envSnapshot);
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
