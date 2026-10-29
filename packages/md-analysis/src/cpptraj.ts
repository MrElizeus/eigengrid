import {
  AtomMapSchema,
  BiomolecularSystemManifestReferenceSchema,
  DigestSchema,
  IdSchema,
  MdArtifactReferenceSchema,
  MdStageResultSchema,
  TrajectorySegmentSchema,
  assertAtomMapDigest,
  assertMdStageResultDigest,
  assertTrajectorySegmentDigest,
  digestBytes,
  digestCanonical,
  type MdArtifactReference,
} from "@eigengrid/scientific-schema";
import { z } from "zod";
import {
  AnalysisLogicalPathSchema,
  CpptrajAnalysisPlanSchemaVersion,
  CpptrajOutputProvenanceSchema,
  CpptrajTableOutputContractSchema,
  MdAnalysisRenderSchemaVersion,
  type AnalysisLogicalPath,
  type CpptrajOutputProvenance,
} from "./contracts";

const AnalysisNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/u);

/**
 * A deliberately small safe subset of the CPPTRAJ mask language. Whitespace,
 * quoting, command separators, shell interpolation, and newlines are excluded.
 */
export const CpptrajMaskSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_:,@*?+!()&|=.'-]+$/u, "Unsupported or unsafe CPPTRAJ mask syntax");
export type CpptrajMask = z.infer<typeof CpptrajMaskSchema>;

export const AnalysisArtifactBindingSchema = z
  .object({
    artifact: MdArtifactReferenceSchema,
    logicalPath: AnalysisLogicalPathSchema,
  })
  .strict();
export type AnalysisArtifactBinding = z.infer<typeof AnalysisArtifactBindingSchema>;

const AnalysisOutputShape = {
  name: AnalysisNameSchema,
  outputPath: AnalysisLogicalPathSchema.refine((path) => path.endsWith(".dat"), {
    message: "Native CPPTRAJ table outputs must use a .dat logical path",
  }),
  outputFormat: z.literal("whitespace"),
  outputContract: CpptrajTableOutputContractSchema,
} as const;

export const CpptrajAnalysisSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("rmsd"),
      ...AnalysisOutputShape,
      mask: CpptrajMaskSchema,
      reference: z.literal("first"),
      massWeighted: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rmsf"),
      ...AnalysisOutputShape,
      mask: CpptrajMaskSchema,
      byResidue: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("distance"),
      ...AnalysisOutputShape,
      mask1: CpptrajMaskSchema,
      mask2: CpptrajMaskSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("hbond"),
      ...AnalysisOutputShape,
      soluteMask: CpptrajMaskSchema,
      /** Solvent H-bond masks require a reviewed engine mapping not present in v1. */
      includeSolvent: z.literal(false),
    })
    .strict(),
]);
export type CpptrajAnalysis = z.infer<typeof CpptrajAnalysisSchema>;

