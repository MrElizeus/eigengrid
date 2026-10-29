import { z } from "zod";
import { sha256Bytes } from "./canonical";
import { LogicalPathSchema, type LogicalPath } from "./contracts";
import { SANDER26_CPU_PROFILE } from "./sander26-profile";

export const MdStageKindSchema = z.enum(["minimization", "heating", "equilibration", "production"]);
export type MdStageKind = z.infer<typeof MdStageKindSchema>;
export const RestartFormatSchema = z.enum(["formatted", "netcdf"]);
export type RestartFormat = z.infer<typeof RestartFormatSchema>;

const finitePositive = z.number().finite().positive();
const finiteNonnegative = z.number().finite().nonnegative();
const positiveInteger = z.number().int().positive().max(2_147_483_647);
const seedSchema = z.number().int().positive().max(2_147_483_647);
const titleSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9 ._-]+$/);
const amberMaskSchema = z
  .string()
  .min(1)
  .max(SANDER26_CPU_PROFILE.maximumRestraintMaskCharacters)
  .regex(/^[A-Za-z0-9_:,@*?+!()&|=.-]+$/, "unsupported or unsafe AMBER mask syntax");

const RestraintSchema = z
  .object({
    weightKcalMolA2: finiteNonnegative,
    mask: amberMaskSchema,
  })
  .strict();

const OutputCadenceSchema = z
  .object({
    energiesEvery: positiveInteger,
    trajectoryEvery: positiveInteger,
    restartEvery: positiveInteger,
  })
  .strict();

const ExplicitNonbondedMappingSchema = z
  .object({
    electrostatics: z.literal("pme"),
    ewaldTolerance: z.number().finite().positive().lt(1),
  })
  .strict();

const ExplicitConstraintMappingSchema = z
  .object({
    bondsToHydrogen: z.boolean(),
    tolerance: z.number().finite().positive().lt(1).optional(),
  })
  .strict()
  .refine((value) => value.bondsToHydrogen || value.tolerance === undefined, {
    message: "SHAKE tolerance cannot be declared when constraints are disabled",
  });

function validateCadence(
  output: z.infer<typeof OutputCadenceSchema>,
  availableSteps: number,
  context: z.RefinementCtx,
): void {
  for (const field of ["energiesEvery", "trajectoryEvery", "restartEvery"] as const) {
    if (output[field] > availableSteps) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["output", field],
        message: `${field} cannot exceed the stage length`,
      });
    }
  }
}

export const MinimizationStageSchema = z
  .object({
    kind: z.literal("minimization"),
    title: titleSchema,
    maxCycles: positiveInteger,
    steepestDescentCycles: z.number().int().nonnegative(),
    rmsGradientToleranceKcalMolAngstrom: finitePositive,
    initialStepAngstrom: finitePositive,
    cutoffAngstrom: finitePositive,
    restartFormat: RestartFormatSchema,
    output: OutputCadenceSchema.extend({ trajectoryEvery: z.literal(0) }),
    nonbonded: ExplicitNonbondedMappingSchema.optional(),
    constraints: ExplicitConstraintMappingSchema.optional(),
    restraints: RestraintSchema.optional(),
  })
  .strict()
  .refine((value) => value.steepestDescentCycles <= value.maxCycles, {
    path: ["steepestDescentCycles"],
    message: "steepest-descent cycles cannot exceed total minimization cycles",
  })
  .superRefine((value, context) => {
    validateCadence(value.output, value.maxCycles, context);
    if (value.output.restartEvery !== value.maxCycles) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["output", "restartEvery"],
        message: "Minimization writes a final restart, not periodic dynamics checkpoints",
      });
    }
    if (value.constraints?.bondsToHydrogen === true) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["constraints"],
        message: "This minimization profile requires unconstrained bonds",
      });
    }
  });
export type MinimizationStage = z.infer<typeof MinimizationStageSchema>;

