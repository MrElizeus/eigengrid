import { z } from "zod";
import { ScientificSchemaDigestMismatchError } from "./biomolecular";
import { digestCanonical } from "./canonical";
import { DigestSchema, IdSchema } from "./schemas";

/**
 * Review material for the bounded M2 ACE–ALA–NME pilot. This is deliberately
 * not an MdWorkflowProtocol: it holds no CAS material, approval, mission,
 * WorkUnit, environment binding, or executable engine request.
 */
export const AmberPilotCandidateSchemaVersion = "eigengrid.amber-pilot-candidate/v1" as const;

const boundedText = z.string().trim().min(1).max(2_000);
const candidateDecisionState = z.enum([
  "pending_scientific_review",
  "pending_calibration",
  "pending_preparation",
]);

export const AmberPilotCandidateDecisionSchema = z
  .object({
    id: IdSchema,
    subject: boundedText,
    source: z.enum(["roadmap_candidate", "engineering_proposal"]),
    state: candidateDecisionState,
    blocksExecution: z.literal(true),
    rationale: boundedText,
  })
  .strict();
export type AmberPilotCandidateDecision = z.infer<typeof AmberPilotCandidateDecisionSchema>;

export const AmberPilotCandidateBlockingRequirementSchema = z
  .object({
    id: IdSchema,
    description: boundedText,
    blocksExecution: z.literal(true),
  })
  .strict();
export type AmberPilotCandidateBlockingRequirement = z.infer<
  typeof AmberPilotCandidateBlockingRequirementSchema
>;

const AmberPilotCandidateStageSchema = z
  .object({
    id: z.enum([
      "min-01",
      "min-02",
      "heating",
      "equilibration-01",
      "equilibration-02",
      "production-01",
      "production-02",
    ]),
    sequence: z.number().int().positive(),
    kind: z.enum(["minimization", "heating", "equilibration", "production"]),
    ensemble: z.enum(["none", "nvt", "npt"]),
    stepCount: z.number().int().positive(),
    durationPs: z.number().positive().nullable(),
    timeStepFs: z.number().finite().positive().max(4).nullable(),
    temperature: z
      .object({
        initialKelvin: z.number().positive().nullable(),
        targetKelvin: z.number().positive().nullable(),
      })
      .strict(),
    pressureBar: z.number().positive().nullable(),
    restraints: z
      .object({
        selection: z.enum(["none", "heavy_solute"]),
        forceConstantKcalMolAngstrom2: z.number().nonnegative(),
      })
      .strict(),
    shake: z
      .object({
        enabled: z.boolean(),
        tolerance: z.number().positive().nullable(),
        maximumIterations: z.number().int().positive().nullable(),
      })
      .strict(),
    thermostat: z
      .object({
        kind: z.enum(["none", "langevin"]),
        collisionFrequencyPerPs: z.number().positive().nullable(),
      })
      .strict(),
    barostat: z
      .object({
        kind: z.enum(["none", "monte_carlo_isotropic"]),
        relaxationTimePs: z.number().positive().nullable(),
      })
      .strict(),
    minimization: z
      .object({
        maximumCycles: z.number().int().positive().nullable(),
        steepestDescentCycles: z.number().int().nonnegative().nullable(),
        convergenceCriterion: boundedText.nullable(),
      })
      .strict(),
    parentCheckpoint: z.enum(["none", "required"]),
    checkpointOutput: z.literal("required"),
    unresolvedDecisionIds: z.array(IdSchema).min(1).max(32),
  })
  .strict();
export type AmberPilotCandidateStage = z.infer<typeof AmberPilotCandidateStageSchema>;

const expectedStages = [
  ["min-01", "minimization"],
  ["min-02", "minimization"],
  ["heating", "heating"],
  ["equilibration-01", "equilibration"],
  ["equilibration-02", "equilibration"],
  ["production-01", "production"],
  ["production-02", "production"],
] as const;

/**
 * Candidate-only scientific proposal. Its literal blocked eligibility is a
 * hard guard against accidentally passing review material to the MD compiler.
 */
