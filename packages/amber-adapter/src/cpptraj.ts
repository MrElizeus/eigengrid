import { z } from "zod";
import { sha256Bytes } from "./canonical";
import {
  CommandInputSchema,
  LogicalPathSchema,
  createCommandSpec,
  type CommandInput,
  type CommandOutput,
  type CommandSpec,
  type LogicalPath,
} from "./contracts";
import type { RenderedTextInput } from "./leap";

const analysisNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/);
const amberMaskSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_:,@*?+!()&|=.-]+$/, "unsupported or unsafe CPPTRAJ mask syntax");

const atomIndex = z.number().int().positive().max(1_000_000);
export const CpptrajAtomSelectionSchema = z
  .array(atomIndex)
  .min(1)
  .max(5_000)
  .refine(
    (indices) => indices.every((atom, index) => index === 0 || atom > indices[index - 1]!),
    "CPPTRAJ atom selections must be ordered and unique",
  );

export const CpptrajFrameWindowSchema = z
  .object({
    first: z.number().int().positive().max(10_000_000),
    last: z.number().int().positive().max(10_000_000),
    stride: z.number().int().positive().max(10_000_000),
  })
  .strict()
  .refine((window) => window.first <= window.last, "CPPTRAJ frame window must advance");

/** Encode exact one-based atoms as a bounded mask, never a caller expression. */
export function deriveCpptrajAtomMask(value: readonly number[]): string {
  const atoms = CpptrajAtomSelectionSchema.parse(value);
  const ranges: string[] = [];
  let first = atoms[0]!;
  let last = first;
  for (const atom of atoms.slice(1)) {
    if (atom === last + 1) {
      last = atom;
      continue;
    }
    ranges.push(first === last ? String(first) : `${first}-${last}`);
    first = last = atom;
  }
  ranges.push(first === last ? String(first) : `${first}-${last}`);
  return amberMaskSchema.parse(`@${ranges.join(",")}`);
}

const BaseAnalysisFields = {
  name: analysisNameSchema,
  outputPath: LogicalPathSchema.refine((path) => path.toLowerCase().endsWith(".dat"), {
    message: "raw CPPTRAJ table outputs must use .dat",
  }),
};

const CpptrajAnalysisSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("rmsd_atoms"),
      ...BaseAnalysisFields,
      atomIndices: CpptrajAtomSelectionSchema,
      reference: z.literal("first"),
      massWeighted: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("radius_of_gyration"),
      ...BaseAnalysisFields,
      atomIndices: CpptrajAtomSelectionSchema,
      massWeighted: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("dihedral"),
      ...BaseAnalysisFields,
      atomIndices: z
        .tuple([atomIndex, atomIndex, atomIndex, atomIndex])
        .refine((atoms) => new Set(atoms).size === 4, "Dihedral requires four distinct atoms"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rmsd"),
      ...BaseAnalysisFields,
      mask: amberMaskSchema,
      reference: z.literal("first"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rmsf"),
      ...BaseAnalysisFields,
      mask: amberMaskSchema,
      byResidue: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("distance"),
      ...BaseAnalysisFields,
      mask1: amberMaskSchema,
      mask2: amberMaskSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("hbond"),
      ...BaseAnalysisFields,
      soluteMask: amberMaskSchema,
    })
    .strict(),
]);
export type CpptrajAnalysis = z.infer<typeof CpptrajAnalysisSchema>;

export interface CpptrajPlan {
  topology: CommandInput;
  trajectories: CommandInput[];
  analyses: CpptrajAnalysis[];
  autoimage: boolean;
  autoimageAnchor?: number[];
  trajectoryWindows?: z.infer<typeof CpptrajFrameWindowSchema>[];
  scriptPath: LogicalPath;
  logPath: LogicalPath;
  cwd?: LogicalPath;
}

export interface RenderedCpptrajPlan {
  input: RenderedTextInput;
  command: CommandSpec;
}