export const HeatingStageSchema = z
  .object({
    kind: z.literal("heating"),
    title: titleSchema,
    steps: positiveInteger,
    timestepPs: finitePositive.max(0.004),
    initialTemperatureK: finiteNonnegative.max(1000),
    targetTemperatureK: finitePositive.max(1000),
    thermostatCollisionPs: finitePositive,
    randomSeed: seedSchema,
    cutoffAngstrom: finitePositive,
    restartFormat: RestartFormatSchema,
    output: OutputCadenceSchema,
    nonbonded: ExplicitNonbondedMappingSchema.optional(),
    constraints: ExplicitConstraintMappingSchema.optional(),
    restraints: RestraintSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => validateCadence(value.output, value.steps, context));
export type HeatingStage = z.infer<typeof HeatingStageSchema>;

const DynamicsFields = {
  title: titleSchema,
  ensemble: z.enum(["nvt", "npt"]),
  systemKind: z.enum(["soluble", "membrane"]),
  steps: positiveInteger,
  timestepPs: finitePositive.max(0.004),
  temperatureK: finitePositive.max(1000),
  thermostatCollisionPs: finitePositive,
  randomSeed: seedSchema,
  cutoffAngstrom: finitePositive,
  restartFormat: RestartFormatSchema,
  output: OutputCadenceSchema,
  nonbonded: ExplicitNonbondedMappingSchema.optional(),
  constraints: ExplicitConstraintMappingSchema.optional(),
  pressureBar: finitePositive.optional(),
  pressureRelaxationPs: finitePositive.optional(),
  pressureCoupling: z.enum(["isotropic", "semiisotropic"]).optional(),
  barostatAlgorithm: z.enum(["berendsen", "monte_carlo"]).optional(),
  surfaceOrientation: z.literal("xy").optional(),
  membranePressurePolicyReviewed: z.literal(true).optional(),
  surfaceTensionDynCm: z.number().finite().optional(),
  interfaces: z.literal(2).optional(),
  restraints: RestraintSchema.optional(),
};

function validateDynamicsPressure(
  value: z.infer<z.ZodObject<typeof DynamicsFields>>,
  context: z.RefinementCtx,
): void {
  validateCadence(value.output, value.steps, context);
  if (value.ensemble === "npt") {
    for (const field of [
      "pressureBar",
      "pressureRelaxationPs",
      "pressureCoupling",
      "barostatAlgorithm",
    ] as const) {
      if (value[field] === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is required for NPT`,
        });
      }
    }
    if (value.systemKind === "membrane") {
      if (value.pressureCoupling !== "semiisotropic") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pressureCoupling"],
          message: "membrane NPT stages require explicit semi-isotropic coupling",
        });
      }
      for (const field of [
        "membranePressurePolicyReviewed",
        "surfaceTensionDynCm",
        "interfaces",
        "surfaceOrientation",
      ] as const) {
        if (value[field] === undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} is required for membrane NPT`,
          });
        }
      }
      if (value.barostatAlgorithm !== "berendsen") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["barostatAlgorithm"],
          message: "membrane NPT requires the explicitly mapped Berendsen barostat",
        });
      }
      if (value.surfaceOrientation !== "xy") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["surfaceOrientation"],
          message: "Amber 26 membrane mapping requires an xy interface plane",
        });
      }
    } else if (value.pressureCoupling === "semiisotropic") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pressureCoupling"],
        message: "semi-isotropic coupling is reserved for reviewed membrane protocols",
      });
    } else if (value.barostatAlgorithm !== "monte_carlo") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["barostatAlgorithm"],
        message: "soluble NPT requires the explicitly mapped Monte Carlo barostat",
      });
    }
  } else {
    for (const field of [
      "pressureBar",
      "pressureRelaxationPs",
      "pressureCoupling",
      "barostatAlgorithm",
      "surfaceOrientation",
      "membranePressurePolicyReviewed",
      "surfaceTensionDynCm",
      "interfaces",
    ] as const) {
      if (value[field] !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} must be absent for NVT`,
        });
      }
    }
  }
}

export const EquilibrationStageSchema = z
  .object({ kind: z.literal("equilibration"), ...DynamicsFields })
  .strict()
  .superRefine(validateDynamicsPressure);
export type EquilibrationStage = z.infer<typeof EquilibrationStageSchema>;

export const ProductionStageSchema = z
  .object({ kind: z.literal("production"), ...DynamicsFields })
  .strict()
  .superRefine(validateDynamicsPressure);
export type ProductionStage = z.infer<typeof ProductionStageSchema>;

/** NVE is a continuation: temperature/seed metadata must not become thermostat controls. */
export const NveStageSchema = z
  .object({
    kind: z.enum(["equilibration", "production"]),
    ensemble: z.literal("nve"),
    title: titleSchema,
    systemKind: z.enum(["soluble", "membrane"]),
    steps: positiveInteger,
    timestepPs: finitePositive.max(0.002),
    cutoffAngstrom: finitePositive,
    restartFormat: RestartFormatSchema,
    output: OutputCadenceSchema,
    nonbonded: ExplicitNonbondedMappingSchema,
    constraints: ExplicitConstraintMappingSchema,
    restraints: RestraintSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    validateCadence(value.output, value.steps, context);
    if (value.timestepPs > (value.constraints.bondsToHydrogen ? 0.002 : 0.001)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timestepPs"],
        message: "NVE timestep exceeds the no-HMR constraint profile",
      });
    }
  });
export type NveStage = z.infer<typeof NveStageSchema>;
export type MdStageSpec =
  | MinimizationStage
  | HeatingStage
  | EquilibrationStage
  | ProductionStage
  | NveStage;

export const RenderedMdinSchema = z
  .object({
    kind: MdStageKindSchema,
    requiresReferenceCoordinates: z.boolean(),
    restartFormat: RestartFormatSchema,
    logicalPath: LogicalPathSchema.refine((path) => path.toLowerCase().endsWith(".mdin")),
    mediaType: z.literal("application/vnd.amber.mdin"),
    content: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((rendered, context) => {
    if (sha256Bytes(rendered.content) !== rendered.sha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sha256"],
        message: "Rendered mdin digest does not match its content",
      });
    }
    if (!rendered.content.startsWith(`EigenGrid stage=${rendered.kind} `)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["kind"],
        message: "Rendered mdin kind marker does not match metadata",
      });
    }
    if (/\bntr=1,/.test(rendered.content) !== rendered.requiresReferenceCoordinates) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiresReferenceCoordinates"],
        message: "Rendered mdin restraint metadata does not match ntr",
      });
    }
    const expectedNtxo = rendered.restartFormat === "netcdf" ? 2 : 1;
    if (!rendered.content.includes(`ntxo=${expectedNtxo},`)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["restartFormat"],
        message: "Rendered mdin restart format metadata does not match ntxo",
      });
    }
  });
export type RenderedMdin = z.infer<typeof RenderedMdinSchema>;

function parseStageSpec(value: unknown): MdStageSpec {
  const kind = MdStageKindSchema.parse((value as { kind?: unknown } | null)?.kind);
  if (kind === "minimization") return MinimizationStageSchema.parse(value);
  if (kind === "heating") return HeatingStageSchema.parse(value);
  if ((value as { ensemble?: unknown }).ensemble === "nve") return NveStageSchema.parse(value);
  if (kind === "equilibration") return EquilibrationStageSchema.parse(value);
  return ProductionStageSchema.parse(value);
}

function number(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError("AMBER numeric values must be finite");
  return Object.is(value, -0) ? "0" : String(value);
}

function addRestraint(
  lines: string[],
  restraint: { weightKcalMolA2: number; mask: string } | undefined,
) {
  if (restraint === undefined) {
    lines.push("  ntr=0,");
    return;
  }
  lines.push("  ntr=1,");
  lines.push(`  restraint_wt=${number(restraint.weightKcalMolA2)},`);
  lines.push(`  restraintmask='${restraint.mask}',`);
}

function addCadence(
  lines: string[],
  output: { energiesEvery: number; trajectoryEvery: number; restartEvery: number },
) {
  lines.push(`  ntpr=${output.energiesEvery},`);
  lines.push(`  ntwx=${output.trajectoryEvery},`);
  lines.push(`  ntwr=${output.restartEvery},`);
  lines.push("  ioutfm=1,");
}

function addRestartFormat(lines: string[], restartFormat: RestartFormat): void {
  lines.push(`  ntxo=${restartFormat === "netcdf" ? 2 : 1},`);
}

function addExplicitNonbonded(
  lines: string[],
  nonbonded: { electrostatics: "pme"; ewaldTolerance: number } | undefined,
): void {
  if (nonbonded === undefined) return;
  // Amber 26 §23.7: these belong to &ewald, never to &cntrl.
  lines.push("&ewald");
  lines.push("  ew_type=0,");
  lines.push(`  dsum_tol=${number(nonbonded.ewaldTolerance)},`);
  lines.push("/", "");
}

function addExplicitConstraints(
  lines: string[],
  constraints: { bondsToHydrogen: boolean; tolerance?: number } | undefined,
  legacyDefault: boolean,
): void {
  const constrained = constraints?.bondsToHydrogen ?? legacyDefault;
  lines.push(`  ntc=${constrained ? 2 : 1},`);
  lines.push(`  ntf=${constrained ? 2 : 1},`);
  if (constrained && constraints?.tolerance !== undefined) {
    lines.push(`  tol=${number(constraints.tolerance)},`);
    lines.push("  jfastw=0,");
  }
}

function addDynamics(
  lines: string[],
  stage: EquilibrationStage | ProductionStage | NveStage,
): void {
  lines.push("  imin=0,");
  lines.push("  irest=1,");
  lines.push("  ntx=5,");
  lines.push(`  nstlim=${stage.steps},`);
  lines.push(`  dt=${number(stage.timestepPs)},`);
  addExplicitConstraints(lines, stage.constraints, true);
  lines.push(`  cut=${number(stage.cutoffAngstrom)},`);
  if (stage.ensemble === "nve") {
    // Amber NVE: no thermostat/barostat, no velocity generation, no periodic COM removal.
    lines.push("  ntt=0,", "  ntb=1,", "  ntp=0,", "  nscm=0,");
    addCadence(lines, stage.output);
    addRestartFormat(lines, stage.restartFormat);
    addRestraint(lines, stage.restraints);
    lines.push("  iwrap=0,");
    return;
  }
  lines.push("  ntt=3,");
  lines.push(`  gamma_ln=${number(stage.thermostatCollisionPs)},`);
  lines.push(`  temp0=${number(stage.temperatureK)},`);
  lines.push(`  ig=${stage.randomSeed},`);
  if (stage.ensemble === "nvt") {
    lines.push("  ntb=1,");
    lines.push("  ntp=0,");
  } else {
    lines.push("  ntb=2,");
    lines.push(`  ntp=${stage.pressureCoupling === "semiisotropic" ? 3 : 1},`);
    lines.push(`  barostat=${stage.barostatAlgorithm === "berendsen" ? 1 : 2},`);
    lines.push(`  pres0=${number(stage.pressureBar!)},`);
    lines.push(`  taup=${number(stage.pressureRelaxationPs!)},`);
    if (stage.pressureCoupling === "semiisotropic") {
      lines.push("  csurften=3,");
      lines.push(`  gamma_ten=${number(stage.surfaceTensionDynCm!)},`);
      lines.push(`  ninterface=${stage.interfaces!},`);
    }
  }
  addCadence(lines, stage.output);
  addRestartFormat(lines, stage.restartFormat);
  addRestraint(lines, stage.restraints);
  lines.push("  iwrap=1,");
}

export function renderMdin(value: unknown, logicalPath: LogicalPath): RenderedMdin {
  const stage = parseStageSpec(value);
  const path = LogicalPathSchema.parse(logicalPath);
  if (!path.toLowerCase().endsWith(".mdin")) throw new Error("mdin paths must end in .mdin");

  const lines = [`EigenGrid stage=${stage.kind} ${stage.title}`, "&cntrl"];
  if (stage.kind === "minimization") {
    lines.push("  imin=1,");
    lines.push("  ntmin=1,");
    lines.push(`  maxcyc=${stage.maxCycles},`);
    lines.push(`  ncyc=${stage.steepestDescentCycles},`);
    lines.push(`  drms=${number(stage.rmsGradientToleranceKcalMolAngstrom)},`);
    lines.push(`  dx0=${number(stage.initialStepAngstrom)},`);
    lines.push(`  cut=${number(stage.cutoffAngstrom)},`);
    addExplicitConstraints(lines, stage.constraints, false);
    addCadence(lines, stage.output);
    addRestartFormat(lines, stage.restartFormat);
    addRestraint(lines, stage.restraints);
    lines.push("  ntb=1,");
  } else if (stage.kind === "heating") {
    lines.push("  imin=0,");
    lines.push("  irest=0,");
    lines.push("  ntx=1,");
    lines.push(`  nstlim=${stage.steps},`);
    lines.push(`  dt=${number(stage.timestepPs)},`);
    addExplicitConstraints(lines, stage.constraints, true);
    lines.push("  ntb=1,");
    lines.push("  ntp=0,");
    lines.push("  ntt=3,");
    lines.push(`  gamma_ln=${number(stage.thermostatCollisionPs)},`);
    lines.push(`  tempi=${number(stage.initialTemperatureK)},`);
    lines.push(`  temp0=${number(stage.targetTemperatureK)},`);
    lines.push(`  ig=${stage.randomSeed},`);
    lines.push(`  cut=${number(stage.cutoffAngstrom)},`);
    lines.push("  nmropt=1,");
    addCadence(lines, stage.output);
    addRestartFormat(lines, stage.restartFormat);
    addRestraint(lines, stage.restraints);
  } else {
    addDynamics(lines, stage);
  }
  lines.push("/", "");
  addExplicitNonbonded(lines, stage.nonbonded);
  if (stage.kind === "heating") {
    lines.push(
      `&wt TYPE='TEMP0', istep1=0, istep2=${stage.steps}, value1=${number(stage.initialTemperatureK)}, value2=${number(stage.targetTemperatureK)} /`,
      "&wt TYPE='END' /",
      "",
    );
  }
  const content = lines.join("\n");
  return {
    kind: stage.kind,
    requiresReferenceCoordinates: stage.restraints !== undefined,
    restartFormat: stage.restartFormat,
    logicalPath: path,
    mediaType: "application/vnd.amber.mdin",
    content,
    sha256: sha256Bytes(content),
  };
}
