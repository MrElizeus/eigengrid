import { z } from "zod";
import { digestCanonical } from "@eigengrid/scientific-schema";
import { Sha256Schema } from "./contracts";

/**
 * Evidence-only Amber stage assessment.  It intentionally does not execute a
 * command, mutate a mission, or promote a scientific skill.  A result marked
 * `qualified` means only that this exact stage evidence passed the supplied
 * deterministic checks; it is not a biological or publication claim.
 */
export const AmberStageEvidenceSchema = z
  .object({
    schemaVersion: z.literal("amber-stage-evidence/v1"),
    missionId: z.string().min(1).max(256),
    planId: z.string().min(1).max(256),
    planDigest: Sha256Schema,
    stageId: z.string().min(1).max(256),
    stageKind: z.enum([
      "input-preflight",
      "minimization",
      "heating",
      "density-equilibration",
      "equilibration",
      "production",
      "analysis",
    ]),
    executable: z.enum(["sander", "sander.MPI", "pmemd", "pmemd.MPI", "pmemd.cuda", "cpptraj"]),
    environmentDigest: Sha256Schema,
    binarySha256: Sha256Schema,
    engineVersion: z.string().min(1).max(256),
    operationReceiptId: z.string().min(1).max(256),
    exitCode: z.number().int().nullable(),
    terminalReason: z.enum([
      "completed",
      "cancelled",
      "timeout",
      "signal",
      "engine_failure",
      "validation_failure",
      "ambiguous",
    ]),
    expectedSteps: z.number().int().positive().optional(),
    observedSteps: z.number().int().nonnegative().optional(),
    expectedFrameCount: z.number().int().positive().optional(),
    observedFrameCount: z.number().int().nonnegative().optional(),
    artifacts: z
      .array(
        z
          .object({
            role: z.string().regex(/^[a-z][a-z0-9._-]*$/u),
            digest: Sha256Schema,
            bytes: z.number().int().nonnegative(),
            readable: z.boolean(),
          })
          .strict(),
      )
      .min(1),
    requiredArtifactRoles: z.array(z.string().regex(/^[a-z][a-z0-9._-]*$/u)).min(1),
    restart: z
      .object({
        parentDigest: Sha256Schema.nullable(),
        outputDigest: Sha256Schema,
        readable: z.boolean(),
        startStep: z.number().int().nonnegative(),
        endStep: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    parser: z
      .object({
        id: z.string().min(1).max(256),
        version: z.string().min(1).max(256),
        status: z.enum(["complete", "partial", "invalid", "not_run"]),
      })
      .strict()
      .optional(),
    fatalSignatures: z.array(z.string().min(1).max(1024)),
    telemetry: z
      .array(
        z
          .object({
            step: z.number().int().nonnegative(),
            timePs: z.number().finite().nonnegative(),
            temperatureK: z.number().finite().optional(),
            pressureBar: z.number().finite().optional(),
            densityGmL: z.number().finite().optional(),
            totalEnergyKcalMol: z.number().finite().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .superRefine((evidence, context) => {
    const roles = evidence.artifacts.map((artifact) => artifact.role);
    if (new Set(roles).size !== roles.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifacts"],
        message: "artifact roles must be unique",
      });
    }
    if (new Set(evidence.requiredArtifactRoles).size !== evidence.requiredArtifactRoles.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiredArtifactRoles"],
        message: "required artifact roles must be unique",
      });
    }
    if (
      evidence.expectedSteps !== undefined &&
      evidence.observedSteps !== undefined &&
      evidence.observedSteps < evidence.expectedSteps
    ) {
      // This is represented as a failed qualification check below, not a
      // schema error: a real partial stage is valid evidence of a failure.
    }
    if (
      evidence.expectedFrameCount !== undefined &&
      evidence.observedFrameCount !== undefined &&
      evidence.observedFrameCount < 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observedFrameCount"],
        message: "observedFrameCount cannot be negative",
      });
    }
    if (evidence.restart !== undefined && evidence.restart.endStep < evidence.restart.startStep) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["restart", "endStep"],
        message: "restart step range cannot move backward",
      });
    }
    if (evidence.telemetry !== undefined) {
      for (const [index, sample] of evidence.telemetry.entries()) {
        if (index > 0 && sample.step < evidence.telemetry[index - 1]!.step) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["telemetry", index, "step"],
            message: "telemetry steps must be monotonic",
          });
        }
      }
    }
  });