export const AmberPilotCandidateSchema = z
  .object({
    schemaVersion: z.literal(AmberPilotCandidateSchemaVersion),
    id: IdSchema,
    revision: z.number().int().positive(),
    status: z.literal("candidate"),
    scope: z.literal("m2_technical_pilot"),
    executionEligibility: z.literal("blocked_pending_am02_and_scientific_review"),
    system: z
      .object({
        solute: z
          .object({
            identity: z.literal("ACE-ALA-NME"),
            stereochemistry: z.literal("L"),
            terminalCaps: z.tuple([z.literal("ACE"), z.literal("NME")]),
          })
          .strict(),
        forceFields: z.object({ protein: z.literal("ff14SB"), water: z.literal("TIP3P") }).strict(),
        solvation: z
          .object({
            boxShape: z.literal("orthorhombic"),
            paddingAngstrom: z.number().positive(),
            netCharge: z.literal(0),
            addedSalt: z.literal(false),
            // The reviewed M2 envelope is deliberately bounded. A larger
            // candidate must be a new reviewed protocol, not a quiet resource
            // expansion of this small technical pilot.
            maximumAtomCount: z.number().int().positive().max(5_000),
          })
          .strict(),
        nonbonded: z
          .object({ cutoffAngstrom: z.number().positive(), electrostatics: z.literal("PME") })
          .strict(),
      })
      .strict(),
    outputCadence: z
      .object({
        energyEverySteps: z.number().int().positive(),
        trajectoryEverySteps: z.number().int().positive(),
        checkpointEverySteps: z.number().int().positive(),
      })
      .strict(),
    resources: z
      .object({
        executionClass: z.literal("cpu_serial_only"),
        gpuCount: z.literal(0),
        mpiEnabled: z.literal(false),
        calibrationState: z.literal("pending_calibration"),
      })
      .strict(),
    stages: z.array(AmberPilotCandidateStageSchema).length(expectedStages.length),
    decisions: z.array(AmberPilotCandidateDecisionSchema).min(1).max(64),
    blockingRequirements: z.array(AmberPilotCandidateBlockingRequirementSchema).min(1).max(64),
    candidateDigest: DigestSchema,
  })
  .strict()
  .superRefine((candidate, context) => {
    const decisionIds = new Set(candidate.decisions.map((decision) => decision.id));
    if (decisionIds.size !== candidate.decisions.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decisions"],
        message: "Candidate decision identifiers must be unique",
      });
    }
    const blockerIds = candidate.blockingRequirements.map((requirement) => requirement.id);
    if (new Set(blockerIds).size !== blockerIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blockingRequirements"],
        message: "Candidate blocking requirement identifiers must be unique",
      });
    }
    for (const [index, stage] of candidate.stages.entries()) {
      const [expectedId, expectedKind] = expectedStages[index]!;
      if (stage.id !== expectedId || stage.kind !== expectedKind || stage.sequence !== index + 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stages", index],
          message: "Candidate stages must preserve the bounded M2 sequence",
        });
      }
      if (
        stage.unresolvedDecisionIds.some((decisionId) => !decisionIds.has(decisionId)) ||
        new Set(stage.unresolvedDecisionIds).size !== stage.unresolvedDecisionIds.length
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stages", index, "unresolvedDecisionIds"],
          message: "Candidate stage unresolved decisions must be unique declared blockers",
        });
      }
      if (index === 0 ? stage.parentCheckpoint !== "none" : stage.parentCheckpoint !== "required") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stages", index, "parentCheckpoint"],
          message: "Candidate stages must preserve their checkpoint lineage",
        });
      }
      const dynamicStage = stage.kind !== "minimization";
      const expectedEnsemble =
        stage.kind === "minimization" ? "none" : stage.kind === "heating" ? "nvt" : "npt";
      if (stage.ensemble !== expectedEnsemble) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stages", index, "ensemble"],
          message: `Candidate ${stage.kind} stage must use the bounded ${expectedEnsemble.toUpperCase()} ensemble`,
        });
      }
      if (stage.kind === "minimization") {
        if (
          stage.ensemble !== "none" ||
          stage.durationPs !== null ||
          stage.timeStepFs !== null ||
          stage.temperature.initialKelvin !== null ||
          stage.temperature.targetKelvin !== null ||
          stage.pressureBar !== null ||
          stage.thermostat.kind !== "none" ||
          stage.thermostat.collisionFrequencyPerPs !== null ||
          stage.barostat.kind !== "none" ||
          stage.barostat.relaxationTimePs !== null ||
          stage.shake.enabled ||
          stage.shake.tolerance !== null ||
          stage.shake.maximumIterations !== null ||
          stage.minimization.maximumCycles === null ||
          stage.minimization.steepestDescentCycles === null ||
          stage.minimization.steepestDescentCycles > stage.minimization.maximumCycles ||
          stage.stepCount !== stage.minimization.maximumCycles
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["stages", index],
            message: "Candidate minimization controls are internally inconsistent",
          });
        }
      }
      if (dynamicStage) {
        const expectedSteps =
          stage.durationPs === null || stage.timeStepFs === null
            ? null
            : (stage.durationPs * 1_000) / stage.timeStepFs;
        if (
          stage.durationPs === null ||
          stage.timeStepFs === null ||
          stage.timeStepFs > (stage.shake.enabled ? 2 : 1) ||
          !Number.isSafeInteger(expectedSteps) ||
          stage.stepCount !== expectedSteps ||
          stage.minimization.maximumCycles !== null ||
          stage.minimization.steepestDescentCycles !== null ||
          stage.minimization.convergenceCriterion !== null ||
          stage.temperature.initialKelvin === null ||
          stage.temperature.targetKelvin === null ||
          stage.thermostat.kind !== "langevin" ||
          stage.thermostat.collisionFrequencyPerPs === null
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["stages", index],
            message:
              "Candidate dynamic-stage duration, temperature, thermostat, or minimization controls are inconsistent",
          });
        }
      }
      if (stage.shake.enabled) {
        if (stage.shake.maximumIterations === null) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["stages", index, "shake"],
            message: "Enabled candidate SHAKE requires an explicit maximum-iteration control",
          });
        }
      } else if (stage.shake.tolerance !== null || stage.shake.maximumIterations !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stages", index, "shake"],
          message: "Disabled candidate SHAKE cannot carry active controls",
        });
      }
      if (stage.ensemble === "none") {
        if (stage.pressureBar !== null || stage.barostat.kind !== "none") {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["stages", index, "ensemble"],
            message: "A non-dynamic candidate stage cannot carry pressure or a barostat",
          });
        }
      } else if (stage.ensemble === "nvt") {
        if (stage.pressureBar !== null || stage.barostat.kind !== "none") {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["stages", index, "ensemble"],
            message: "An NVT candidate stage cannot carry pressure or a barostat",
          });
        }
      } else if (stage.pressureBar === null || stage.barostat.kind !== "monte_carlo_isotropic") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stages", index, "ensemble"],
          message: "An NPT candidate stage requires pressure and the declared Monte Carlo barostat",
        });
      }
    }
  });
export type AmberPilotCandidate = z.infer<typeof AmberPilotCandidateSchema>;

function withoutCandidateDigest(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([field]) => field !== "candidateDigest"));
}

export function computeAmberPilotCandidateDigest(value: object): string {
  return digestCanonical(withoutCandidateDigest(value));
}

/** Parse the proposal and prove its self-digest. This does not approve or compile it. */
export function assertAmberPilotCandidateDigest(value: unknown): AmberPilotCandidate {
  const candidate = AmberPilotCandidateSchema.parse(value);
  const observedDigest = computeAmberPilotCandidateDigest(candidate);
  if (candidate.candidateDigest !== observedDigest) {
    throw new ScientificSchemaDigestMismatchError(
      "AmberPilotCandidate",
      candidate.id,
      candidate.candidateDigest,
      observedDigest,
    );
  }
  return candidate;
}
