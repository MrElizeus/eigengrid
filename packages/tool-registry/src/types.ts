import type { EventBus } from "@eigengrid/events";
import type { PythonBridge } from "@eigengrid/python-bridge";
import type { Config } from "@eigengrid/core";
import type { Runner } from "@eigengrid/runners";
import type { DatabaseLike } from "@eigengrid/db";

// ────────────────────────────────────────────────────────────
// Dependency Injection Context
// ────────────────────────────────────────────────────────────

/**
 * Injector context passed to every tool execution and settlement
 * call. Contains all system services the tool may interact with.
 */
export interface ToolContext {
  db: DatabaseLike;
  python: PythonBridge;
  runners: Record<string, Runner>;
  bus: EventBus;
  config: Config;
  /**
   * Canonical effect owner. Production mutation-capable tools must route
   * through this boundary instead of invoking a runner or backend directly.
   * Kept optional for read-only/legacy test contexts; production composition
   * always supplies it.
   */
  execution?: {
    executeLocal?: (request: {
      software: string;
      inputPath: string;
      name?: string;
      expectedInputDigest?: string;
    }) => Promise<{
      ok: boolean;
      jobId?: string;
      attemptId?: string;
      message?: string;
      status?: string;
    }>;
    parseJob?: (
      jobId: string,
      attemptId?: string,
    ) => Promise<{
      ok: boolean;
      jobId?: string;
      attemptId?: string;
      resultId?: string;
      parser?: string;
      message: string;
    }>;
    dispatchRemote?: (
      jobId: string,
      backend: Runner,
    ) => Promise<{
      ok: boolean;
      message?: string;
      status?: string;
    }>;
    reconcileRemote?: (
      jobId: string,
      backend: Runner,
    ) => Promise<{
      ok: boolean;
      message?: string;
      status?: string;
    }>;
    cancelRemote?: (
      jobId: string,
      backend: Runner,
    ) => Promise<{
      ok: boolean;
      message?: string;
      status?: string;
    }>;
    collectRemote?: (
      jobId: string,
      backend: Runner,
    ) => Promise<{
      ok: boolean;
      message?: string;
      status?: string;
    }>;
    cancelLocal?: (jobId: string) => Promise<{
      ok: boolean;
      jobId?: string;
      attemptId?: string;
      message: string;
    }>;
    cancelPending?: (
      jobId: string,
      reason?: string,
    ) => Promise<{
      ok: boolean;
      jobId?: string;
      attemptId?: string;
      previousStatus?: string;
      message: string;
    }>;
  };
}

/**
 * Identifies the provenance of a tool call within an agentic
 * session. Used for audit trails and permission evaluation.
 */
export interface ToolCallOrigin {
  sessionID: string;
  agentID: string;
  assistantMessageID: string;
  toolCallID: string;
}

// ────────────────────────────────────────────────────────────
// Execution Results
// ────────────────────────────────────────────────────────────

/**
 * Standardised execution result originating from a tool's
 * internal `execute()` function.
 */
export interface ToolResult<TOutput = unknown> {
  ok: boolean;
  data?: TOutput;
  error?: { code: string; message: string; hint?: string };
}

/**
 * Structured output of the two-phase settlement pipeline.
 * The `content` array carries model-facing text/file chunks
 * derived from the raw execution output.
 */
export interface Settlement {
  ok: boolean;
  output?: unknown;
  content: Content[];
  error?: { code: string; message: string; hint?: string };
}

/**
 * A single piece of content produced by settlement, ready for
 * model or human consumption.
 */
export type Content =
  | { type: "text"; text: string }
  | { type: "file"; data: string; mime: string; name?: string };

// ────────────────────────────────────────────────────────────
// Tool Interface (Legacy / Direct)
// ────────────────────────────────────────────────────────────

/**
 * Direct tool definition. Builtin tools may use this interface
 * for simple cases. The recommended path for new tools is
 * `Tool.make()` from `./tool.ts`.
 */
export interface Tool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: import("zod").ZodType<TInput>;
  outputSchema: import("zod").ZodType<TOutput>;
  execute(ctx: ToolContext, input: TInput): Promise<ToolResult<TOutput>>;
}

// ────────────────────────────────────────────────────────────
// Permission Contracts
// ────────────────────────────────────────────────────────────

export type PermissionEffect = "allow" | "deny" | "ask";

export interface PermissionRule {
  action: string;
  resource: string;
  effect: PermissionEffect;
}

export type PermissionRuleset = PermissionRule[];
