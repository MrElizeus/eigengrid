import { DigestSchema, IdSchema, digestCanonical } from "@eigengrid/scientific-schema";
import { z } from "zod";
import {
  AnalysisDiagnosticSchema,
  MdDiagnosisSchemaVersion,
  analysisDiagnostic,
  type AnalysisDiagnostic,
} from "./contracts";
import {
  AmberTelemetryParseResultSchema,
  assertAmberTelemetryParseResult,
  type AmberTelemetryParseResult,
} from "./telemetry";
import {
  TrajectoryQcReportSchema,
  assertTrajectoryQcReport,
  type TrajectoryQcReport,
} from "./trajectory-qc";

export const MdRemediationProposalSchema = z
  .object({
    kind: z.enum([
      "reconcile_operation",
      "quarantine_artifact",
      "inspect_protocol_inputs",
      "review_shake_instability",
      "resume_from_verified_restart",
      "rerun_typed_analysis",
    ]),
    rationale: z.string().min(1),
    automatic: z.literal(false),
    approvalRequired: z.boolean(),
    prerequisiteEvidenceRefs: z.array(IdSchema).min(1),
  })
  .strict();
export type MdRemediationProposal = z.infer<typeof MdRemediationProposalSchema>;

export const MdConservativeDiagnosisSchema = z
  .object({
    schemaVersion: z.literal(MdDiagnosisSchemaVersion),
    id: IdSchema,
    missionId: IdSchema,
    classification: z.enum([
      "no_issue_detected",
      "engine_failure",
      "artifact_integrity_failure",
      "scientific_review_required",
      "indeterminate",
    ]),
    diagnostics: z.array(AnalysisDiagnosticSchema),
    proposals: z.array(MdRemediationProposalSchema),
    evidenceRefs: z.array(IdSchema).min(1),
    limitations: z.array(z.string().min(1)).min(1),
    diagnosisDigest: DigestSchema,
  })
  .strict();
export type MdConservativeDiagnosis = z.infer<typeof MdConservativeDiagnosisSchema>;

export function computeMdConservativeDiagnosisDigest(
  value: Omit<MdConservativeDiagnosis, "diagnosisDigest"> | MdConservativeDiagnosis,
): string {
  const { diagnosisDigest: _diagnosisDigest, ...payload } = value as MdConservativeDiagnosis;
  return digestCanonical(payload);
}

export function assertMdConservativeDiagnosis(value: unknown): MdConservativeDiagnosis {
  const diagnosis = MdConservativeDiagnosisSchema.parse(value);
  if (diagnosis.diagnosisDigest !== computeMdConservativeDiagnosisDigest(diagnosis)) {
    throw new Error(`MD diagnosis digest mismatch for ${diagnosis.id}`);
  }
  return diagnosis;
}

export const MdDiagnosisRequestSchema = z
  .object({
    id: IdSchema,
    missionId: IdSchema,
    telemetry: AmberTelemetryParseResultSchema.optional(),
    trajectoryQc: TrajectoryQcReportSchema.optional(),
  })
  .strict()
  .refine((request) => request.telemetry !== undefined || request.trajectoryQc !== undefined, {
    path: ["telemetry"],
    message: "Diagnosis requires telemetry, trajectory QC, or both",
  });
export type MdDiagnosisRequest = z.infer<typeof MdDiagnosisRequestSchema>;

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function proposal(
  kind: MdRemediationProposal["kind"],
  rationale: string,
  prerequisiteEvidenceRefs: string[],
  approvalRequired: boolean,
): MdRemediationProposal {
  return MdRemediationProposalSchema.parse({
    kind,
    rationale,
    automatic: false,
    approvalRequired,
    prerequisiteEvidenceRefs: unique(prerequisiteEvidenceRefs),
  });
}

function telemetryDiagnosis(
  telemetry: AmberTelemetryParseResult,
  diagnostics: AnalysisDiagnostic[],
  proposals: MdRemediationProposal[],
): "engine_failure" | "scientific_review_required" | "indeterminate" | undefined {
  const refs = [telemetry.source.evidenceRef];
  diagnostics.push(...telemetry.diagnostics);
  if (["fatal", "nonzero_exit"].includes(telemetry.status)) {
    const shake = telemetry.diagnostics.some((item) => item.code === "shake_failure");
    proposals.push(
      proposal(
        shake ? "review_shake_instability" : "inspect_protocol_inputs",
        shake
          ? "Review topology, initial geometry, constraints, and timestep before proposing a new stage revision."
          : "Inspect exact engine inputs and fatal evidence before proposing a revised operation.",
        refs,
        true,
      ),
    );
    return "engine_failure";
  }
  if (["partial", "no_data"].includes(telemetry.status)) {
    diagnostics.push(
      analysisDiagnostic({
        code: "telemetry_completion_indeterminate",
        severity: "warning",
        message: "Telemetry does not establish a confirmed terminal outcome",
        evidenceRefs: refs,
      }),
    );
    proposals.push(
      proposal(
        "reconcile_operation",
        "Reconcile the durable operation receipt and external identity before any retry.",
        refs,
        false,
      ),
    );
    return "indeterminate";
  }
  if (telemetry.diagnostics.some((item) => item.severity === "warning")) {
    proposals.push(
      proposal(
        "inspect_protocol_inputs",
        "Review warnings against the approved stage criteria; no threshold is inferred here.",
        refs,
        false,
      ),
    );
    return "scientific_review_required";
  }
  return undefined;
}

