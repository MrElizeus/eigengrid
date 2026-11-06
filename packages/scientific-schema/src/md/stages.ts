import { z } from "zod";
import { BiomolecularSystemManifestReferenceSchema } from "../biomolecular";
import { DigestSchema, IdSchema, SemverSchema } from "../schemas";
import { MdAcceptanceCriterionSchema, assertMdAcceptanceCriterionDigest } from "./acceptance";
import { MdArtifactReferenceSchema, MdStageKindSchema, MdStageSchemaVersion } from "./common";
import {
  BarostatSpecSchema,
  MdCheckpointSpecSchema,
  MdConstraintsSpecSchema,
  MdEnsembleSchema,
  MdNonbondedSpecSchema,
  MdOutputContractSchema,
  MdResourceProfileSchema,
  MdRestraintSpecSchema,
  RandomSeedPolicySchema,
  TemperatureScheduleSchema,
  ThermostatSpecSchema,
  computeMdRestraintSelectionDigest,
} from "./controls";
import { assertSelfDigest, canonicalSelfDigest } from "./digests";

/** Additive v2 field: historical stages remain readable but cannot acquire defaults. */
export const MdMinimizationControlsSchema = z
  .object({
    algorithm: z.literal("steepest_descent_then_conjugate_gradient"),
    steepestDescentCycles: z.number().finite().int().safe().nonnegative(),
    rmsGradientToleranceKcalMolAngstrom: z.number().finite().positive(),
    initialStepAngstrom: z.number().finite().positive(),
  })
  .strict();

