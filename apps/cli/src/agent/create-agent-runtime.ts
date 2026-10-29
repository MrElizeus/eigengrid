import type { Config, PermissionRuleset } from "@eigengrid/core";
import type { DatabaseLike } from "@eigengrid/db";
import {
  ToolRegistry,
  doctorTool,
  listJobsTool,
  getJobStatusTool,
  readLogTool,
  listNodesTool,
  inspectNodeTool,
  submitJobTool,
  parseJobOutputTool,
  cancelJobTool,
} from "@eigengrid/tool-registry";
import type { ToolContext } from "@eigengrid/tool-registry";
import { InProcessEventBus } from "@eigengrid/events";
import { AgentMemory, getDefaultPermissionRules } from "@eigengrid/agent";
import { createApplicationContext } from "../composition/context";
import {
  listArtifactsTool,
  listEventsTool,
  listRecipesTool,
  listResultsTool,
} from "./operational-read-tools";
import {
  inspectProtocolTool,
  listProtocolsTool,
  validateMdProtocolTool,
} from "./scientific-catalog-tools";
import { createOperatorInfoTool } from "./operator-info-tool";
import { clusterNodeRecords } from "../services/cluster-inventory";
import { OperatorPermissions } from "../services/operator-permissions";
import { readFileTool, writeFileTool, runCommandTool } from "./operator-file-tools";

// ────────────────────────────────────────────────────────────
// Options
// ────────────────────────────────────────────────────────────

export interface AgentRuntimeOptions {
  /** Unavailable in process-owned chat; use a durable mission session. */
  allowActions?: boolean;
  permissions?: OperatorPermissions;
}

// ────────────────────────────────────────────────────────────
// AgentRuntime Interface
// ────────────────────────────────────────────────────────────

export interface AgentRuntime {
  /** Resolved configuration */
  config: Config;
  /** Initialized database */
  db: DatabaseLike;
  /** Tool registry with canonical tools registered */
  registry: ToolRegistry;
  /** Tool execution context (db, python, runners, bus, config) */
  ctx: ToolContext;
  /** Agent memory instance (connected) */
  memory?: AgentMemory;
  /** Permission rules governing automatic tool materialization. */
  permissionRules?: PermissionRuleset;
  approvalAuthority: OperatorPermissions;
  /** Close and release all resources */
  close(): Promise<void>;
}

// ────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────

/**
 * Create a fully initialized agent runtime.
 *
 * Registered canonical tools:
 *   - operational state, evidence, recipes, and scientific protocol discovery
 *   - submit-job, parse-job-output, and cancel-job as approval-required metadata
 *
 * submitGaussianTool is NOT registered — deprecated in favor of submitJobTool.
 */
export async function createAgentRuntime(options?: AgentRuntimeOptions): Promise<AgentRuntime> {
  if (options?.allowActions) {
    throw new Error(
      "--allow-actions is unavailable in chat; use agent-session for durable per-call approval and resume.",
    );
  }

  // ── 1. Resolve the canonical application composition root ──
  // This keeps the agent on the same provider-neutral database,
  // parser, recipe, and lifecycle wiring as the CLI commands.
  const app = await createApplicationContext();
  const { config, db } = app;

  // ── 3. Bind default permissions and register canonical tools ──
  // NOTE: submitGaussianTool is intentionally NOT registered here.
  const permissionRules = getDefaultPermissionRules();
  permissionRules.push(
    { action: "tool:execute", resource: "read-file", effect: "allow" },
    { action: "tool:execute", resource: "write-file", effect: "ask" },
    { action: "tool:execute", resource: "run-command", effect: "ask" },
  );
  const permissions = options?.permissions ?? new OperatorPermissions();
  permissions.bindJobInspector(async (id) => {
    const job = await db.getJob(id);
    const attempts = await db.listJobAttempts(id);
    const latest = attempts.at(-1);
    return {
      backend: job?.backend ?? latest?.runner ?? null,
      workdir: job?.workdir ?? null,
      state: {
        id,
        status: job?.status ?? null,
        backend: job?.backend ?? latest?.runner ?? null,
        attempt: latest?.id ?? null,
        attemptStatus: latest?.status ?? null,
        externalJobId: job?.externalJobId ?? null,
      },
    };
  });
  const registry = new ToolRegistry(permissionRules, (call) => permissions.authorizeTool(call));
  registry.register(doctorTool);
  registry.register(listJobsTool);
  registry.register(getJobStatusTool);
  registry.register(readLogTool);
  registry.register({
    ...listNodesTool,
    async execute(ctx: ToolContext, input: Parameters<typeof listNodesTool.execute>[1]) {
      try {
        const nodes = await clusterNodeRecords();
        return nodes
          ? { ok: true, data: { nodes, total: nodes.length } }
          : listNodesTool.execute(ctx, input);
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "CLUSTER_UNAVAILABLE",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  });
  registry.register({
    ...inspectNodeTool,
    async execute(ctx: ToolContext, input: Parameters<typeof inspectNodeTool.execute>[1]) {
      try {
        const nodes = await clusterNodeRecords();
        if (!nodes) return inspectNodeTool.execute(ctx, input);
        const node = nodes.find((n) => n.id === input.nodeId || n.name === input.nodeId);
        return node
          ? {
              ok: true,
              data: { ok: true, node, message: `Slurm node ${node.name}: ${node.status}` },
            }
          : {
              ok: false,
              error: {
                code: "NODE_NOT_FOUND",
                message: "Node not found in the live Slurm inventory",
              },
            };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "CLUSTER_UNAVAILABLE",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  });
  registry.register(listArtifactsTool);
  registry.register(listResultsTool);
  registry.register(listEventsTool);
  registry.register(listRecipesTool);
  registry.register(listProtocolsTool);
  registry.register(inspectProtocolTool);
  registry.register(validateMdProtocolTool);
  registry.register(submitJobTool);
  registry.register(parseJobOutputTool);
  registry.register(cancelJobTool);
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(runCommandTool);
  registry.register(createOperatorInfoTool(registry));

  // ── 3. Build context ───────────────────────────────────
  const bus = new InProcessEventBus();
  const ctx: ToolContext = {
    db,
    python: app.parsers,
    runners: Object.fromEntries(app.backends.runners),
    bus,
    config,
    execution: app.execution,
  };

  // ── 4. Create agent memory ─────────────────────────────
  const memory = new AgentMemory();
  try {
    await memory.connect();
  } catch (error) {
    await app.close();
    throw error;
  }

  // ── 5. Return runtime ──────────────────────────────────
  let closed = false;
  return {
    config,
    db,
    registry,
    ctx,
    memory,
    permissionRules,
    approvalAuthority: permissions,
    async close() {
      if (closed) return;
      closed = true;
      await memory.disconnect();
      await app.close();
    },
  };
}
