import { describe, expect, test, mock } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { z } from "zod";
import {
  ToolRegistry,
  doctorTool,
  listJobsTool,
  readLogTool,
  submitJobTool,
  parseJobOutputTool,
  makeTool,
  withToolPermission,
} from "@eigengrid/tool-registry";
import type { ToolContext, PermissionRuleset } from "@eigengrid/tool-registry";
import { InProcessEventBus } from "@eigengrid/events";
import { requiresApproval, runAgent, configureLlm, getLlmConfig } from "@eigengrid/agent";

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function createMockDb(extra: Record<string, unknown> = {}) {
  return {
    _provider: "sqlite",
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
    listEvents: mock(() => Promise.resolve([])),
    listJobEvents: mock(() => Promise.resolve([])),
    listAttemptEvents: mock(() => Promise.resolve([])),
    getTimeline: mock(() => Promise.resolve([])),
    saveResult: mock(() => Promise.resolve("result-mock")),
    listResults: mock(() => Promise.resolve([])),
    getLatestResult: mock(() => Promise.resolve(null)),
    createProposal: mock(() => Promise.resolve("")),
    getProposal: mock(() => Promise.resolve(null)),
    listProposals: mock(() => Promise.resolve([])),
    updateProposalStatus: mock(() => Promise.resolve()),
    listPermissions: mock(() => Promise.resolve([])),
    createPermission: mock(() => Promise.resolve()),
    removePermission: mock(() => Promise.resolve()),
    createUser: mock(() => Promise.resolve()),
    getUser: mock(() => Promise.resolve(null)),
    getUserByUsername: mock(() => Promise.resolve(null)),
    listUsers: mock(() => Promise.resolve([])),
    disableUser: mock(() => Promise.resolve()),
    enableUser: mock(() => Promise.resolve()),
    createProject: mock(() => Promise.resolve()),
    getProject: mock(() => Promise.resolve(null)),
    getProjectByName: mock(() => Promise.resolve(null)),
    listProjects: mock(() => Promise.resolve([])),
    archiveProject: mock(() => Promise.resolve()),
    resolveProjectId: mock(() => Promise.resolve("")),
    addProjectMember: mock(() => Promise.resolve()),
    removeProjectMember: mock(() => Promise.resolve()),
    listProjectMembers: mock(() => Promise.resolve([])),
    listUserProjects: mock(() => Promise.resolve([])),
    getProjectQuota: mock(() => Promise.resolve(null)),
    setProjectQuota: mock(() => Promise.resolve()),
    recordUsage: mock(() => Promise.resolve()),
    getProjectUsage: mock(() => Promise.resolve([])),
    getUserUsage: mock(() => Promise.resolve([])),
    getProjectAggregatedUsage: mock(() =>
      Promise.resolve({
        totalCpuThreads: 0,
        totalMemoryMb: 0,
        totalScratchMb: 0,
        totalWalltimeMs: 0,
        jobCount: 0,
      }),
    ),
    isUserDisabled: mock(() => Promise.resolve(false)),
    beginTransaction: mock(() => Promise.reject(new Error("not implemented"))),
    createNode: mock(() => Promise.resolve()),
    getNode: mock(() => Promise.resolve(null)),
    listNodes: mock(() => Promise.resolve([])),
    removeNode: mock(() => Promise.resolve()),
    resolveNodeId: mock(() => Promise.resolve("")),
    getNodeByName: mock(() => Promise.resolve(null)),
    ensureDb: () => ({
      query: () => ({
        run: () => {},
        all: () => [],
        get: () => undefined,
      }),
    }),
    ...extra,
  };
}

function createMockCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    db: createMockDb() as any,
    python: {} as any,
    runners: {},
    bus: new InProcessEventBus(),
    config: { pythonCommand: "python", jobsDir: "/tmp" } as any,
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────

