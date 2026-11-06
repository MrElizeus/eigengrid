import { z } from "zod";
import { digestCanonical } from "../canonical";
import { DigestSchema, IdSchema } from "../schemas";
import { MdArtifactRoleSchema } from "./common";

export const MdEnsembleSchema = z.enum(["none", "nve", "nvt", "npt"]);

export type MdEnsemble = z.infer<typeof MdEnsembleSchema>;

export const RandomSeedPolicySchema = z.discriminatedUnion("policy", [
  z
    .object({
      policy: z.literal("replica_segment"),
      segmentCount: z.number().finite().int().safe().positive().max(1024),
    })
    .strict(),
  z
    .object({
      policy: z.literal("fixed"),
      seed: z.number().finite().int().safe().min(1).max(2_147_483_646),
    })
    .strict(),
  z
    .object({
      policy: z.literal("derived"),
      baseSeed: z.number().finite().int().safe().min(1).max(2_147_483_646),
      replicaIndex: z.number().finite().int().safe().positive(),
      derivation: z.string().min(1),
      derivationDigest: DigestSchema,
      derivedSeed: z.number().finite().int().safe().min(1).max(2_147_483_646),
    })
    .strict(),
]);

export type RandomSeedPolicy = z.infer<typeof RandomSeedPolicySchema>;

export const TemperatureSchedulePointSchema = z
  .object({
    step: z.number().finite().int().safe().nonnegative(),
    kelvin: z.number().finite().nonnegative(),
  })
  .strict();

export const TemperatureScheduleSchema = z
  .object({
    points: z.array(TemperatureSchedulePointSchema).min(1),
  })
  .strict()
  .superRefine((schedule, context) => {
    for (let index = 1; index < schedule.points.length; index += 1) {
      if (schedule.points[index]!.step <= schedule.points[index - 1]!.step) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["points", index, "step"],
          message: "Temperature schedule steps must be strictly increasing",
        });
      }
    }
  });

export type TemperatureSchedule = z.infer<typeof TemperatureScheduleSchema>;

export const ThermostatSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("langevin"),
      collisionFrequencyPerPs: z.number().finite().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("berendsen"),
      couplingTimePs: z.number().finite().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("nose_hoover"),
      couplingTimePs: z.number().finite().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("velocity_rescale"),
      couplingTimePs: z.number().finite().positive(),
    })
    .strict(),
]);

export type ThermostatSpec = z.infer<typeof ThermostatSpecSchema>;

export const BarostatSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.enum(["berendsen", "monte_carlo", "parrinello_rahman", "c_rescale"]),
      coupling: z.enum(["isotropic", "semiisotropic", "anisotropic"]),
      targetPressureBar: z.number().finite().positive(),
      relaxationTimePs: z.number().finite().positive(),
      compressibilityPerBar: z.number().finite().positive().optional(),
    })
    .strict(),
]);

export type BarostatSpec = z.infer<typeof BarostatSpecSchema>;

const CanonicalAtomIndicesSchema = z
  .array(z.number().finite().int().safe().positive())
  .min(1)
  .max(1_000_000);

/** Digest of an exact ordered selection in one immutable canonical atom map. */
export function computeMdRestraintSelectionDigest(
  atomMapDigest: string,
  atomIndices: number[],
): string {
  return digestCanonical({
    schemaVersion: "eigengrid.md-atom-selection/v1",
    atomMapDigest: DigestSchema.parse(atomMapDigest),
    indexBase: 1,
    atomIndices: CanonicalAtomIndicesSchema.parse(atomIndices),
  });
}

export const RestraintSelectionSchema = z
  .object({
    id: IdSchema,
    definitionDigest: DigestSchema,
    atomCount: z.number().finite().int().safe().positive(),
    description: z.string().min(1),
    atomIndices: CanonicalAtomIndicesSchema.optional(),
  })
  .strict()
  .superRefine((selection, context) => {
    if (selection.atomIndices === undefined) return; // Historical metadata remains readable.
    if (
      selection.atomIndices.length !== selection.atomCount ||
      selection.atomIndices.some((atom, index, atoms) => index > 0 && atom <= atoms[index - 1]!)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["atomIndices"],
        message: "Explicit atom selections must match atomCount and be unique and strictly ordered",
      });
    }
  });

export type RestraintSelection = z.infer<typeof RestraintSelectionSchema>;

export const RestraintSchedulePointSchema = z
  .object({
    step: z.number().finite().int().safe().nonnegative(),
    forceConstant: z.number().finite().nonnegative(),
  })
  .strict();

