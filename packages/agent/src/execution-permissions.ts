export type PermissionPresetId = "read-only" | "ask" | "auto-review" | "sandboxed" | "full-access";
export type ApprovalPolicy = "human" | "auto-review" | "none";
export type ExecutionScope = "read-only" | "workspace" | "sandbox" | "host";
export type OperationKind =
  | "read"
  | "write"
  | "compute"
  | "remote"
  | "shell"
  | "destructive"
  | "unknown";

export interface PermissionPreset {
  readonly id: PermissionPresetId;
  readonly name: string;
  readonly description: string;
  readonly approvalPolicy: ApprovalPolicy;
  readonly executionScope: ExecutionScope;
}

export const PERMISSION_PRESETS: readonly PermissionPreset[] = Object.freeze(
  [
    {
      id: "read-only",
      name: "Read Only",
      description: "Inspect configurations, calculations and results.",
      approvalPolicy: "none",
      executionScope: "read-only",
    },
    {
      id: "ask",
      name: "Ask for Approval",
      description: "Request confirmation before changing or executing.",
      approvalPolicy: "human",
      executionScope: "host",
    },
    {
      id: "auto-review",
      name: "Auto Review",
      description: "Independently review eligible actions; ask about risky operations.",
      approvalPolicy: "auto-review",
      executionScope: "host",
    },
    {
      id: "sandboxed",
      name: "Autonomous (Sandboxed)",
      description: "Run scientific workflows within verified isolation and resource limits.",
      approvalPolicy: "none",
      executionScope: "sandbox",
    },
    {
      id: "full-access",
      name: "Full Access",
      description: "Run tools with your current OS permissions.",
      approvalPolicy: "none",
      executionScope: "host",
    },
  ].map((preset) => Object.freeze(preset)) as PermissionPreset[],
);

export function permissionPreset(id: unknown): PermissionPreset {
  const preset = PERMISSION_PRESETS.find((item) => item.id === id);
  if (!preset) throw new Error("Unknown permissions preset");
  return preset;
}

export const READ_ONLY_OPERATOR_TOOLS = Object.freeze([
  "doctor",
  "list-jobs",
  "get-job-status",
  "read-log",
  "list-nodes",
  "inspect-node",
  "list-artifacts",
  "list-results",
  "list-events",
  "list-recipes",
  "list-protocols",
  "inspect-protocol",
  "validate-md-protocol",
  "operator-info",
  "read-file",
]);

export function operatorToolKind(name: string): OperationKind {
  if (READ_ONLY_OPERATOR_TOOLS.includes(name)) return "read";
  if (name === "write-file" || name === "parse-job-output") return "write";
  if (name === "submit-job") return "compute";
  if (name === "run-command") return "shell";
  if (name === "cancel-job") return "destructive";
  return "unknown";
}

/** Approval is evaluated only after the execution scope has permitted an action. */
export function permissionDecision(
  preset: PermissionPreset,
  kind: OperationKind,
  independentlyReviewed = false,
): "allow" | "ask" | "deny" {
  if (kind === "unknown") return "deny";
  if (kind === "read") return "allow";
  if (preset.executionScope === "read-only") return "deny";
  if (preset.executionScope === "host" && preset.approvalPolicy === "none") return "allow";
  if (preset.executionScope === "sandbox") {
    if (kind === "shell" || kind === "remote") return "deny";
    return kind === "destructive" ? "ask" : "allow";
  }
  if (preset.approvalPolicy === "auto-review" && independentlyReviewed && kind === "write")
    return "allow";
  return "ask";
}