export function renderCpptrajPlan(plan: CpptrajPlan): RenderedCpptrajPlan {
  const fields = new Set([
    "topology",
    "trajectories",
    "analyses",
    "autoimage",
    "autoimageAnchor",
    "trajectoryWindows",
    "scriptPath",
    "logPath",
    "cwd",
  ]);
  for (const field of Object.keys(plan))
    if (!fields.has(field)) throw new Error(`Unknown CPPTRAJ plan field: ${field}`);
  const topology = { ...CommandInputSchema.parse(plan.topology), role: "topology.prmtop" };
  const trajectories = z.array(CommandInputSchema).min(1).max(256).parse(plan.trajectories);
  const analyses = z.array(CpptrajAnalysisSchema).min(1).max(64).parse(plan.analyses);
  const autoimage = z.boolean().parse(plan.autoimage);
  const anchor =
    plan.autoimageAnchor === undefined ? undefined : deriveCpptrajAtomMask(plan.autoimageAnchor);
  if (anchor !== undefined && !autoimage) throw new Error("An autoimage anchor requires imaging");
  const windows =
    plan.trajectoryWindows === undefined
      ? undefined
      : z.array(CpptrajFrameWindowSchema).length(trajectories.length).parse(plan.trajectoryWindows);
  const scriptPath = LogicalPathSchema.parse(plan.scriptPath);
  const logPath = LogicalPathSchema.parse(plan.logPath);
  const cwd = LogicalPathSchema.parse(plan.cwd ?? "work");
  if (![".prmtop", ".parm7"].some((suffix) => topology.logicalPath.endsWith(suffix))) {
    throw new Error("CPPTRAJ topology must be prmtop/parm7");
  }
  if (!scriptPath.endsWith(".in")) throw new Error("CPPTRAJ input path must end in .in");
  if (!logPath.endsWith(".log")) throw new Error("CPPTRAJ log path must end in .log");
  for (const trajectory of trajectories) {
    if (![".nc", ".netcdf"].some((suffix) => trajectory.logicalPath.endsWith(suffix))) {
      throw new Error("CPPTRAJ trajectories must be NetCDF artifacts");
    }
  }
  if (new Set(analyses.map((analysis) => analysis.name)).size !== analyses.length) {
    throw new Error("CPPTRAJ analysis names must be unique");
  }
  if (new Set(analyses.map((analysis) => analysis.outputPath)).size !== analyses.length) {
    throw new Error("CPPTRAJ output paths must be unique");
  }

  const lines = [`parm ${topology.logicalPath}`];
  for (const [index, trajectory] of trajectories.entries()) {
    const window = windows?.[index];
    lines.push(
      `trajin ${trajectory.logicalPath}${window === undefined ? "" : ` ${window.first} ${window.last} ${window.stride}`}`,
    );
  }
  if (autoimage) lines.push(`autoimage${anchor === undefined ? "" : ` anchor ${anchor}`}`);
  for (const analysis of analyses) {
    if (analysis.kind === "rmsd_atoms") {
      lines.push(
        `rms ${analysis.name} ${deriveCpptrajAtomMask(analysis.atomIndices)} first${analysis.massWeighted ? " mass" : ""} out ${analysis.outputPath}`,
      );
    } else if (analysis.kind === "radius_of_gyration") {
      lines.push(
        `radgyr ${analysis.name} ${deriveCpptrajAtomMask(analysis.atomIndices)}${analysis.massWeighted ? " mass" : ""} nomax out ${analysis.outputPath}`,
      );
    } else if (analysis.kind === "dihedral") {
      lines.push(
        `dihedral ${analysis.name} ${analysis.atomIndices.map((atom) => `@${atom}`).join(" ")} out ${analysis.outputPath}`,
      );
    } else if (analysis.kind === "rmsd") {
      lines.push(
        `rms ${analysis.name} ${analysis.mask} ${analysis.reference} out ${analysis.outputPath}`,
      );
    } else if (analysis.kind === "rmsf") {
      lines.push(
        `atomicfluct out ${analysis.outputPath} ${analysis.mask}${analysis.byResidue ? " byres" : ""}`,
      );
    } else if (analysis.kind === "distance") {
      lines.push(
        `distance ${analysis.name} ${analysis.mask1} ${analysis.mask2} out ${analysis.outputPath}`,
      );
    } else {
      lines.push(`hbond ${analysis.name} out ${analysis.outputPath} ${analysis.soluteMask}`);
    }
  }
  lines.push("run", "quit");
  const content = `${lines.join("\n")}\n`;
  const scriptInput: CommandInput = {
    role: "cpptraj.input",
    logicalPath: scriptPath,
    mediaType: "text/plain",
    sha256: sha256Bytes(content),
  };
  const trajectoryInputs: CommandInput[] = trajectories.map((trajectory, index) => ({
    ...trajectory,
    role: `trajectory.${index}`,
  }));
  const outputs: CommandOutput[] = [
    ...analyses.map((analysis, index) => ({
      role: `analysis.${index}`,
      logicalPath: analysis.outputPath,
      mediaType: "text/plain" as const,
      producedBy: "executable" as const,
    })),
    {
      role: "cpptraj.log",
      logicalPath: logPath,
      mediaType: "text/plain" as const,
      producedBy: "executable" as const,
    },
  ];
  const command = createCommandSpec({
    operation: "amber.cpptraj.analyze",
    executable: "cpptraj",
    argv: ["-i", scriptPath, "-o", logPath],
    cwd,
    inputs: [scriptInput, topology, ...trajectoryInputs],
    outputs,
  });
  return {
    input: {
      logicalPath: scriptPath,
      mediaType: "text/plain",
      content,
      sha256: scriptInput.sha256,
    },
    command,
  };
}
