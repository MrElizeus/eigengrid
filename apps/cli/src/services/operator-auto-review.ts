import { extname } from "node:path";
import type { OperationKind } from "@eigengrid/agent/execution-permissions";

export interface OperatorReviewFacts {
  readonly name: string;
  readonly kind: OperationKind;
  readonly withinWorkspace: boolean;
  readonly path?: string;
  readonly bytes?: number;
  readonly protectedPath: boolean;
}

/** Independent deterministic reviewer: no execution, credentials, model instructions or policy edits. */
export function reviewOperatorAction(facts: OperatorReviewFacts): {
  approved: boolean;
  reason: string;
} {
  if (
    facts.name === "write-file" &&
    facts.kind === "write" &&
    facts.withinWorkspace &&
    !facts.protectedPath &&
    facts.path &&
    facts.bytes !== undefined &&
    facts.bytes <= 1024 * 1024 &&
    [".in", ".inp", ".pwi", ".pw", ".xyz", ".cif", ".gjf", ".com"].includes(
      extname(facts.path).toLowerCase(),
    )
  )
    return { approved: true, reason: "Bounded scientific input edit inside this workspace." };
  return {
    approved: false,
    reason: "This action requires human review; it is outside the automatic review allowlist.",
  };
}
