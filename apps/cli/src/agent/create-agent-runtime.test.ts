import { describe, it, expect, mock } from "bun:test";
// Capture the real module surface so the mock below only overrides
// createDatabase. bun's mock.module applies to the whole worker
// process, and a partial factory would break the named-export link
// of any other test file that imports @eigengrid/db in the same
// worker (e.g. the dashboard tests).
import * as RealDbModule from "@eigengrid/db";

// ── Mocks for modules with I/O or config dependencies ────────

const mockDb = {
  init: mock(() => Promise.resolve()),
  close: mock(() => Promise.resolve()),
  listJobs: mock(() => Promise.resolve([])),
  listNodes: mock(() => Promise.resolve([])),
  getJob: mock(() => Promise.resolve(null)),
  updateJobStatus: mock(() => Promise.resolve()),
  insertEvent: mock(() => Promise.resolve()),
  appendEvent: mock(() => Promise.resolve()),
};

const mockConfig = {
  databasePath: ":memory:",
  jobsDir: "/tmp/jobs",
  logsDir: "/tmp/logs",
  outputsDir: "/tmp/outputs",
  pythonCommand: "python3",
  sessionsDir: "/tmp/sessions",
};

// Mock only modules that do I/O or config loading
mock.module("@eigengrid/config", () => ({
  loadConfig: mock(() => Promise.resolve(mockConfig)),
}));

mock.module("@eigengrid/db", () => ({
  ...RealDbModule,
  createDatabaseFromConfig: mock(async () => {
    await mockDb.init();
    return mockDb;
  }),
}));

describe("createAgentRuntime", () => {
  async function getFactory() {
    return await import("./create-agent-runtime");
  }

  describe("basic creation", () => {
    it("returns an AgentRuntime object with expected properties", async () => {
      const { createAgentRuntime } = await getFactory();
      const runtime = await createAgentRuntime();
      expect(runtime).toBeDefined();
      expect(typeof runtime.close).toBe("function");
      expect(runtime.config).toBeDefined();
      expect(runtime.db).toBeDefined();
      expect(runtime.registry).toBeDefined();
      expect(runtime.ctx).toBeDefined();
    });

    it("initializes the database", async () => {
      const { createAgentRuntime } = await getFactory();
      await createAgentRuntime();
      expect(mockDb.init).toHaveBeenCalled();
    });
  });

  describe("tool registry", () => {
    it("exposes the default read-only operational and scientific tools", async () => {
      const { createAgentRuntime } = await getFactory();
      const runtime = await createAgentRuntime();
      expect(
        runtime.registry
          .list()
          .map((tool: any) => tool.name)
          .sort(),
      ).toEqual([
        "doctor",
        "get-job-status",
        "inspect-node",
        "inspect-protocol",
        "list-artifacts",
        "list-events",
        "list-jobs",
        "list-nodes",
        "list-protocols",
        "list-recipes",
        "list-results",
        "operator-info",
        "read-file",
        "read-log",
        "validate-md-protocol",
      ]);
    });

    it("does NOT register submit-gaussian tool", async () => {
      const { createAgentRuntime } = await getFactory();
      const runtime = await createAgentRuntime();
      const toolNames = runtime.registry.list().map((t: any) => t.name);
      expect(toolNames).not.toContain("submit-gaussian");
    });

    it("materializes scientific actions, file edits and commands as gated metadata", async () => {
      const { createAgentRuntime } = await getFactory();
      const runtime = await createAgentRuntime();
      expect(
        runtime.registry
          .materialize()
          .approvalRequiredDefinitions.map((tool) => tool.name)
          .sort(),
      ).toEqual(["cancel-job", "parse-job-output", "run-command", "submit-job", "write-file"]);
    });

    it("reports the native operator architecture through operator-info", async () => {
      const { createAgentRuntime } = await getFactory();
      const runtime = await createAgentRuntime();
      const result = await runtime.registry.execute("operator-info", runtime.ctx, {});
      expect(result).toMatchObject({
        ok: true,
        data: {
          agent: {
            engine: "eigengrid-native",
            loop: "bounded-tool-loop",
            codexCoupled: false,
          },
        },
      });
    });
  });

  describe("context", () => {
    it("creates ToolContext with db, runners, bus, config, python", async () => {
      const { createAgentRuntime } = await getFactory();
      const runtime = await createAgentRuntime();
      expect(runtime.ctx.db).toBeDefined();
      expect(runtime.ctx.runners).toEqual({});
      expect(runtime.ctx.bus).toBeDefined();
      expect(runtime.ctx.config).toBeDefined();
      expect(runtime.ctx.python).toBeDefined();
    });
  });

  describe("permission rules", () => {
    it("applies default permission rules when allowActions is false", async () => {
      const { createAgentRuntime } = await getFactory();
      const runtime = await createAgentRuntime({ allowActions: false });
      expect(runtime.permissionRules).toBeDefined();
      expect(runtime.permissionRules!.length).toBeGreaterThan(0);
    });

    it("fails closed when allowActions is true because durable approval is unsupported", async () => {
      const { createAgentRuntime } = await getFactory();
      await expect(createAgentRuntime({ allowActions: true })).rejects.toThrow(
        "durable per-call approval",
      );
    });

    it("defaults to applying permission rules", async () => {
      const { createAgentRuntime } = await getFactory();
      const runtime = await createAgentRuntime();
      expect(runtime.permissionRules).toBeDefined();
    });
  });

  describe("memory", () => {
    it("creates an AgentMemory instance", async () => {
      const { createAgentRuntime } = await getFactory();
      const runtime = await createAgentRuntime();
      expect(runtime.memory).toBeDefined();
    });
  });

  describe("close", () => {
    it("close() does not throw", async () => {
      const { createAgentRuntime } = await getFactory();
      const runtime = await createAgentRuntime();
      expect(() => runtime.close()).not.toThrow();
    });
  });
});