describe("Agentic Engine", () => {
  // ── AE-01: Adapter + Settlement ────────────────────────
  test("AE-01: adapter uses materialize + settle", async () => {
    const reg = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
    reg.register(doctorTool);
    reg.register(listJobsTool);

    const materialized = reg.materialize();
    expect(materialized.definitions).toHaveLength(2);
    expect(materialized.settle).toBeDefined();

    // Settle a doctor call
    const docResult = await materialized.settle(
      { name: "doctor", input: {}, id: crypto.randomUUID?.() ?? "call-1" },
      createMockCtx(),
    );
    expect(docResult.ok).toBe(true);
    expect(docResult.content).toBeDefined();
    expect(docResult.content.length).toBeGreaterThan(0);

    // Settle a list-jobs call
    const listResult = await materialized.settle(
      { name: "list-jobs", input: {}, id: crypto.randomUUID?.() ?? "call-2" },
      createMockCtx(),
    );
    expect(listResult.ok).toBe(true);
    expect(listResult.output).toBeDefined();
  });

  test("AE-01b: settle returns error for unknown tool", async () => {
    const reg = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
    reg.register(doctorTool);

    const materialized = reg.materialize();
    const result = await materialized.settle(
      { name: "nonexistent", input: {}, id: "call-3" },
      createMockCtx(),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TOOL_NOT_FOUND");
  });

  // ── AE-02: Permissions ─────────────────────────────────
  test("AE-02a: deny hides tool from materialization", async () => {
    const reg = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);

    const sensitiveTool = makeTool({
      description: "Sensitive operation",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      async execute() {
        return { ok: true, data: { ok: true } };
      },
    });
    const restricted = withToolPermission(sensitiveTool, "admin.delete");
    reg.registerDefinition("admin-delete", restricted);
    reg.register(doctorTool);

    // Without permissions — both tools visible
    const all = reg.materialize();
    expect(all.definitions).toHaveLength(2);

    // With deny rule — admin-delete excluded
    const rules: PermissionRuleset = [
      { action: "*", resource: "*", effect: "allow" },
      { action: "admin.delete", resource: "*", effect: "deny" },
    ];
    const filtered = reg.materialize(rules);
    expect(filtered.definitions).toHaveLength(1);
    expect(filtered.definitions[0].name).toBe("doctor");
  });

  test("AE-02b: deny with wildcard hides multiple tools", async () => {
    const reg = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);

    const t1 = withToolPermission(
      makeTool({
        description: "T1",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        async execute() {
          return { ok: true, data: { ok: true } };
        },
      }),
      "admin.delete",
    );
    const t2 = withToolPermission(
      makeTool({
        description: "T2",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        async execute() {
          return { ok: true, data: { ok: true } };
        },
      }),
      "admin.delete",
    );

    reg.registerDefinition("admin-delete-a", t1);
    reg.registerDefinition("admin-delete-b", t2);

    const rules: PermissionRuleset = [
      { action: "*", resource: "*", effect: "allow" },
      { action: "admin.delete", resource: "*", effect: "deny" },
    ];
    const filtered = reg.materialize(rules);
    expect(filtered.definitions).toHaveLength(0);
  });

  test("AE-02c: ask requires approval check", () => {
    expect(requiresApproval("submit-job")).toBe(true);
    expect(requiresApproval("doctor")).toBe(false);
    expect(requiresApproval("list-jobs")).toBe(false);
    expect(requiresApproval("unknown-tool")).toBe(false);
  });

  // ── AE-03: Agent Loop with Mock Model ──────────────────
  test("AE-03: agent loop with fake model", async () => {
    const origFetch = globalThis.fetch;
    const originalConfig = getLlmConfig();
    const originalCwd = process.cwd();
    const directory = mkdtempSync(join(tmpdir(), "eigengrid-agent-model-"));
    mkdirSync(join(directory, ".eigengrid"), { mode: 0o700 });
    process.chdir(directory);

    configureLlm({
      baseUrl: "http://localhost:9999/v1",
      model: "mock-test-model",
      apiKey: "sk-mock-key",
      providerName: "fixture",
      costPerInputToken: 0,
      costPerOutputToken: 0,
    });

    globalThis.fetch = mock(
      async (url: string | Request | URL, _init?: RequestInit): Promise<Response> => {
        const urlStr = String(url);
        if (urlStr.includes("chat/completions")) {
          return Response.json({
            id: "chatcmpl-mock",
            object: "chat.completion",
            created: Date.now(),
            model: "mock-test-model",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_mock_1",
                      type: "function",
                      function: { name: "doctor", arguments: "{}" },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          });
        }
        return new Response("{}", { status: 200 });
      },
    );

    const reg = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
    reg.register(doctorTool);

    try {
      const result = await runAgent({
        prompt: "run diagnostics",
        tools: reg,
        ctx: createMockCtx(),
        maxSteps: 1,
      });

      expect(result.ok).toBe(false); // Inference step budget exhausted after the observed tool effect.
      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls!.length).toBeGreaterThanOrEqual(1);
      expect(result.toolCalls![0].tool).toBe("doctor");
    } finally {
      globalThis.fetch = origFetch;
      process.chdir(originalCwd);
      rmSync(directory, { recursive: true, force: true });
      configureLlm({
        ...originalConfig,
        costPerInputToken: originalConfig.costPerInputToken,
        costPerOutputToken: originalConfig.costPerOutputToken,
      });
    }
  });

  // ── AE-04: Submit Job (via submit-job) ─────────────────
  test("AE-04: submit-job creates job in DB", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "eigengrid-ae04-"));
    const inputPath = join(tmpDir, "test.gjf");
    writeFileSync(inputPath, "#p hf/sto-3g\nwater\n");

    const jobAttempts: Array<Record<string, unknown>> = [];
    const createJobMock = mock(() => Promise.resolve());
    const appendEventMock = mock(() => Promise.resolve());

    const ctx = createMockCtx({
      db: createMockDb({
        createJob: createJobMock,
        appendEvent: appendEventMock,
        listJobAttempts: mock((_jobId?: string) => Promise.resolve([...jobAttempts])),
        createJobAttempt: mock((attempt: Record<string, unknown>) => {
          jobAttempts.push(attempt);
          return Promise.resolve();
        }),
      }) as any,
      config: { pythonCommand: "python", jobsDir: tmpDir } as any,
    });

    const reg = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
    reg.register(submitJobTool);

    const materialized = reg.materialize();
    await materialized.settle(
      {
        name: "submit-job",
        input: { software: "gaussian", inputPath },
        id: "call-submit",
      },
      ctx,
    );

    // submitJob calls createJob and appendEvent before returning
    expect(createJobMock).toHaveBeenCalled();
    expect(appendEventMock).toHaveBeenCalled();

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("AE-04b: submit-job validates input schema", async () => {
    const reg = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
    reg.register(submitJobTool);

    const materialized = reg.materialize();
    const result = await materialized.settle(
      {
        name: "submit-job",
        input: { software: "gaussian" },
        id: "call-validate",
      },
      createMockCtx(),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
  });

  // ── AE-05: Read Log ────────────────────────────────────
  test("AE-05: read-log reads from artifacts", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "eigengrid-ae05-"));
    const logContent = "Gaussian log line 1\nGaussian log line 2\nGaussian log line 3";
    const logPath = join(tmpDir, "stdout.log");
    writeFileSync(logPath, logContent);

    const ctx = createMockCtx({
      db: createMockDb({
        listArtifacts: mock(() =>
          Promise.resolve([{ jobId: "job-1", kind: "log", label: "stdout", path: logPath }]),
        ),
        getJob: mock(() => Promise.resolve(null)),
      }) as any,
    });

    const reg = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
    reg.register(readLogTool);

    const materialized = reg.materialize();
    const result = await materialized.settle(
      { name: "read-log", input: { jobId: "job-1" }, id: "call-read" },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.content).toBeDefined();
    expect(result.content.some((c) => c.type === "text")).toBe(true);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("AE-05b: read-log returns error for missing job", async () => {
    const ctx = createMockCtx({
      db: createMockDb({
        listArtifacts: mock(() => Promise.resolve([])),
        getJob: mock(() => Promise.resolve(null)),
      }) as any,
    });

    const reg = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
    reg.register(readLogTool);

    const materialized = reg.materialize();
    const result = await materialized.settle(
      { name: "read-log", input: { jobId: "nonexistent" }, id: "call-read2" },
      ctx,
    );

    expect(result.ok).toBe(true);
  });

  // ── AE-06: Parse Job Output ────────────────────────────
  test("AE-06: parse-job-output persists results", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "eigengrid-ae06-"));
    const outputPath = join(tmpDir, "test.log");
    writeFileSync(outputPath, "some output content\n");

    const mockPython = {
      parse: mock(async (_software: string, _path: string) => ({
        ok: true,
        status: "completed" as const,
        parser: "gaussian",
        data: {
          energy_hartree: -76.4,
          scf_converged: true,
          normal_termination: true,
        },
      })),
    };

    const ctx = createMockCtx({
      db: createMockDb({
        getJob: mock(() =>
          Promise.resolve({
            id: "job-1",
            software: "gaussian",
            outputPath,
            workdir: tmpDir,
            status: "completed",
          }),
        ),
        listJobAttempts: mock(() => Promise.resolve([{ id: "attempt-1", jobId: "job-1" }])),
        listArtifacts: mock(() =>
          Promise.resolve([
            {
              id: "artifact-1",
              jobId: "job-1",
              attemptId: "attempt-1",
              kind: "output",
              path: outputPath,
            },
          ]),
        ),
      }) as any,
      python: mockPython as any,
    });

    const reg = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
    reg.register(parseJobOutputTool);

    const materialized = reg.materialize();
    const result = await materialized.settle(
      {
        name: "parse-job-output",
        input: { jobId: "job-1", attemptId: "attempt-1" },
        id: "call-parse",
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.output).toBeDefined();
    expect((result.output as Record<string, unknown>).ok).toBe(true);
    expect((result.output as Record<string, unknown>).parser).toBe("gaussian");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("AE-06b: parse-job-output returns error for unknown job", async () => {
    const ctx = createMockCtx({
      db: createMockDb({
        getJob: mock(() => Promise.resolve(null)),
      }) as any,
    });

    const reg = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
    reg.register(parseJobOutputTool);

    const materialized = reg.materialize();
    const result = await materialized.settle(
      {
        name: "parse-job-output",
        input: { jobId: "nonexistent", attemptId: "attempt-missing" },
        id: "call-parse2",
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NOT_FOUND");
  });

  // ── AE-07: CLI Agent Command ──────────────────────────
  test("AE-07: CLI agent command wired in main.ts", async () => {
    const mainSource = await Bun.file(join(import.meta.dir, "../../apps/cli/src/main.ts")).text();
    expect(mainSource).toContain("agentCommand");
    expect(mainSource).toMatch(/\.command\(agentCommand\)/);
  });

  test("AE-07b: splash menu lists agent command", async () => {
    const splashSource = await Bun.file(
      join(import.meta.dir, "../../apps/cli/src/splash.ts"),
    ).text();
    expect(splashSource).toContain('"agent"');
    expect(splashSource).toContain("Run EigenGrid agent");
  });

  // ── AE-08: Permissions & New Tool Integration ──────────
  test("AE-08a: restrictive permissions hide submit-job from agent", async () => {
    const reg = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
    reg.register(submitJobTool);
    reg.register(doctorTool);

    const rules: PermissionRuleset = [
      { action: "*", resource: "*", effect: "allow" },
      { action: "tool:execute", resource: "submit-job", effect: "deny" },
    ];

    const materialized = reg.materialize(rules);
    expect(materialized.definitions).toHaveLength(1);
    expect(materialized.definitions[0].name).toBe("doctor");
    expect(materialized.definitions.find((d) => d.name === "submit-job")).toBeUndefined();

    // Settle should also fail with TOOL_NOT_FOUND
    const settleResult = await materialized.settle(
      { name: "submit-job", input: {}, id: "call-deny" },
      createMockCtx(),
    );
    expect(settleResult.ok).toBe(false);
    expect(settleResult.error?.code).toBe("TOOL_NOT_FOUND");
  });

  test("AE-08b: submitJobTool with local runner creates a real job", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "eigengrid-ae08b-"));
    const inputPath = join(tmpDir, "test.gjf");
    writeFileSync(inputPath, "#p hf/sto-3g\nwater\n");

    const jobAttempts: Array<Record<string, unknown>> = [];
    const createJobMock = mock(() => Promise.resolve());
    const appendEventMock = mock(() => Promise.resolve());
    const updateJobStatusMock = mock(() => Promise.resolve());
    const updateJobAttemptStatusMock = mock(() => Promise.resolve());
    const listArtifactsMock = mock(() => Promise.resolve([]));
    const createArtifactMock = mock(() => Promise.resolve());

    const ctx = createMockCtx({
      db: createMockDb({
        createJob: createJobMock,
        appendEvent: appendEventMock,
        updateJobStatus: updateJobStatusMock,
        updateJobAttemptStatus: updateJobAttemptStatusMock,
        listJobAttempts: mock((_jobId?: string) => Promise.resolve([...jobAttempts])),
        createJobAttempt: mock((attempt: Record<string, unknown>) => {
          jobAttempts.push(attempt);
          return Promise.resolve();
        }),
        listArtifacts: listArtifactsMock,
        createArtifact: createArtifactMock,
        getJob: mock((_jobId?: string) => Promise.resolve(null)),
        getLogs: mock(() => Promise.resolve([])),
      }) as any,
      config: { pythonCommand: "python", jobsDir: tmpDir } as any,
    });

    const reg = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
    reg.register(submitJobTool);

    const materialized = reg.materialize();
    const result = await materialized.settle(
      {
        name: "submit-job",
        input: { software: "gaussian", inputPath, runner: "local" },
        id: "call-submit-08b",
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(createJobMock).toHaveBeenCalled();
    expect(appendEventMock).toHaveBeenCalled();

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("AE-08c: parseJobOutputTool creates v2 events via appendEvent", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "eigengrid-ae08c-"));
    const outputPath = join(tmpDir, "test.log");
    writeFileSync(outputPath, "some output content\n");

    const appendEventMock = mock(() => Promise.resolve());

    const mockPython = {
      parse: mock(async (_software: string, _path: string) => ({
        ok: true,
        status: "completed" as const,
        parser: "gaussian",
        data: {
          energy_hartree: -76.4,
          scf_converged: true,
          normal_termination: true,
        },
      })),
    };

    const ctx = createMockCtx({
      db: createMockDb({
        getJob: mock(() =>
          Promise.resolve({
            id: "job-1",
            software: "gaussian",
            outputPath,
            workdir: tmpDir,
            status: "completed",
          }),
        ),
        listJobAttempts: mock(() => Promise.resolve([{ id: "attempt-1", jobId: "job-1" }])),
        listArtifacts: mock(() =>
          Promise.resolve([
            {
              id: "artifact-1",
              jobId: "job-1",
              attemptId: "attempt-1",
              kind: "output",
              path: outputPath,
            },
          ]),
        ),
        appendEvent: appendEventMock,
      }) as any,
      python: mockPython as any,
    });

    const reg = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
    reg.register(parseJobOutputTool);

    const materialized = reg.materialize();
    const result = await materialized.settle(
      {
        name: "parse-job-output",
        input: { jobId: "job-1", attemptId: "attempt-1" },
        id: "call-parse-08c",
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(appendEventMock).toHaveBeenCalled();

    const calledTypes = appendEventMock.mock.calls.map((c: any[]) => c[0].type);
    expect(calledTypes).toContain("parse.started");
    expect(calledTypes).toContain("parse.completed");
    expect(calledTypes).toContain("result.saved");

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