export const CpptrajAnalysisPlanSchema = z
  .object({
    schemaVersion: z.literal(CpptrajAnalysisPlanSchemaVersion),
    id: IdSchema,
    revision: z.number().int().positive(),
    missionId: IdSchema,
    system: BiomolecularSystemManifestReferenceSchema,
    atomMap: AtomMapSchema,
    stageResult: MdStageResultSchema,
    segment: TrajectorySegmentSchema,
    topology: AnalysisArtifactBindingSchema,
    trajectories: z.array(AnalysisArtifactBindingSchema).length(1),
    analyses: z.array(CpptrajAnalysisSchema).min(1).max(64),
    autoimage: z.boolean(),
    cwd: AnalysisLogicalPathSchema,
    inputPath: AnalysisLogicalPathSchema.refine((path) => path.endsWith(".in"), {
      message: "CPPTRAJ input must use a .in logical path",
    }),
    logPath: AnalysisLogicalPathSchema.refine((path) => path.endsWith(".log"), {
      message: "CPPTRAJ log must use a .log logical path",
    }),
    planDigest: DigestSchema,
  })
  .strict()
  .superRefine((plan, context) => {
    if (plan.topology.artifact.role !== "topology") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["topology", "artifact", "role"],
        message: "CPPTRAJ topology binding must use the topology artifact role",
      });
    }
    const resultTrajectory = plan.stageResult.artifacts.find(
      (artifact) => artifact.role === "trajectory",
    );
    const resultRestart = plan.stageResult.artifacts.find(
      (artifact) => artifact.role === "restart",
    );
    if (
      plan.stageResult.missionId !== plan.missionId ||
      plan.stageResult.stageKind !== "production" ||
      plan.stageResult.terminalReason !== "completed" ||
      plan.stageResult.validationStatus !== "passed" ||
      plan.segment.missionId !== plan.missionId ||
      plan.segment.stageResultId !== plan.stageResult.id ||
      plan.segment.replicaId !== plan.stageResult.replicaId ||
      plan.segment.segmentIndex !== plan.stageResult.segmentIndex ||
      plan.segment.parentRestart.contentDigest !== plan.stageResult.parentRestartDigest ||
      plan.topology.artifact.contentDigest !== plan.system.topologyDigest ||
      plan.atomMap.systemManifestId !== plan.system.id ||
      plan.atomMap.systemManifestRevision !== plan.system.revision ||
      plan.atomMap.mapDigest !== plan.system.atomMapDigest ||
      plan.atomMap.topologyDigest !== plan.system.topologyDigest ||
      plan.atomMap.coordinateDigest !== plan.system.coordinateDigest ||
      plan.atomMap.atomCount !== plan.segment.netcdf.atomCount ||
      resultRestart === undefined ||
      digestCanonical(resultRestart) !== digestCanonical(plan.segment.restart) ||
      resultTrajectory === undefined ||
      digestCanonical(resultTrajectory) !== digestCanonical(plan.segment.trajectory) ||
      digestCanonical(plan.trajectories[0]?.artifact) !== digestCanonical(plan.segment.trajectory)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["segment"],
        message:
          "CPPTRAJ plan must bind one exact mission, system, AtomMap, stage result, segment, and trajectory",
      });
    }
    for (const [index, trajectory] of plan.trajectories.entries()) {
      if (trajectory.artifact.role !== "trajectory") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["trajectories", index, "artifact", "role"],
          message: "CPPTRAJ trajectory bindings must use the trajectory artifact role",
        });
      }
    }
    const inputPaths = [
      plan.topology.logicalPath,
      ...plan.trajectories.map((trajectory) => trajectory.logicalPath),
      plan.inputPath,
    ];
    if (new Set(inputPaths).size !== inputPaths.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trajectories"],
        message: "CPPTRAJ input logical paths must be unique",
      });
    }
    const outputPaths = [plan.logPath, ...plan.analyses.map((analysis) => analysis.outputPath)];
    if (new Set(outputPaths).size !== outputPaths.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["analyses"],
        message: "CPPTRAJ output logical paths must be unique",
      });
    }
    const inputPathSet = new Set(inputPaths);
    if (outputPaths.some((path) => inputPathSet.has(path))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["analyses"],
        message: "CPPTRAJ outputs may not overwrite an input artifact",
      });
    }
    const names = plan.analyses.map((analysis) => analysis.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["analyses"],
        message: "CPPTRAJ analysis names must be unique",
      });
    }
    for (const [index, analysis] of plan.analyses.entries()) {
      const contract = analysis.outputContract;
      if (contract.format !== analysis.outputFormat || contract.headerStyle !== "commented") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["analyses", index, "outputContract"],
          message: "Native CPPTRAJ outputs require the exact whitespace/commented table contract",
        });
      }
      const normalization = contract.normalization;
      if (analysis.kind === "rmsd") {
        if (
          normalization === null ||
          normalization.metric !== "rmsd" ||
          normalization.customMetricName !== undefined ||
          normalization.unit !== "angstrom"
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["analyses", index, "outputContract", "normalization"],
            message: "RMSD outputs normalize only as the angstrom RMSD metric",
          });
        }
      } else if (analysis.kind === "distance") {
        if (
          normalization === null ||
          normalization.metric !== "custom" ||
          normalization.customMetricName !== `cpptraj.distance.${analysis.name}` ||
          normalization.unit !== "angstrom"
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["analyses", index, "outputContract", "normalization"],
            message: "Distance outputs require their exact namespaced angstrom metric identity",
          });
        }
      } else if (normalization !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["analyses", index, "outputContract", "normalization"],
          message: `${analysis.kind} frame-series normalization is not supported by this contract version`,
        });
      }
    }
  });
export type CpptrajAnalysisPlan = z.infer<typeof CpptrajAnalysisPlanSchema>;