export const MdStageSpecSchema = z
  .object({
    schemaVersion: z.literal(MdStageSchemaVersion),
    id: IdSchema,
    revision: z.number().finite().int().safe().positive(),
    sequence: z.number().finite().int().safe().positive(),
    kind: MdStageKindSchema,
    name: z.string().min(1),
    system: BiomolecularSystemManifestReferenceSchema,
    parentStageId: IdSchema.nullable(),
    requiredParentOutputRole: z.literal("restart").nullable(),
    inputs: z.array(MdArtifactReferenceSchema).min(1),
    ensemble: MdEnsembleSchema,
    steps: z.number().finite().int().safe().positive(),
    minimization: MdMinimizationControlsSchema.optional(),
    timeStepPs: z.number().finite().positive().nullable(),
    simulatedTimePs: z.number().finite().positive().nullable(),
    temperature: TemperatureScheduleSchema.nullable(),
    thermostat: ThermostatSpecSchema,
    barostat: BarostatSpecSchema,
    constraints: MdConstraintsSpecSchema,
    restraints: z.array(MdRestraintSpecSchema),
    nonbonded: MdNonbondedSpecSchema,
    randomSeed: RandomSeedPolicySchema.nullable(),
    resourceProfile: MdResourceProfileSchema,
    checkpoint: MdCheckpointSpecSchema,
    outputs: z.array(MdOutputContractSchema).min(1),
    acceptanceCriteria: z.array(MdAcceptanceCriterionSchema).min(1),
    sourceDecisionRefs: z.array(IdSchema),
    rendererCompatibilityVersion: SemverSchema,
    stageDigest: DigestSchema,
  })
  .strict()
  .superRefine((stage, context) => {
    if (stage.randomSeed?.policy === "replica_segment" && stage.kind !== "production") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["randomSeed"],
        message: "Replica-segment seed schedules are valid only for production",
      });
    }
    const criterionIds = stage.acceptanceCriteria.map((criterion) => criterion.id);
    if (new Set(criterionIds).size !== criterionIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["acceptanceCriteria"],
        message: "Stage acceptance criterion identifiers must be unique",
      });
    }
    const inputRoles = stage.inputs.map((input) => input.role);
    if (new Set(inputRoles).size !== inputRoles.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inputs"],
        message: "A stage may bind each input artifact role only once",
      });
    }
    const topology = stage.inputs.find((input) => input.role === "topology");
    if (!topology || topology.contentDigest !== stage.system.topologyDigest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inputs"],
        message: "Stage topology input must match the system-manifest topology digest",
      });
    }
    if (stage.inputs.some((input) => input.role === "parent_restart")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inputs"],
        message:
          "Protocol stages declare parent restart requirements; exact restart artifacts belong only to execution bindings",
      });
    }
    if (stage.sequence === 1) {
      if (stage.parentStageId !== null || stage.requiredParentOutputRole !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requiredParentOutputRole"],
          message: "The first MD stage cannot name a parent stage or required parent output",
        });
      }
      const coordinates = stage.inputs.find((input) => input.role === "coordinates");
      if (!coordinates || coordinates.contentDigest !== stage.system.coordinateDigest) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["inputs"],
          message: "The first stage coordinates must match the system-manifest digest",
        });
      }
    } else {
      if (stage.parentStageId === null || stage.requiredParentOutputRole !== "restart") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requiredParentOutputRole"],
          message: "Every stage after the first must require the parent stage restart output",
        });
      }
      if (stage.inputs.some((input) => input.role === "coordinates")) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["inputs"],
          message: "Downstream protocol stages cannot predeclare a future state artifact",
        });
      }
    }
    if (stage.kind === "minimization") {
      if (
        stage.minimization !== undefined &&
        stage.minimization.steepestDescentCycles > stage.steps
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["minimization", "steepestDescentCycles"],
          message: "Steepest-descent cycles cannot exceed the approved minimization length",
        });
      }
      if (
        stage.ensemble !== "none" ||
        stage.timeStepPs !== null ||
        stage.simulatedTimePs !== null ||
        stage.temperature !== null ||
        stage.thermostat.kind !== "none" ||
        stage.barostat.kind !== "none" ||
        stage.randomSeed !== null
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ensemble"],
          message: "Minimization must not declare dynamics controls or simulated time",
        });
      }
    } else {
      if (stage.minimization !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["minimization"],
          message: "Dynamics stages cannot declare minimization controls",
        });
      }
      if (
        stage.ensemble === "none" ||
        stage.timeStepPs === null ||
        stage.simulatedTimePs === null
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["timeStepPs"],
          message: "Dynamics stages require an ensemble, timestep, and simulated time",
        });
      } else {
        const expectedTime = stage.steps * stage.timeStepPs;
        const tolerance = Math.max(1e-9, expectedTime * 1e-9);
        if (
          !Number.isFinite(expectedTime) ||
          Math.abs(expectedTime - stage.simulatedTimePs) > tolerance
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["simulatedTimePs"],
            message: "Simulated time must equal steps multiplied by timestep",
          });
        }
      }
      if (stage.temperature === null || stage.randomSeed === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["temperature"],
          message: "Dynamics stages require explicit temperature and seed policies",
        });
      }
      if (stage.ensemble === "nve" && stage.thermostat.kind !== "none") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["thermostat"],
          message: "NVE must not use a thermostat",
        });
      }
      if (["nvt", "npt"].includes(stage.ensemble) && stage.thermostat.kind === "none") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["thermostat"],
          message: "NVT and NPT require an explicit thermostat",
        });
      }
      if (stage.kind === "heating" && (stage.temperature?.points.length ?? 0) < 2) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["temperature"],
          message: "Heating requires a temperature schedule with at least two points",
        });
      }
      const temperaturePoints = stage.temperature?.points ?? [];
      if (temperaturePoints[0]?.step !== 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["temperature", "points", 0, "step"],
          message: "A temperature schedule must begin at stage step zero",
        });
      }
      if ((temperaturePoints.at(-1)?.step ?? 0) > stage.steps) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["temperature", "points"],
          message: "A temperature schedule cannot extend beyond the stage",
        });
      }
      if (stage.kind === "heating" && temperaturePoints.at(-1)?.step !== stage.steps) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["temperature", "points"],
          message: "A heating schedule must define its target at the final stage step",
        });
      }
    }
    if (stage.ensemble === "npt") {
      if (stage.barostat.kind === "none") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["barostat"],
          message: "NPT requires an explicit barostat and pressure target",
        });
      } else if (
        stage.system.systemClass === "membrane" &&
        stage.barostat.coupling === "isotropic"
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["barostat", "coupling"],
          message: "Membrane NPT stages cannot use isotropic pressure coupling",
        });
      }
    } else if (stage.barostat.kind !== "none") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["barostat"],
        message: "Pressure coupling is valid only for NPT",
      });
    }
    for (const [restraintIndex, restraint] of stage.restraints.entries()) {
      for (const [selectionIndex, selection] of restraint.selections.entries()) {
        if (
          selection.atomIndices !== undefined &&
          selection.definitionDigest !==
            computeMdRestraintSelectionDigest(stage.system.atomMapDigest, selection.atomIndices)
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["restraints", restraintIndex, "selections", selectionIndex, "definitionDigest"],
            message:
              "Explicit restraint selection digest must bind its exact indices and canonical atom map",
          });
        }
      }
      const lastStep = restraint.schedule.at(-1)?.step ?? 0;
      if (lastStep > stage.steps) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["restraints", restraintIndex, "schedule"],
          message: "Restraint schedules cannot extend beyond the stage",
        });
      }
    }
    const outputRoles = stage.outputs.map((output) => output.role);
    if (new Set(outputRoles).size !== outputRoles.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputs"],
        message: "A stage may define each output role only once",
      });
    }
    for (const requiredRole of ["restart", "mdout", "mdinfo"] as const) {
      if (!stage.outputs.some((output) => output.role === requiredRole && output.required)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outputs"],
          message: `Stage output contract must require ${requiredRole}`,
        });
      }
    }
    if (
      stage.kind === "production" &&
      !stage.outputs.some((output) => output.role === "trajectory" && output.required)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputs"],
        message: "Production must require a trajectory artifact",
      });
    }
    for (const output of stage.outputs) {
      if (output.cadenceSteps !== undefined && output.cadenceSteps > stage.steps) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outputs"],
          message: "Output cadence cannot exceed the stage length",
        });
      }
    }
    if (stage.checkpoint.cadenceSteps > stage.steps) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["checkpoint", "cadenceSteps"],
        message: "Checkpoint cadence cannot exceed the stage length",
      });
    }
  });

export type MdStageSpec = z.infer<typeof MdStageSpecSchema>;

/** Digests every normalized stage field except `stageDigest` itself. */
export function computeMdStageSpecDigest(value: object): string {
  return canonicalSelfDigest(value, "stageDigest");
}

export const computeMdStageDigest = computeMdStageSpecDigest;

/** Validates both the stage schema and its canonical self-digest. */
export function assertMdStageSpecDigest(value: unknown): MdStageSpec {
  const stage = MdStageSpecSchema.parse(value);
  for (const criterion of stage.acceptanceCriteria) assertMdAcceptanceCriterionDigest(criterion);
  return assertSelfDigest("MdStageSpec", stage, stage.stageDigest, "stageDigest");
}

export const assertMdStageDigest = assertMdStageSpecDigest;
