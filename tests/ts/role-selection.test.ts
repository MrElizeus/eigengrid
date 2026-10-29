import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { normalizeRole, assertRole, roleDefaults, readRoleFromConfig } from "@eigengrid/config";
import { loadConfig } from "@eigengrid/config";
import type { DatabaseLike } from "@eigengrid/db";
import { ensureHeadSshKey } from "../../apps/cli/src/services/ssh-key-service";

// These tests exercise filesystem-backed role/config initialization through
// the initializer's scoped dependency boundary.  No global module mock is
// installed, so they remain safe when the full suite runs in parallel.

// Helpers
// ────────────────────────────────────────────────────────────

function createMockDb(extra: Record<string, unknown> = {}) {
  return {
    init: mock(() => Promise.resolve()),
    createJob: mock(() => Promise.resolve()),
    updateJobStatus: mock(() => Promise.resolve()),
    getJob: mock(() => Promise.resolve(null)),
    resolveJobId: mock(() => Promise.resolve("")),
    listJobs: mock(() => Promise.resolve([])),
    createJobAttempt: mock(() => Promise.resolve()),
    updateJobAttemptStatus: mock(() => Promise.resolve()),
    listJobAttempts: mock(() => Promise.resolve([])),
    createArtifact: mock(() => Promise.resolve()),
    listArtifacts: mock(() => Promise.resolve([])),
    getLogs: mock(() => Promise.resolve([])),
    insertEvent: mock(() => Promise.resolve()),
    appendEvent: mock(() => Promise.resolve()),
    getEvents: mock(() => Promise.resolve([])),
    listPermissions: mock(() => Promise.resolve([])),
    createPermission: mock(() => Promise.resolve()),
    removePermission: mock(() => Promise.resolve()),
    createNode: mock(() => Promise.resolve()),
    getNode: mock(() => Promise.resolve(null)),
    listNodes: mock(() => Promise.resolve([])),
    removeNode: mock(() => Promise.resolve()),
    resolveNodeId: mock(() => Promise.resolve("")),
    getNodeByName: mock(() => Promise.resolve(null)),
    ...extra,
  };
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

/**
 * Create a temp project directory with a `.eigengrid` subdirectory.
 */
function createProject(): string {
  const root = mkdtempSync(join(tmpdir(), "eigengrid-p5-"));
  mkdirSync(join(root, ".eigengrid"), { recursive: true });
  return root;
}

// ────────────────────────────────────────────────────────────
// 1. Config role tests
// ────────────────────────────────────────────────────────────

describe("config role utilities", () => {
  describe("normalizeRole", () => {
    test("handles standalone correctly", () => {
      expect(normalizeRole("standalone")).toBe("standalone");
    });

    test("handles head correctly", () => {
      expect(normalizeRole("head")).toBe("head");
    });

    test("handles worker correctly", () => {
      expect(normalizeRole("worker")).toBe("worker");
    });

    test("is case-insensitive", () => {
      expect(normalizeRole("STANDALONE")).toBe("standalone");
      expect(normalizeRole("Head")).toBe("head");
      expect(normalizeRole("WORKER")).toBe("worker");
    });

    test("trims whitespace", () => {
      expect(normalizeRole("  standalone  ")).toBe("standalone");
    });

    test("throws TypeError for invalid values", () => {
      expect(() => normalizeRole("master")).toThrow(TypeError);
      expect(() => normalizeRole("slave")).toThrow(TypeError);
      expect(() => normalizeRole("")).toThrow(TypeError);
    });

    test("throws TypeError for non-string values", () => {
      expect(() => normalizeRole(undefined)).toThrow(TypeError);
      expect(() => normalizeRole(null as any)).toThrow(TypeError);
      expect(() => normalizeRole(123 as any)).toThrow(TypeError);
    });
  });

  describe("assertRole", () => {
    test("passes for valid roles", () => {
      expect(() => assertRole("standalone")).not.toThrow();
      expect(() => assertRole("head")).not.toThrow();
      expect(() => assertRole("worker")).not.toThrow();
    });

    test("throws for invalid roles", () => {
      expect(() => assertRole("invalid")).toThrow(TypeError);
      expect(() => assertRole("")).toThrow(TypeError);
    });
  });

  describe("roleDefaults", () => {
    test("standalone returns empty config", () => {
      const defaults = roleDefaults("standalone");
      expect(defaults).toEqual({});
    });

    test("head includes sshKeyPath default", () => {
      const defaults = roleDefaults("head", "/tmp/test-cwd");
      expect(defaults.sshKeyPath).toBe(join("/tmp/test-cwd", ".ssh", "id_ed25519"));
    });

    test("worker includes remoteScratchDir default", () => {
      const defaults = roleDefaults("worker");
      expect(defaults.remoteScratchDir).toBe("/tmp/eigengrid");
    });
  });

  describe("loadConfig role parsing", () => {
    test("defaults role to standalone when no config exists", async () => {
      const cwd = createProject();
      const envSnapshot = { EIGENGRID_ROLE: process.env.EIGENGRID_ROLE };
      delete process.env.EIGENGRID_ROLE;
      try {
        const config = await loadConfig(cwd);
        expect(config.role).toBe("standalone");
      } finally {
        restoreEnv(envSnapshot);
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("parses role=head from YAML", async () => {
      const cwd = createProject();
      const envSnapshot = {
        EIGENGRID_ROLE: process.env.EIGENGRID_ROLE,
      };
      delete process.env.EIGENGRID_ROLE;

      try {
        writeFileSync(
          join(cwd, ".eigengrid", "eigengrid.yaml"),
          "role: head\nnodeName: fixture-cluster\n",
        );
        const config = await loadConfig(cwd);
        expect(config.role).toBe("head");
      } finally {
        restoreEnv(envSnapshot);
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("parses role=worker with remoteScratchDir", async () => {
      const cwd = createProject();
      const envSnapshot = {
        EIGENGRID_ROLE: process.env.EIGENGRID_ROLE,
      };
      delete process.env.EIGENGRID_ROLE;

      try {
        writeFileSync(
          join(cwd, ".eigengrid", "eigengrid.yaml"),
          [
            "role: worker",
            "nodeName: worker-01",
            "remoteScratchDir: /scratch/eigengrid",
            "headHost: head.example.com",
            "headUser: admin",
          ].join("\n") + "\n",
        );
        const config = await loadConfig(cwd);
        expect(config.role).toBe("worker");
        expect(config.remoteScratchDir).toBe("/scratch/eigengrid");
        expect(config.headHost).toBe("head.example.com");
        expect(config.headUser).toBe("admin");
      } finally {
        restoreEnv(envSnapshot);
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("EIGENGRID_ROLE env var overrides file role", async () => {
      const cwd = createProject();
      const envSnapshot = {
        EIGENGRID_ROLE: process.env.EIGENGRID_ROLE,
      };

      try {
        writeFileSync(join(cwd, ".eigengrid", "eigengrid.yaml"), "role: standalone\n");
        process.env.EIGENGRID_ROLE = "head";
        const config = await loadConfig(cwd);
        expect(config.role).toBe("head");
      } finally {
        restoreEnv(envSnapshot);
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("invalid role value throws error via loadConfig", async () => {
      const cwd = createProject();
      try {
        writeFileSync(join(cwd, ".eigengrid", "eigengrid.yaml"), "role: invalid_role\n");
        await expect(loadConfig(cwd)).rejects.toThrow(TypeError);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  describe("readRoleFromConfig", () => {
    test("returns null when no config file exists", () => {
      const cwd = createProject();
      try {
        // No config file written
        const role = readRoleFromConfig(cwd);
        expect(role).toBeNull();
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("returns role from config file", () => {
      const cwd = createProject();
      try {
        writeFileSync(join(cwd, ".eigengrid", "eigengrid.yaml"), "role: head\n");
        const role = readRoleFromConfig(cwd);
        expect(role).toBe("head");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});

// ────────────────────────────────────────────────────────────
// 2. Init service tests
// ────────────────────────────────────────────────────────────

describe("init service", () => {
  const originalCwd = process.cwd();
  let projects: string[] = [];

  beforeEach(() => {
    // Each test creates its own project dir — we track them for cleanup
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const p of projects) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        // Already cleaned up
      }
    }
    projects = [];
  });

  function freshProject(): string {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-init-"));
    mkdirSync(join(root, ".eigengrid"), { recursive: true });
    projects.push(root);
    return root;
  }

  // Since init-project uses actual FS + SQLite, inject an isolated DB
  // implementation instead of globally mocking the package module.
  let dbMock: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    dbMock = createMockDb();
  });

  // Dynamic import keeps the service module consistent with production.
  async function getInitService() {
    return await import("../../apps/cli/src/services/init-service");
  }

  async function initWithMock(
    input: Parameters<
      (typeof import("../../apps/cli/src/services/init-service"))["initProject"]
    >[0],
  ) {
    const { initProject } = await getInitService();
    return initProject(input, { createDatabase: () => dbMock });
  }

  test("initProject standalone creates config with role: standalone", async () => {
    const cwd = freshProject();
    process.chdir(cwd);

    const result = await initWithMock({ role: "standalone", nodeName: "test-node" });

    expect(result.initialized).toBe(true);
    expect(existsSync(join(cwd, ".eigengrid", "eigengrid.yaml"))).toBe(true);

    const configContent = readFileSync(join(cwd, ".eigengrid", "eigengrid.yaml"), "utf8");
    expect(configContent).toContain("role: standalone");
    expect(configContent).toContain("nodeName: test-node");

    // Should have created directories
    expect(existsSync(join(cwd, ".eigengrid", "jobs"))).toBe(true);
    expect(existsSync(join(cwd, ".eigengrid", "logs"))).toBe(true);
    expect(existsSync(join(cwd, ".eigengrid", "outputs"))).toBe(true);
    expect(existsSync(join(cwd, ".eigengrid", "sessions"))).toBe(true);

    // Should have created a local node via upsertNodeByName
    expect(dbMock.createNode).toHaveBeenCalled();
    expect(dbMock.getNodeByName).toHaveBeenCalled();
  });

  test("initProject head creates config with role: head", async () => {
    const cwd = freshProject();
    process.chdir(cwd);

    const result = await initWithMock({
      role: "head",
      nodeName: "fixture-cluster",
    });

    expect(result.initialized).toBe(true);
    const configContent = readFileSync(join(cwd, ".eigengrid", "eigengrid.yaml"), "utf8");
    expect(configContent).toContain("role: head");
    expect(configContent).toContain("nodeName: fixture-cluster");

    // Head mode should include generateSshKey
    expect(configContent).toContain("generateSshKey: true");
  });

  test("initProject worker creates config with role: worker", async () => {
    const cwd = freshProject();
    process.chdir(cwd);

    const result = await initWithMock({
      role: "worker",
      nodeName: "worker-01",
      headHost: "manager.example.com",
      headUser: "admin",
    });

    expect(result.initialized).toBe(true);
    const configContent = readFileSync(join(cwd, ".eigengrid", "eigengrid.yaml"), "utf8");
    expect(configContent).toContain("role: worker");
    expect(configContent).toContain("headHost: manager.example.com");
    expect(configContent).toContain("headUser: admin");
  });

  test("initProject creates directories", async () => {
    const cwd = freshProject();
    process.chdir(cwd);

    await initWithMock({ role: "standalone" });

    expect(existsSync(join(cwd, ".eigengrid", "jobs"))).toBe(true);
    expect(existsSync(join(cwd, ".eigengrid", "logs"))).toBe(true);
    expect(existsSync(join(cwd, ".eigengrid", "outputs"))).toBe(true);
    expect(existsSync(join(cwd, ".eigengrid", "sessions"))).toBe(true);
  });

  test("initProject initializes SQLite", async () => {
    const cwd = freshProject();
    process.chdir(cwd);

    const result = await initWithMock({ role: "standalone" });

    expect(result.initialized).toBe(true);
    expect(dbMock.init).toHaveBeenCalled();
  });

  test("initProject creates local node for standalone", async () => {
    const cwd = freshProject();
    process.chdir(cwd);

    const result = await initWithMock({ role: "standalone", nodeName: "my-node" });

    expect(result.initialized).toBe(true);
    expect(dbMock.createNode).toHaveBeenCalled();
  });

  test("initProject idempotent on same role", async () => {
    const cwd = freshProject();
    process.chdir(cwd);

    await initWithMock({ role: "standalone", nodeName: "node-1" });

    // Second init with same role should succeed without error
    const result2 = await initWithMock({ role: "standalone", nodeName: "node-1" });
    expect(result2.initialized).toBe(true);
    expect(result2.warnings).toEqual([]);
  });

  test("initProject refuses different role without --update", async () => {
    const cwd = freshProject();
    process.chdir(cwd);

    await initWithMock({ role: "standalone", nodeName: "node-1" });

    // Second init with different role should throw
    await expect(initWithMock({ role: "head", nodeName: "node-2" })).rejects.toThrow(/--update/);
  });

  test("initProject --update allows role change", async () => {
    const cwd = freshProject();
    process.chdir(cwd);

    await initWithMock({ role: "standalone", nodeName: "node-1" });

    const result = await initWithMock({
      role: "head",
      nodeName: "node-2",
      update: true,
    });

    expect(result.initialized).toBe(true);
    const configContent = readFileSync(join(cwd, ".eigengrid", "eigengrid.yaml"), "utf8");
    expect(configContent).toContain("role: head");
  });
});

// ────────────────────────────────────────────────────────────
// 3. Doctor tests
// ────────────────────────────────────────────────────────────

describe("doctor registry", () => {
  // These are lightweight tests — no need to mock fs or exec.
  // We import from the CLI doctor module directly using relative paths.

  test("registry registers and runs checks by role", async () => {
    const { createDoctorRegistry } = await import("../../apps/cli/src/doctor/checks");
    const registry = createDoctorRegistry();

    const standaloneCheck = mock(() => ({
      name: "standalone-check",
      status: "ok" as const,
    }));
    const headCheck = mock(() => ({
      name: "head-check",
      status: "ok" as const,
    }));

    registry.register("standalone-check", standaloneCheck, "standalone");
    registry.register("head-check", headCheck, "head");

    const results = await registry.runForRole("standalone");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("standalone-check");
    expect(headCheck).not.toHaveBeenCalled();
  });

  test("--role standalone runs only standalone checks", async () => {
    const { createDoctorRegistry } = await import("../../apps/cli/src/doctor/checks");
    const registry = createDoctorRegistry();

    const commonCheck = mock(() => ({
      name: "common",
      status: "ok" as const,
    }));
    const standaloneCheck = mock(() => ({
      name: "standalone-only",
      status: "ok" as const,
    }));
    const headCheck = mock(() => ({
      name: "head-only",
      status: "ok" as const,
    }));

    registry.register("common", commonCheck, "all");
    registry.register("standalone-only", standaloneCheck, "standalone");
    registry.register("head-only", headCheck, "head");

    const results = await registry.runForRole("standalone");
    const names = results.map((r) => r.name);
    expect(names).toContain("common");
    expect(names).toContain("standalone-only");
    expect(names).not.toContain("head-only");
  });

  test("--role head runs common + head checks", async () => {
    const { createDoctorRegistry } = await import("../../apps/cli/src/doctor/checks");
    const registry = createDoctorRegistry();

    registry.register("common", () => ({ name: "common", status: "ok" as const }), "all");
    registry.register("head-only", () => ({ name: "head-only", status: "ok" as const }), "head");
    registry.register(
      "worker-only",
      () => ({ name: "worker-only", status: "ok" as const }),
      "worker",
    );

    const results = await registry.runForRole("head");
    const names = results.map((r) => r.name);
    expect(names).toContain("common");
    expect(names).toContain("head-only");
    expect(names).not.toContain("worker-only");
  });

  test("--role worker runs common + worker checks", async () => {
    const { createDoctorRegistry } = await import("../../apps/cli/src/doctor/checks");
    const registry = createDoctorRegistry();

    registry.register("common", () => ({ name: "common", status: "ok" as const }), "all");
    registry.register(
      "worker-only",
      () => ({ name: "worker-only", status: "ok" as const }),
      "worker",
    );
    registry.register("head-only", () => ({ name: "head-only", status: "ok" as const }), "head");

    const results = await registry.runForRole("worker");
    const names = results.map((r) => r.name);
    expect(names).toContain("common");
    expect(names).toContain("worker-only");
    expect(names).not.toContain("head-only");
  });

  test("runAll with no role runs all checks", async () => {
    const { createDoctorRegistry } = await import("../../apps/cli/src/doctor/checks");
    const registry = createDoctorRegistry();

    registry.register("a", () => ({ name: "a", status: "ok" as const }), "all");
    registry.register("b", () => ({ name: "b", status: "ok" as const }), "head");
    registry.register("c", () => ({ name: "c", status: "ok" as const }), "worker");

    const results = await registry.runAll();
    expect(results).toHaveLength(3);
  });

  test("runAll with role filters to that role", async () => {
    const { createDoctorRegistry } = await import("../../apps/cli/src/doctor/checks");
    const registry = createDoctorRegistry();

    registry.register("common", () => ({ name: "common", status: "ok" as const }), "all");
    registry.register("head-only", () => ({ name: "head-only", status: "ok" as const }), "head");

    const results = await registry.runAll("head");
    expect(results).toHaveLength(2);
  });
});

// ────────────────────────────────────────────────────────────
// 4. Node service tests
// ────────────────────────────────────────────────────────────

describe("node service", () => {
  test("upsertNodeByName creates new node", async () => {
    const db = createMockDb();
    const { upsertNodeByName } = await import("../../apps/cli/src/services/node-service");

    const result = await upsertNodeByName(db as unknown as DatabaseLike, {
      name: "worker-01",
      host: "10.0.0.1",
      user: "eigengrid",
      runner: "ssh",
    });

    expect(result.created).toBe(true);
    expect(result.updated).toBe(false);
    expect(db.createNode).toHaveBeenCalled();
    expect(db.getNodeByName).toHaveBeenCalledWith("worker-01");
  });

  test("upsertNodeByName does not duplicate existing node", async () => {
    const db = createMockDb({
      getNodeByName: mock(() =>
        Promise.resolve({
          id: "node-1",
          name: "worker-01",
          host: "10.0.0.1",
        }),
      ),
    });
    const { upsertNodeByName } = await import("../../apps/cli/src/services/node-service");

    const result = await upsertNodeByName(db as unknown as DatabaseLike, {
      name: "worker-01",
      host: "10.0.0.1",
      user: "eigengrid",
    });

    expect(result.created).toBe(false);
    expect(result.updated).toBe(false);
    expect(db.createNode).not.toHaveBeenCalled();
  });

  test("upsertNodeByName returns created/updated flags", async () => {
    const db = createMockDb();
    const { upsertNodeByName } = await import("../../apps/cli/src/services/node-service");

    // First call creates
    const createResult = await upsertNodeByName(db as unknown as DatabaseLike, {
      name: "node-1",
      host: "localhost",
      user: "test",
      runner: "local",
    });
    expect(createResult).toEqual({ created: true, updated: false });

    // Second call with existing node
    const dbWithNode = createMockDb({
      getNodeByName: mock(() => Promise.resolve({ id: "node-1", name: "node-1" })),
    });
    const skipResult = await upsertNodeByName(dbWithNode as unknown as DatabaseLike, {
      name: "node-1",
      host: "localhost",
      user: "test",
    });
    expect(skipResult).toEqual({ created: false, updated: false });
  });
});

// ────────────────────────────────────────────────────────────
// 5. Config writer tests
// ────────────────────────────────────────────────────────────

describe("config writer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "eigengrid-cw-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("writeRoleConfig creates new config file", async () => {
    const { writeRoleConfig } = await import("../../apps/cli/src/services/config-writer");
    const configPath = join(tmpDir, "eigengrid.yaml");

    await writeRoleConfig({
      path: configPath,
      role: "standalone",
      config: { nodeName: "test-node", database: "eigengrid.sqlite" },
    });

    expect(existsSync(configPath)).toBe(true);
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("role: standalone");
    expect(content).toContain("nodeName: test-node");
  });

  test("writeRoleConfig preserves existing config on same role", async () => {
    const { writeRoleConfig } = await import("../../apps/cli/src/services/config-writer");
    const configPath = join(tmpDir, "eigengrid.yaml");

    // First write
    await writeRoleConfig({
      path: configPath,
      role: "head",
      config: {
        nodeName: "fixture-cluster",
        database: "eigengrid.sqlite",
        sshKeyPath: ".ssh/id_ed25519",
      },
    });

    // Second write with same role and new key
    await writeRoleConfig({
      path: configPath,
      role: "head",
      config: {
        nodeName: "fixture-cluster",
        database: "eigengrid.sqlite",
        sshKeyPath: ".ssh/id_ed25519",
        headHost: "new-host",
      },
    });

    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("role: head");
    // Existing keys should be preserved
    expect(content).toContain("sshKeyPath: .ssh/id_ed25519");
    // New key should be appended
    expect(content).toContain("headHost: new-host");
  });

  test("writeRoleConfig errors on different role without --update", async () => {
    const { writeRoleConfig } = await import("../../apps/cli/src/services/config-writer");
    const configPath = join(tmpDir, "eigengrid.yaml");

    await writeRoleConfig({
      path: configPath,
      role: "standalone",
      config: { nodeName: "test" },
    });

    await expect(
      writeRoleConfig({
        path: configPath,
        role: "head",
        config: { nodeName: "test" },
      }),
    ).rejects.toThrow(/--update/);
  });

  test("writeRoleConfig --update allows role change", async () => {
    const { writeRoleConfig } = await import("../../apps/cli/src/services/config-writer");
    const configPath = join(tmpDir, "eigengrid.yaml");

    await writeRoleConfig({
      path: configPath,
      role: "standalone",
      config: { nodeName: "old-node" },
    });

    await writeRoleConfig({
      path: configPath,
      role: "head",
      config: { nodeName: "new-node", generateSshKey: true },
      update: true,
    });

    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("role: head");
    expect(content).toContain("nodeName: new-node");
  });
});

// ────────────────────────────────────────────────────────────
// 6. SSH key service tests
// ────────────────────────────────────────────────────────────

describe("SSH key service", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "eigengrid-ssh-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("ensureHeadSshKey without generate does nothing", async () => {
    const keyPath = join(tmpDir, "keys", "id_ed25519");

    const result = await ensureHeadSshKey({
      generate: false,
      sshKeyPath: keyPath,
    });

    expect(result.created).toBe(false);
    // Should warn that key doesn't exist
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("not found");
  });

  test("ensureHeadSshKey passes paths and comments as argv data", async () => {
    const execMock = mock(() => Buffer.from(""));
    const keyPath = join(tmpDir, "keys", "id_$(touch should-not-run)");
    const nodeName = 'node"; touch should-not-run; #';

    const result = await ensureHeadSshKey(
      {
        generate: true,
        sshKeyPath: keyPath,
        nodeName,
      },
      { execFileSync: execMock },
    );

    // Our injected runner will succeed, but chmodSync on the pub key will fail
    // because the file doesn't actually exist. The function catches that error
    // gracefully and returns created:false with a warning.
    // The important thing is that untrusted values remain separate arguments.
    expect(execMock).toHaveBeenCalled();
    expect(execMock.mock.calls[0]?.[0]).toBe("ssh-keygen");
    expect(execMock.mock.calls[0]?.[1]).toEqual([
      "-t",
      "ed25519",
      "-f",
      keyPath,
      "-N",
      "",
      "-C",
      `eigengrid-head@${nodeName}`,
    ]);
    expect(result.created).toBe(false);
  });

  test("ensureHeadSshKey does not overwrite existing key", async () => {
    // Create the key file in advance
    const keyPath = join(tmpDir, "keys", "id_ed25519");
    mkdirSync(join(tmpDir, "keys"), { recursive: true });
    writeFileSync(keyPath, "fake-private-key");

    const execMock = mock(() => Buffer.from(""));

    const result = await ensureHeadSshKey(
      {
        generate: true,
        sshKeyPath: keyPath,
      },
      { execFileSync: execMock },
    );

    // Should not have called execFileSync because key already exists
    expect(execMock).not.toHaveBeenCalled();
    expect(result.created).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("already exists");
  });
});
