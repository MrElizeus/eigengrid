import { type ExternalOperation } from "@eigengrid/scientific-schema";
import { mdStageEffectIdentity } from "../md-effect-authority";

export function effectIdentity(value: unknown): { jobId?: string; attemptId?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.jobId === "string" ? { jobId: record.jobId } : {}),
    ...(typeof record.attemptId === "string" ? { attemptId: record.attemptId } : {}),
  };
}

export function requestedEffectIdentity(operation: ExternalOperation): {
  jobId?: string;
  attemptId?: string;
} {
  if (operation.kind === "md_stage_execution") return mdStageEffectIdentity(operation);
  if (
    !operation.request ||
    typeof operation.request !== "object" ||
    Array.isArray(operation.request)
  ) {
    return {};
  }
  const request = operation.request as Record<string, unknown>;
  return {
    ...(typeof request.intendedJobId === "string" ? { jobId: request.intendedJobId } : {}),
    ...(typeof request.intendedAttemptId === "string"
      ? { attemptId: request.intendedAttemptId }
      : {}),
  };
}
