// ── Types ──────────────────────────────────────────────────
export type {
  Tool,
  ToolContext,
  ToolResult,
  ToolCallOrigin,
  Settlement,
  Content,
  PermissionEffect,
  PermissionRule,
  PermissionRuleset,
} from "./types";

// ── Tool Registry ──────────────────────────────────────────
export { ToolRegistry } from "./registry";
export type { Materialization } from "./registry";
export { materializePlanMode, PLAN_MODE_READ_ONLY_TOOL_NAMES } from "./plan-mode";

// ── Tool Factory (opencode-extracted) ──────────────────────
export {
  make as makeTool,
  withPermission as withToolPermission,
  settle as settleTool,
  definition as toolDefinition,
  validateName as validateToolName,
  permissionOf as toolPermissionOf,
} from "./tool";
export type {
  Definition as ToolDefinition,
  AnyTool,
  ToolConfig,
  ToolJSONDefinition,
  Call as ToolCall,
} from "./tool";

// ── Execution Pipeline ─────────────────────────────────────
export { executeStep, createPlanExecutor, ExecutionError, ExecutionErrors } from "./execution";
export type {
  ExecutionStep,
  ExecutionPlan,
  StepResult,
  PlanResult,
  PlanExecutorOptions,
  SingleStepOptions,
} from "./execution";

// ── Builtin Tools ──────────────────────────────────────────
// submitGaussianTool removed — deprecated in favor of submitJobTool
export { submitJobTool } from "./builtin/submit-job";
export { parseOutputTool } from "./builtin/parse-output";
export { parseJobOutputTool } from "./builtin/parse-job-output";
export { inspectNodeTool } from "./builtin/inspect-node";
export { readLogTool } from "./builtin/read-log";
export { doctorTool } from "./builtin/doctor";
export { listJobsTool } from "./builtin/list-jobs";
export { getJobStatusTool } from "./builtin/get-job-status";
export { listNodesTool } from "./builtin/list-nodes";
export { cancelJobTool } from "./builtin/cancel-job";
export * from "./builtin/md";
