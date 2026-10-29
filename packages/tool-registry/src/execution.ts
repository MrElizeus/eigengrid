import { z } from "zod";
import type { ToolContext, Settlement, Content, ToolCallOrigin } from "./types";
import type { AnyTool, Call } from "./tool";
import { settle as settleTool } from "./tool";

// ────────────────────────────────────────────────────────────
// Execution Plan
// ────────────────────────────────────────────────────────────

/**
 * A single step in an execution plan. Associates a tool name
 * with its pre-validated input. The `id` field links back to
 * the originating tool call for audit trails.
 */
export interface ExecutionStep {
  id: string;
  name: string;
  input: unknown;
}

/**
 * A multi-step execution plan produced by an agent planner or
 * a deterministic recipe. Steps are executed sequentially;
 * if any step fails, remaining steps are skipped by default.
 */
export interface ExecutionPlan {
  steps: ExecutionStep[];
  onFailure: "stop" | "continue";
}

/**
 * Result of executing a single step.
 */
export interface StepResult {
  id: string;
  name: string;
  ok: boolean;
  settled: Settlement;
  durationMs: number;
}

/**
 * Aggregate result of executing an ExecutionPlan.
 * Contains results for every step that ran.
 */
export interface PlanResult {
  ok: boolean;
  stepResults: StepResult[];
  failedStepIndex?: number;
  totalDurationMs: number;
}

// ────────────────────────────────────────────────────────────
// Execution Errors
// ────────────────────────────────────────────────────────────

/**
 * Typed error class for tool execution failures.
 * Compatible with the `error` field in ToolResult / Settlement.
 */
export class ExecutionError extends Error {
  public readonly code: string;
  public readonly hint?: string;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "ExecutionError";
    this.code = code;
    this.hint = hint;
  }

  toJSON(): { code: string; message: string; hint?: string } {
    return { code: this.code, message: this.message, hint: this.hint };
  }
}

/**
 * Pre-built error factories for common execution failure modes.
 */
export const ExecutionErrors = {
  toolNotFound(name: string): ExecutionError {
    return new ExecutionError("TOOL_NOT_FOUND", `Tool '${name}' not found.`);
  },

  invalidInput(name: string, issues: z.ZodIssue[]): ExecutionError {
    const messages = issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return new ExecutionError(
      "INVALID_INPUT",
      `Invalid input for tool '${name}': ${messages}`,
      "Check the input fields against the tool schema.",
    );
  },

  executionFailed(name: string, message: string): ExecutionError {
    return new ExecutionError(
      "EXECUTION_ERROR",
      `Tool '${name}' execution failed: ${message}`,
      "Check the tool implementation or runtime dependencies.",
    );
  },

  invalidOutput(name: string, issues: z.ZodIssue[]): ExecutionError {
    const messages = issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return new ExecutionError(
      "INVALID_OUTPUT",
      `Tool '${name}' returned output that does not match its schema: ${messages}`,
    );
  },

  planAborted(stepIndex: number, cause: string): ExecutionError {
    return new ExecutionError(
      "PLAN_ABORTED",
      `Execution plan aborted at step ${stepIndex + 1}: ${cause}`,
    );
  },
} as const;

// ────────────────────────────────────────────────────────────
// Single-Step Execution
// ────────────────────────────────────────────────────────────

export interface SingleStepOptions {
  tool: AnyTool;
  call: Call;
  ctx: ToolContext;
  /** Mandatory host-supplied current authority. Missing means deny. */
  authorize?: (call: Call) => Promise<boolean>;
}

/**
 * Execute a single tool call through the two-phase settlement
 * pipeline and return a structured StepResult with timing.
 */
export async function executeStep(options: SingleStepOptions): Promise<StepResult> {
  const start = performance.now();

  const allowed = options.authorize && (await options.authorize(options.call));
  const settled: Settlement = allowed
    ? await settleTool(options.tool, options.call, options.ctx)
    : {
        ok: false,
        content: [{ type: "text", text: "Missing tool authority" }],
        error: { code: "PERMISSION_DENIED", message: "Host must authorize tool execution" },
      };

  const durationMs = Math.round(performance.now() - start);

  return {
    id: options.call.id,
    name: options.call.name,
    ok: settled.ok,
    settled,
    durationMs,
  };
}

// ────────────────────────────────────────────────────────────
// Plan Execution
// ────────────────────────────────────────────────────────────

export interface PlanExecutorOptions {
  /**
   * Map of tool name to AnyTool definition. The executor
   * resolves each step's tool from this map.
   */
  tools: Map<string, AnyTool>;
  /**
   * System context injected into every tool execution.
   */
  ctx: ToolContext;
  /** Missing callback denies all effects; never trust model-supplied grants. */
  authorize?: (call: Call) => Promise<boolean>;
}

/**
 * Execute an ExecutionPlan sequentially through the two-phase
 * settlement pipeline. Returns a PlanResult with per-step
 * timing and cumulative duration.
 *
 * @example
 * const executor = createPlanExecutor({ tools, ctx });
 * const result = await executor.execute(plan);
 *
 * if (!result.ok) {
 *   console.log(`Failed at step ${result.failedStepIndex}: ${result.stepResults[result.failedStepIndex!].settled.error?.message}`);
 * }
 */
export function createPlanExecutor(options: PlanExecutorOptions) {
  const { tools, ctx, authorize } = options;

  return {
    /**
     * Execute all steps in the plan sequentially.
     */
    async execute(plan: ExecutionPlan): Promise<PlanResult> {
      const totalStart = performance.now();
      const stepResults: StepResult[] = [];

      for (let i = 0; i < plan.steps.length; i++) {
        const step = plan.steps[i];
        const tool = tools.get(step.name);

        if (!tool) {
          const settled: Settlement = {
            ok: false,
            content: [{ type: "text", text: `Unknown tool: ${step.name}` }],
            error: { code: "TOOL_NOT_FOUND", message: `Tool '${step.name}' not found.` },
          };

          stepResults.push({
            id: step.id,
            name: step.name,
            ok: false,
            settled,
            durationMs: 0,
          });

          if (plan.onFailure === "stop") {
            const totalDurationMs = Math.round(performance.now() - totalStart);
            return { ok: false, stepResults, failedStepIndex: i, totalDurationMs };
          }

          continue;
        }

        const call: Call = { id: step.id, name: step.name, input: step.input };
        const stepResult = await executeStep({ tool, call, ctx, authorize });
        stepResults.push(stepResult);

        if (!stepResult.ok && plan.onFailure === "stop") {
          const totalDurationMs = Math.round(performance.now() - totalStart);
          return { ok: false, stepResults, failedStepIndex: i, totalDurationMs };
        }
      }

      const totalDurationMs = Math.round(performance.now() - totalStart);
      return { ok: true, stepResults, totalDurationMs };
    },
  };
}

// ────────────────────────────────────────────────────────────
// Re-exports
// ────────────────────────────────────────────────────────────

export { Settlement, Content };
export type { ToolCallOrigin };