export function computeCpptrajAnalysisPlanDigest(
  value: Omit<CpptrajAnalysisPlan, "planDigest"> | CpptrajAnalysisPlan,
): string {
  const { planDigest: _planDigest, ...payload } = value as CpptrajAnalysisPlan;
  return digestCanonical(payload);
}

export function createCpptrajAnalysisPlan(
  value: Omit<CpptrajAnalysisPlan, "planDigest">,
): CpptrajAnalysisPlan {
  return assertCpptrajAnalysisPlan({
    ...value,
    planDigest: computeCpptrajAnalysisPlanDigest(value),
  });
}

export function assertCpptrajAnalysisPlan(value: unknown): CpptrajAnalysisPlan {
  const plan = CpptrajAnalysisPlanSchema.parse(value);
  assertAtomMapDigest(plan.atomMap);
  assertMdStageResultDigest(plan.stageResult);
  assertTrajectorySegmentDigest(plan.segment);
  if (plan.planDigest !== computeCpptrajAnalysisPlanDigest(plan)) {
    throw new Error(`CPPTRAJ plan digest mismatch for ${plan.id}@${plan.revision}`);
  }
  return plan;
}

export interface ResolvedCpptrajAnalysisOutput {
  plan: CpptrajAnalysisPlan;
  analysis: CpptrajAnalysis;
  provenance: CpptrajOutputProvenance;
}

/** Resolve one exact, digest-bound output contract from a CPPTRAJ plan. */
export function resolveCpptrajAnalysisOutput(
  planValue: unknown,
  outputNameValue: unknown,
): ResolvedCpptrajAnalysisOutput {
  const plan = assertCpptrajAnalysisPlan(planValue);
  const outputName = AnalysisNameSchema.parse(outputNameValue);
  const analysis = plan.analyses.find((candidate) => candidate.name === outputName);
  if (analysis === undefined) {
    throw new Error(`CPPTRAJ output ${outputName} is absent from ${plan.id}@${plan.revision}`);
  }
  const provenance = CpptrajOutputProvenanceSchema.parse({
    planId: plan.id,
    planRevision: plan.revision,
    planDigest: plan.planDigest,
    stageResultId: plan.stageResult.id,
    replicaId: plan.segment.replicaId,
    analysisKind: analysis.kind,
    outputName: analysis.name,
    outputPath: analysis.outputPath,
    outputContractDigest: digestCanonical(analysis.outputContract),
  });
  return { plan, analysis, provenance };
}

export const RenderedCpptrajInputSchema = z
  .object({
    schemaVersion: z.literal(MdAnalysisRenderSchemaVersion),
    planId: IdSchema,
    planRevision: z.number().int().positive(),
    planDigest: DigestSchema,
    executable: z.literal("cpptraj"),
    argv: z.tuple([
      z.literal("-i"),
      AnalysisLogicalPathSchema,
      z.literal("-o"),
      AnalysisLogicalPathSchema,
    ]),
    shell: z.literal(false),
    cwd: AnalysisLogicalPathSchema,
    inputPath: AnalysisLogicalPathSchema,
    inputText: z.string().min(1),
    inputDigest: DigestSchema,
    inputs: z
      .array(
        z
          .object({
            role: z.string().regex(/^[a-z][a-z0-9_.-]*$/u),
            artifactId: IdSchema,
            evidenceRef: IdSchema,
            contentDigest: DigestSchema,
            logicalPath: AnalysisLogicalPathSchema,
            mediaType: z.string().min(1),
          })
          .strict(),
      )
      .min(2),
    outputs: z
      .array(
        z
          .object({
            role: z.string().regex(/^[a-z][a-z0-9_.-]*$/u),
            logicalPath: AnalysisLogicalPathSchema,
            mediaType: z.string().min(1),
            outputName: IdSchema.optional(),
            outputContractDigest: DigestSchema.optional(),
          })
          .strict(),
      )
      .min(2),
  })
  .strict()
  .superRefine((rendered, context) => {
    if (rendered.argv[1] !== rendered.inputPath) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["argv", 1],
        message: "CPPTRAJ argv must consume the exact rendered input path",
      });
    }
    if (
      rendered.argv[3] !==
      rendered.outputs.find((output) => output.role === "cpptraj.log")?.logicalPath
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["argv", 3],
        message: "CPPTRAJ argv must write the declared log output",
      });
    }
    if (rendered.inputDigest !== digestBytes(rendered.inputText)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inputDigest"],
        message: "CPPTRAJ rendered input digest does not match its exact bytes",
      });
    }
    const inputPaths = rendered.inputs.map((input) => input.logicalPath);
    const outputPaths = rendered.outputs.map((output) => output.logicalPath);
    if (
      new Set(inputPaths).size !== inputPaths.length ||
      new Set(outputPaths).size !== outputPaths.length ||
      outputPaths.some((path) => inputPaths.includes(path))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputs"],
        message: "Rendered CPPTRAJ artifact inventory must be unique and non-overwriting",
      });
    }
    for (const [index, output] of rendered.outputs.entries()) {
      const analysisOutput = output.role.startsWith("analysis.");
      if (
        analysisOutput !==
        (output.outputName !== undefined && output.outputContractDigest !== undefined)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outputs", index],
          message: "Analysis outputs must bind an exact output name and contract digest",
        });
      }
    }
  });