export type AmberStageEvidence = z.infer<typeof AmberStageEvidenceSchema>;

export const AmberQualificationCheckSchema = z
  .object({
    id: z.enum([
      "environment-binding",
      "engine-exit",
      "required-artifacts",
      "artifact-integrity",
      "fatal-signature",
      "progress",
      "trajectory-continuity",
      "restart-lineage",
      "parser",
      "telemetry-finiteness",
    ]),
    status: z.enum(["passed", "failed", "inconclusive"]),
    message: z.string().min(1).max(2048),
  })
  .strict();
export type AmberQualificationCheck = z.infer<typeof AmberQualificationCheckSchema>;

export const AmberQualificationResultSchema = z
  .object({
    schemaVersion: z.literal("amber-qualification-result/v1"),
    evidenceDigest: Sha256Schema,
    status: z.enum(["qualified", "failed", "inconclusive"]),
    checks: z.array(AmberQualificationCheckSchema).min(1),
    validationDigest: Sha256Schema,
    limitations: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type AmberQualificationResult = z.infer<typeof AmberQualificationResultSchema>;

function check(
  id: AmberQualificationCheck["id"],
  status: AmberQualificationCheck["status"],
  message: string,
): AmberQualificationCheck {
  return { id, status, message };
}

function hasRole(evidence: AmberStageEvidence, role: string): boolean {
  return evidence.artifacts.some((artifact) => artifact.role === role);
}

/** Run deterministic, evidence-only checks for one exact Amber stage. */
export function assessAmberStageEvidence(raw: unknown): AmberQualificationResult {
  const evidence = AmberStageEvidenceSchema.parse(raw);
  const checks: AmberQualificationCheck[] = [];
  checks.push(
    check(
      "environment-binding",
      evidence.environmentDigest.length === 64 && evidence.binarySha256.length === 64
        ? "passed"
        : "failed",
      "The stage carries exact environment and binary digests.",
    ),
  );
  checks.push(
    check(
      "engine-exit",
      evidence.exitCode === 0 && evidence.terminalReason === "completed" ? "passed" : "failed",
      evidence.exitCode === 0 && evidence.terminalReason === "completed"
        ? "Engine completed with exit code zero."
        : "Engine completion is not confirmed.",
    ),
  );
  const missingRoles = evidence.requiredArtifactRoles.filter((role) => !hasRole(evidence, role));
  checks.push(
    check(
      "required-artifacts",
      missingRoles.length === 0 ? "passed" : "failed",
      missingRoles.length === 0
        ? "All required artifact roles are present."
        : `Missing required artifact roles: ${missingRoles.join(", ")}`,
    ),
  );
  const unreadable = evidence.artifacts.filter(
    (artifact) => !artifact.readable || artifact.bytes <= 0,
  );
  checks.push(
    check(
      "artifact-integrity",
      unreadable.length === 0 ? "passed" : "failed",
      unreadable.length === 0
        ? "All declared artifacts are non-empty and readable."
        : "One or more declared artifacts are empty or unreadable.",
    ),
  );
  checks.push(
    check(
      "fatal-signature",
      evidence.fatalSignatures.length === 0 ? "passed" : "failed",
      evidence.fatalSignatures.length === 0
        ? "No fatal engine signature was observed."
        : `Fatal signatures observed: ${evidence.fatalSignatures.join("; ")}`,
    ),
  );
  const progressPassed =
    evidence.expectedSteps === undefined ||
    (evidence.observedSteps !== undefined && evidence.observedSteps >= evidence.expectedSteps);
  checks.push(
    check(
      "progress",
      progressPassed ? "passed" : "failed",
      progressPassed
        ? "Observed progress satisfies the supplied step bound."
        : "Observed steps did not reach the exact expected bound.",
    ),
  );
  const trajectoryPassed =
    evidence.expectedFrameCount === undefined ||
    (evidence.observedFrameCount !== undefined &&
      evidence.observedFrameCount >= evidence.expectedFrameCount);
  checks.push(
    check(
      "trajectory-continuity",
      trajectoryPassed ? "passed" : "failed",
      trajectoryPassed
        ? "Observed frame count satisfies the supplied trajectory bound."
        : "Trajectory frame count is incomplete.",
    ),
  );
  const restartPassed =
    evidence.restart === undefined
      ? evidence.stageKind === "input-preflight" || evidence.stageKind === "analysis"
        ? "inconclusive"
        : "failed"
      : evidence.restart.readable &&
          evidence.restart.outputDigest.length === 64 &&
          evidence.restart.endStep >= evidence.restart.startStep
        ? "passed"
        : "failed";
  checks.push(
    check(
      "restart-lineage",
      restartPassed,
      restartPassed === "passed"
        ? "Restart artifact is readable and step lineage is monotonic."
        : "Restart lineage is absent or invalid for this stage.",
    ),
  );
  const parserPassed =
    evidence.parser === undefined
      ? evidence.stageKind === "analysis"
        ? "failed"
        : "inconclusive"
      : evidence.parser.status === "complete"
        ? "passed"
        : evidence.parser.status === "not_run"
          ? "inconclusive"
          : "failed";
  checks.push(
    check(
      "parser",
      parserPassed,
      parserPassed === "passed"
        ? "The bound parser completed."
        : "Parser evidence is incomplete or invalid.",
    ),
  );
  const telemetry = evidence.telemetry;
  const telemetryPassed =
    telemetry === undefined
      ? "inconclusive"
      : telemetry.length > 0 &&
          telemetry.every((sample) =>
            Object.values(sample).every(
              (value) => typeof value !== "number" || Number.isFinite(value),
            ),
          )
        ? "passed"
        : "failed";
  checks.push(
    check(
      "telemetry-finiteness",
      telemetryPassed,
      telemetryPassed === "passed"
        ? "Telemetry contains finite monotonic samples."
        : "Telemetry is absent or contains non-finite values.",
    ),
  );
  const hasFailure = checks.some((item) => item.status === "failed");
  const hasIndeterminate = checks.some((item) => item.status === "inconclusive");
  const status: AmberQualificationResult["status"] = hasFailure
    ? "failed"
    : hasIndeterminate
      ? "inconclusive"
      : "qualified";
  const material = { evidenceDigest: digestCanonical(evidence), status, checks };
  return AmberQualificationResultSchema.parse({
    schemaVersion: "amber-qualification-result/v1",
    ...material,
    validationDigest: digestCanonical(material),
    limitations: [
      "This result qualifies only the supplied engine/version/environment/stage evidence.",
      "Scientific interpretation and publication claims require the designated reviewer and protocol decisions.",
    ],
  });
}

export function verifyAmberQualificationResult(raw: unknown): AmberQualificationResult {
  const result = AmberQualificationResultSchema.parse(raw);
  const expected = digestCanonical({
    evidenceDigest: result.evidenceDigest,
    status: result.status,
    checks: result.checks,
  });
  if (result.validationDigest !== expected)
    throw new Error("Amber qualification validation digest mismatch");
  return result;
}

/** Verify both the result envelope and the exact stage evidence it attests. */
export function verifyAmberQualificationResultForEvidence(
  rawResult: unknown,
  rawEvidence: unknown,
): AmberQualificationResult {
  const result = verifyAmberQualificationResult(rawResult);
  const evidence = AmberStageEvidenceSchema.parse(rawEvidence);
  const expectedEvidenceDigest = digestCanonical(evidence);
  if (result.evidenceDigest !== expectedEvidenceDigest) {
    throw new Error("Amber qualification result is bound to different stage evidence");
  }
  return result;
}
