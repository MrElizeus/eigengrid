/** Pure validation, canonical digests and legacy storage mappings; no database access. */
import {
  digestCanonical,
  type EvidenceReference,
  type ExternalOperation,
  type MissionBudget,
  type MissionState,
  type ModelInvocationRecord,
  type ResolvedSkillGraph,
  type ScientificObservation,
  type ScientificPlan,
  type WorkUnit,
  type WorkUnitState,
} from "@eigengrid/scientific-schema";
import type { ZodTypeAny, output } from "zod";
import { ScientificDigestMismatchError, ScientificIntegrityError } from "./errors";
import { type MissionProjectCreationAuthorityInput } from "./mission-project";

export type BudgetReservation = MissionBudget["reservations"][number];

export type JsonRow = { payload_json: string } & Record<string, unknown>;

/**
 * Authenticated, multi-user creation input for the Production V1 path. The
 * selected project is only a request parameter: PostgreSQL validates the human
 * owner, active project and exact current membership in the same transaction
 * that persists the aggregate.
 */
export interface CreateMissionInProjectInput extends MissionProjectCreationAuthorityInput {
  budget: MissionBudget;
}

export const TERMINAL_MISSION_STATES = new Set<MissionState>(["completed", "failed", "cancelled"]);

export const CLAIM_HOLDING_STATES = new Set<WorkUnitState>(["claimed", "executing", "observing"]);

export const CLAIM_COMPATIBLE_MISSION_STATES = new Set<MissionState>([
  "ready",
  "executing",
  "observing",
  "diagnosing",
  "validating",
]);

export const APPROVAL_VALIDATION_COMPATIBLE_MISSION_STATES = new Set<MissionState>([
  "awaiting_approval",
  ...CLAIM_COMPATIBLE_MISSION_STATES,
  "completed",
  "paused",
  "blocked",
]);

export const LEGACY_WORK_UNIT_KINDS = new Set([
  "structure_validation",
  "optimization",
  "frequency",
  "collection",
  "parsing",
  "validation",
  "assessment",
  "diagnosis",
]);

export function legacyWorkUnitKind(kind: WorkUnit["kind"]): string {
  return LEGACY_WORK_UNIT_KINDS.has(kind) ? kind : "validation";
}

export function legacyOperationKind(kind: ExternalOperation["kind"]): string {
  switch (kind) {
    case "local_execution":
    case "collect":
    case "parse":
    case "cancel":
    case "model_invocation":
      return kind;
    case "evidence_fetch":
    case "artifact_export":
      return "collect";
    case "trajectory_analysis":
      return "parse";
    case "system_preparation":
    case "ligand_parameterization":
    case "topology_build":
    case "md_stage_execution":
      return "local_execution";
  }
}

export function legacyEvidenceKind(kind: EvidenceReference["kind"]): string {
  switch (kind) {
    case "objective":
    case "structure":
    case "rendered_input":
    case "environment":
    case "operation_receipt":
    case "artifact":
    case "parser_output":
    case "skill_fragment":
    case "human_review":
      return kind;
    case "source_snapshot":
    case "construct_audit":
      return "structure";
    case "normalized_metrics":
    case "analysis_result":
      return "parser_output";
    case "microstate_decision":
    case "md_assessment":
      return "human_review";
    case "biomolecular_system_manifest":
    case "force_field_stack":
    case "pose_candidate":
    case "atom_map":
    case "topology":
    case "coordinates":
    case "restart":
    case "trajectory":
    case "mdout":
    case "mdinfo":
    case "reproducibility_bundle":
      return "artifact";
  }
}

export function legacyObservationType(type: ScientificObservation["type"]): string {
  switch (type) {
    case "structure_validity":
    case "normal_termination":
    case "electronic_convergence":
    case "geometry_convergence":
    case "imaginary_frequencies":
    case "energy":
    case "failure_signature":
    case "artifact_integrity":
      return type;
    case "topology_integrity":
    case "restart_continuity":
      return "artifact_integrity";
    case "stage_completion":
      return "normal_termination";
    case "temperature":
    case "pressure":
    case "density":
    case "volume":
    case "membrane_observable":
    case "ligand_stability":
    case "replica_convergence":
    case "engine_parity":
      return "energy";
  }
}

export function legacyModelRole(role: ModelInvocationRecord["role"]): string {
  switch (role) {
    case "planner":
    case "critic":
    case "diagnostician":
    case "assessment_composer":
      return role;
    case "operator":
    case "monitor":
    case "analyst":
    case "reporter":
      return "assessment_composer";
  }
}

export function omitKey<T extends Record<string, unknown>, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

export function computeSkillGraphDigest(
  graph: Omit<ResolvedSkillGraph, "graphDigest"> | ResolvedSkillGraph,
): string {
  const {
    graphDigest: _graphDigest,
    id: _id,
    missionId: _missionId,
    resolvedAt: _resolvedAt,
    ...resolution
  } = graph as ResolvedSkillGraph;
  return digestCanonical(resolution);
}

export function computeProtocolDigest(
  protocol: Omit<ScientificPlan["protocol"], "protocolDigest">,
): string {
  return digestCanonical(protocol);
}

export function computePlanDigest(
  plan: Omit<ScientificPlan, "planDigest"> | ScientificPlan,
): string {
  const {
    planDigest: _planDigest,
    status: _status,
    updatedAt: _updatedAt,
    ...immutablePlan
  } = plan as ScientificPlan;
  return digestCanonical(immutablePlan);
}

export function assertEmbeddedDigest<T extends Record<string, unknown>, K extends keyof T>(
  subject: string,
  value: T,
  digestKey: K,
): void {
  const actual = String(value[digestKey]);
  const expected = digestCanonical(omitKey(value, digestKey));
  if (actual !== expected) {
    throw new ScientificDigestMismatchError(subject, expected, actual);
  }
}

export function requireTimestampOrder(start: string, end: string, label: string): void {
  if (Date.parse(end) <= Date.parse(start)) {
    throw new ScientificIntegrityError(`${label} must be later than ${start}`, { start, end });
  }
}

export function parsePayload<S extends ZodTypeAny>(
  schema: S,
  row: JsonRow,
  entity: string,
): output<S> {
  let raw: unknown;
  try {
    raw = JSON.parse(String(row.payload_json));
  } catch {
    throw new ScientificIntegrityError(`${entity} contains malformed authoritative JSON`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ScientificIntegrityError(`${entity} failed authoritative schema validation`, {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

export function parseBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

export function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function exactPlanApprovalRole(plan: ScientificPlan): string {
  if (plan.requiredApprovals.length !== 1) {
    throw new ScientificIntegrityError("Executable alpha plans require exactly one approval role", {
      planId: plan.id,
      requiredApprovals: plan.requiredApprovals,
    });
  }
  return plan.requiredApprovals[0]!;
}

export function assertWorkUnitApprovalContract(workUnit: WorkUnit, plan: ScientificPlan): void {
  const requiredRole = exactPlanApprovalRole(plan);
  if (workUnit.approvalPolicy.required && workUnit.approvalPolicy.minimumRole !== requiredRole) {
    throw new ScientificIntegrityError(
      "Approval-required work units must use the plan's single approval role",
      {
        workUnitId: workUnit.id,
        planId: plan.id,
        requiredRole,
        minimumRole: workUnit.approvalPolicy.minimumRole ?? null,
      },
    );
  }
}