export type RenderedCpptrajInput = z.infer<typeof RenderedCpptrajInputSchema>;

function renderAnalysis(analysis: CpptrajAnalysis): string {
  if (analysis.kind === "rmsd") {
    return [
      "rms",
      analysis.name,
      analysis.mask,
      analysis.reference,
      analysis.massWeighted ? "mass" : undefined,
      "out",
      analysis.outputPath,
    ]
      .filter((token): token is string => token !== undefined)
      .join(" ");
  }
  if (analysis.kind === "rmsf") {
    return [
      "atomicfluct",
      "out",
      analysis.outputPath,
      analysis.mask,
      analysis.byResidue ? "byres" : undefined,
    ]
      .filter((token): token is string => token !== undefined)
      .join(" ");
  }
  if (analysis.kind === "distance") {
    return `distance ${analysis.name} ${analysis.mask1} ${analysis.mask2} out ${analysis.outputPath}`;
  }
  return `hbond ${analysis.name} out ${analysis.outputPath} ${analysis.soluteMask}`;
}

/**
 * Renders only allowlisted CPPTRAJ operations. It never resolves paths, opens
 * artifacts, or executes the returned argv.
 */
export function renderCpptrajAnalysisPlan(value: unknown): RenderedCpptrajInput {
  const plan = assertCpptrajAnalysisPlan(value);
  const lines = [`parm ${plan.topology.logicalPath}`];
  for (const trajectory of plan.trajectories) lines.push(`trajin ${trajectory.logicalPath}`);
  if (plan.autoimage) lines.push("autoimage");
  for (const analysis of plan.analyses) lines.push(renderAnalysis(analysis));
  lines.push("run", "quit");
  const inputText = `${lines.join("\n")}\n`;

  const inputBinding = (
    binding: AnalysisArtifactBinding,
    role: string,
  ): z.infer<typeof RenderedCpptrajInputSchema>["inputs"][number] => ({
    role,
    artifactId: binding.artifact.artifactId,
    evidenceRef: binding.artifact.evidenceRef,
    contentDigest: binding.artifact.contentDigest,
    logicalPath: binding.logicalPath,
    mediaType: binding.artifact.mediaType,
  });

  return RenderedCpptrajInputSchema.parse({
    schemaVersion: MdAnalysisRenderSchemaVersion,
    planId: plan.id,
    planRevision: plan.revision,
    planDigest: plan.planDigest,
    executable: "cpptraj",
    argv: ["-i", plan.inputPath, "-o", plan.logPath],
    shell: false,
    cwd: plan.cwd,
    inputPath: plan.inputPath,
    inputText,
    inputDigest: digestBytes(inputText),
    inputs: [
      inputBinding(plan.topology, "topology"),
      ...plan.trajectories.map((trajectory, index) =>
        inputBinding(trajectory, `trajectory.${index}`),
      ),
    ],
    outputs: [
      ...plan.analyses.map((analysis) => ({
        role: `analysis.${analysis.name}`,
        logicalPath: analysis.outputPath,
        mediaType: "text/plain",
        outputName: analysis.name,
        outputContractDigest: digestCanonical(analysis.outputContract),
      })),
      { role: "cpptraj.log", logicalPath: plan.logPath, mediaType: "text/plain" },
    ],
  });
}

export function artifactBinding(
  artifact: MdArtifactReference,
  logicalPath: AnalysisLogicalPath,
): AnalysisArtifactBinding {
  return AnalysisArtifactBindingSchema.parse({ artifact, logicalPath });
}