function trajectoryDiagnosis(
  trajectoryQc: TrajectoryQcReport,
  diagnostics: AnalysisDiagnostic[],
  proposals: MdRemediationProposal[],
): "artifact_integrity_failure" | "indeterminate" | undefined {
  const evidenceRefs = unique([
    trajectoryQc.topologyEvidenceRef,
    ...trajectoryQc.checks.flatMap((item) => item.evidenceRefs),
  ]);
  if (trajectoryQc.status === "failed") {
    const failedCodes = trajectoryQc.checks
      .filter((item) => item.status === "failed")
      .map((item) => item.code);
    diagnostics.push(
      analysisDiagnostic({
        code: "trajectory_qc_failed",
        severity: "fatal",
        message: `Trajectory QC failed: ${unique(failedCodes).join(", ")}`,
        evidenceRefs,
      }),
    );
    proposals.push(
      proposal(
        "quarantine_artifact",
        "Prevent failed or mismatched trajectory artifacts from entering scientific analysis.",
        evidenceRefs,
        true,
      ),
    );
    if (
      failedCodes.some((code) =>
        [
          "segment_index_continuity",
          "restart_parent_continuity",
          "step_continuity",
          "time_continuity",
        ].includes(code),
      )
    ) {
      proposals.push(
        proposal(
          "resume_from_verified_restart",
          "A new segment may be proposed only from a checksum-verified restart after operation reconciliation.",
          evidenceRefs,
          true,
        ),
      );
    }
    return "artifact_integrity_failure";
  }
  if (trajectoryQc.status === "indeterminate") {
    diagnostics.push(
      analysisDiagnostic({
        code: "trajectory_qc_indeterminate",
        severity: "warning",
        message: "Trajectory integrity remains indeterminate; no readability claim is promoted",
        evidenceRefs,
      }),
    );
    proposals.push(
      proposal(
        "rerun_typed_analysis",
        "Run a typed decoded-NetCDF inspection against the exact content digest.",
        evidenceRefs,
        false,
      ),
    );
    return "indeterminate";
  }
  return undefined;
}

/**
 * Produces bounded proposals only. It never retries, quarantines, resumes, or
 * mutates a mission itself.
 */
export function diagnoseMdAnalysis(requestValue: unknown): MdConservativeDiagnosis {
  const request = MdDiagnosisRequestSchema.parse(requestValue);
  const telemetry =
    request.telemetry === undefined
      ? undefined
      : assertAmberTelemetryParseResult(request.telemetry);
  const trajectoryQc =
    request.trajectoryQc === undefined ? undefined : assertTrajectoryQcReport(request.trajectoryQc);
  if (telemetry !== undefined && telemetry.missionId !== request.missionId) {
    throw new Error("Telemetry result belongs to a different mission");
  }
  if (trajectoryQc !== undefined && trajectoryQc.missionId !== request.missionId) {
    throw new Error("Trajectory QC report belongs to a different mission");
  }
  const diagnostics: AnalysisDiagnostic[] = [];
  const proposals: MdRemediationProposal[] = [];
  const evidenceRefs = unique([
    ...(telemetry === undefined ? [] : [telemetry.source.evidenceRef]),
    ...(trajectoryQc === undefined
      ? []
      : [
          trajectoryQc.topologyEvidenceRef,
          ...trajectoryQc.checks.flatMap((item) => item.evidenceRefs),
        ]),
  ]);
  const safeEvidenceRefs = evidenceRefs.length > 0 ? evidenceRefs : [request.id];

  const telemetryClass =
    telemetry === undefined ? undefined : telemetryDiagnosis(telemetry, diagnostics, proposals);
  const trajectoryClass =
    trajectoryQc === undefined
      ? undefined
      : trajectoryDiagnosis(trajectoryQc, diagnostics, proposals);
  const classification: MdConservativeDiagnosis["classification"] =
    trajectoryClass === "artifact_integrity_failure"
      ? trajectoryClass
      : telemetryClass === "engine_failure"
        ? telemetryClass
        : trajectoryClass === "indeterminate" || telemetryClass === "indeterminate"
          ? "indeterminate"
          : telemetryClass === "scientific_review_required"
            ? telemetryClass
            : "no_issue_detected";

  const unsigned = {
    schemaVersion: MdDiagnosisSchemaVersion,
    id: request.id,
    missionId: request.missionId,
    classification,
    diagnostics,
    proposals,
    evidenceRefs: safeEvidenceRefs,
    limitations: [
      "Diagnosis classifies observed artifacts only and does not establish equilibration or convergence.",
      "Every remediation is a proposal; this package performs no external or mission-state effect.",
    ],
  };
  return MdConservativeDiagnosisSchema.parse({
    ...unsigned,
    diagnosisDigest: computeMdConservativeDiagnosisDigest(unsigned),
  });
}