export const MdRestraintSpecSchema = z
  .object({
    id: IdSchema,
    kind: z.enum(["positional", "distance", "angle", "dihedral"]),
    selections: z.array(RestraintSelectionSchema).min(1).max(4),
    targetValue: z.number().finite().optional(),
    targetUnit: z.string().min(1).optional(),
    schedule: z.array(RestraintSchedulePointSchema).min(1),
    sourceDecisionId: IdSchema,
  })
  .strict()
  .superRefine((restraint, context) => {
    const expectedSelections = {
      positional: 1,
      distance: 2,
      angle: 3,
      dihedral: 4,
    }[restraint.kind];
    if (restraint.selections.length !== expectedSelections) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selections"],
        message: `${restraint.kind} restraints require ${expectedSelections} selection(s)`,
      });
    }
    if (
      restraint.kind !== "positional" &&
      (restraint.targetValue === undefined || restraint.targetUnit === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetValue"],
        message: "Geometric restraints require an explicit target value and unit",
      });
    }
    if (
      restraint.kind === "positional" &&
      (restraint.targetValue !== undefined || restraint.targetUnit !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetValue"],
        message: "A positional restraint is anchored by its selection reference",
      });
    }
    for (let index = 1; index < restraint.schedule.length; index += 1) {
      if (restraint.schedule[index]!.step <= restraint.schedule[index - 1]!.step) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["schedule", index, "step"],
          message: "Restraint schedule steps must be strictly increasing",
        });
      }
    }
    if (!restraint.schedule.some((point) => point.forceConstant > 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["schedule"],
        message: "A restraint schedule must apply a positive force at some point",
      });
    }
  });

export type MdRestraintSpec = z.infer<typeof MdRestraintSpecSchema>;

export const MdConstraintsSpecSchema = z
  .object({
    bondsToHydrogen: z.boolean(),
    tolerance: z.number().finite().positive().optional(),
    maximumIterations: z.number().finite().int().safe().positive().optional(),
  })
  .strict()
  .superRefine((constraints, context) => {
    if (
      constraints.bondsToHydrogen &&
      (constraints.tolerance === undefined || constraints.maximumIterations === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tolerance"],
        message: "Constrained bonds require explicit tolerance and iteration limits",
      });
    }
    if (
      !constraints.bondsToHydrogen &&
      (constraints.tolerance !== undefined || constraints.maximumIterations !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tolerance"],
        message: "Constraint controls are invalid when bond constraints are disabled",
      });
    }
  });

export type MdConstraintsSpec = z.infer<typeof MdConstraintsSpecSchema>;

export const MdNonbondedSpecSchema = z
  .object({
    cutoffAngstrom: z.number().finite().positive(),
    electrostatics: z.enum(["pme", "reaction_field", "direct"]),
    ewaldTolerance: z.number().finite().positive().lt(1).optional(),
    periodicBoundary: z.literal(true),
  })
  .strict()
  .superRefine((nonbonded, context) => {
    if (nonbonded.electrostatics === "pme" && nonbonded.ewaldTolerance === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ewaldTolerance"],
        message: "PME requires an explicit Ewald tolerance",
      });
    }
    if (nonbonded.electrostatics !== "pme" && nonbonded.ewaldTolerance !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ewaldTolerance"],
        message: "Ewald tolerance applies only to PME",
      });
    }
  });

export type MdNonbondedSpec = z.infer<typeof MdNonbondedSpecSchema>;

export const MdResourceProfileSchema = z
  .object({
    backendCapabilityId: z.string().min(1),
    cpuCores: z.number().finite().int().safe().positive(),
    gpuCount: z.number().finite().int().safe().nonnegative(),
    memoryBytes: z.number().finite().int().safe().positive(),
    scratchBytes: z.number().finite().int().safe().nonnegative(),
    wallTimeSeconds: z.number().finite().int().safe().positive(),
  })
  .strict();

export type MdResourceProfile = z.infer<typeof MdResourceProfileSchema>;

export const MdCheckpointSpecSchema = z
  .object({
    cadenceSteps: z.number().finite().int().safe().positive(),
    retainCount: z.number().finite().int().safe().positive(),
    stopAfterCheckpointSupported: z.boolean(),
  })
  .strict();

export type MdCheckpointSpec = z.infer<typeof MdCheckpointSpecSchema>;

export const MdOutputContractSchema = z
  .object({
    role: MdArtifactRoleSchema,
    required: z.boolean(),
    mediaType: z.string().min(1),
    cadenceSteps: z.number().finite().int().safe().positive().optional(),
  })
  .strict();

export type MdOutputContract = z.infer<typeof MdOutputContractSchema>;
