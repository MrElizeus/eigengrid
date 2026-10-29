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

export const LeaprcSourceSchema = z.enum([
  "leaprc.protein.ff14SB",
  "leaprc.protein.ff19SB",
  "leaprc.gaff2",
  "leaprc.lipid21",
  "leaprc.water.tip3p",
  "leaprc.water.opc",
]);
export type LeaprcSource = z.infer<typeof LeaprcSourceSchema>;

const leapVariableSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/);

export interface LeapComponent {
  variable: string;
  format: "pdb" | "mol2";
  artifact: CommandInput;
}

/** Built-in Amber templates only; no caller supplied LEaP expressions. */
export const LeapPeptideTemplateSchema = z
  .object({
    identity: z.literal("ACE-ALA-NME"),
    stereochemistry: z.literal("L"),
  })
  .strict();

export const LeapSolvationSchema = z
  .object({
    waterModel: z.enum(["TIP3P", "OPC"]),
    boxShape: z.enum(["orthorhombic", "cubic", "truncated_octahedron"]),
    paddingAngstrom: z.number().finite().positive().max(100),
  })
  .strict();

export const LeapExistingSolventSchema = z
  .object({
    waterModel: z.enum(["TIP3P", "OPC"]),
    componentVariable: leapVariableSchema,
    waterMoleculeCount: z.number().int().positive(),
  })
  .strict();

export const LeapSaltPairPolicySchema = z
  .object({
    schemaVersion: z.literal("eigengrid.leap-salt-pair-policy/v1"),
    cation: z.literal("Na+"),
    anion: z.literal("Cl-"),
    targetIonicStrengthMolar: z.number().finite().positive().max(1),
    waterMoleculeCount: z.number().int().positive(),
    numberOfPairs: z.number().int().nonnegative(),
    waterReferenceMolarity: z.literal(55.5),
    derivation: z.literal("round(Nwater * targetIonicStrengthMolar / 55.5)"),
    neutralizationOrder: z.literal("separate-before-salt-pairs"),
  })
  .strict()
  .superRefine((policy, context) => {
    const expected = Math.round(
      (policy.waterMoleculeCount * policy.targetIonicStrengthMolar) / policy.waterReferenceMolarity,
    );
    if (policy.numberOfPairs !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["numberOfPairs"],
        message: `NaCl pairs must equal round(Nwater*c/55.5) = ${expected}`,
      });
    }
  });

export const LeapIonPolicySchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("none"), soluteNetCharge: z.number().int().min(-1000).max(1000) })
    .strict(),
  z
    .object({
      kind: z.literal("neutralize"),
      soluteNetCharge: z
        .number()
        .int()
        .min(-1000)
        .max(1000)
        .refine((value) => value !== 0),
      counterIon: z.enum(["Na+", "K+", "Cl-"]),
    })
    .strict(),
]);

export interface LeapAssemblyPlan {
  forceFields: LeaprcSource[];
  frcmods: CommandInput[];
  components: LeapComponent[];
  peptideTemplate?: z.infer<typeof LeapPeptideTemplateSchema>;
  solvation?: z.infer<typeof LeapSolvationSchema>;
  existingSolvent?: z.infer<typeof LeapExistingSolventSchema>;
  ions?: z.infer<typeof LeapIonPolicySchema>;
  saltPairs?: z.infer<typeof LeapSaltPairPolicySchema>;
  unitName?: string;
  scriptPath: LogicalPath;
  topologyPath: LogicalPath;
  coordinatesPath: LogicalPath;
  snapshotPdbPath: LogicalPath;
  logPath: LogicalPath;
  cwd?: LogicalPath;
}

export interface RenderedTextInput {
  logicalPath: LogicalPath;
  mediaType: "text/plain";
  content: string;
  sha256: string;
}

export interface RenderedLeapAssembly {
  input: RenderedTextInput;
  command: CommandSpec;
}

function assertExtension(path: string, extension: string, label: string): void {
  if (!path.toLowerCase().endsWith(extension)) {
    throw new Error(`${label} must use the ${extension} extension`);
  }
}

export function renderLeapAssembly(plan: LeapAssemblyPlan): RenderedLeapAssembly {
  // Reject unmodelled instructions rather than silently ignoring chemistry.
  const allowedKeys = new Set([
    "forceFields",
    "frcmods",
    "components",
    "peptideTemplate",
    "solvation",
    "existingSolvent",
    "ions",
    "saltPairs",
    "unitName",
    "scriptPath",
    "topologyPath",
    "coordinatesPath",
    "snapshotPdbPath",
    "logPath",
    "cwd",
  ]);
  for (const key of Object.keys(plan)) {
    if (!allowedKeys.has(key)) throw new Error(`Unknown LEaP plan field: ${key}`);
  }
  const peptideTemplate =
    plan.peptideTemplate === undefined
      ? undefined
      : LeapPeptideTemplateSchema.parse(plan.peptideTemplate);
  const solvation =
    plan.solvation === undefined ? undefined : LeapSolvationSchema.parse(plan.solvation);
  const existingSolvent =
    plan.existingSolvent === undefined
      ? undefined
      : LeapExistingSolventSchema.parse(plan.existingSolvent);
  const ions = plan.ions === undefined ? undefined : LeapIonPolicySchema.parse(plan.ions);
  const saltPairs =
    plan.saltPairs === undefined ? undefined : LeapSaltPairPolicySchema.parse(plan.saltPairs);
  const forceFields = z.array(LeaprcSourceSchema).min(1).max(16).parse(plan.forceFields);
  if (new Set(forceFields).size !== forceFields.length) {
    throw new Error("LEaP force-field sources must be unique and explicitly ordered");
  }
  const frcmods = z.array(CommandInputSchema).max(32).parse(plan.frcmods);
  const components = z
    .array(
      z
        .object({
          variable: leapVariableSchema,
          format: z.enum(["pdb", "mol2"]),
          artifact: CommandInputSchema,
        })
        .strict(),
    )
    .min(peptideTemplate === undefined ? 1 : 0)
    .max(64)
    .parse(plan.components);
  const proteins = forceFields.filter((source) => source.startsWith("leaprc.protein."));
  const waters = forceFields.filter((source) => source.startsWith("leaprc.water."));
  if (proteins.length > 1 || waters.length > 1) {
    throw new Error("LEaP cannot mix competing protein or water force-field sources");
  }
  if (
    peptideTemplate !== undefined &&
    (components.length !== 0 ||
      frcmods.length !== 0 ||
      proteins.length !== 1 ||
      forceFields.some((source) => source === "leaprc.gaff2" || source === "leaprc.lipid21"))
  ) {
    throw new Error(
      "Capped alanine requires one protein force field and no external components or ligand parameters",
    );
  }
  if (solvation !== undefined && existingSolvent !== undefined) {
    throw new Error("LEaP system cannot add a second solvent box around prepacked solvent");
  }
  if (solvation !== undefined) {
    const waterSource =
      solvation.waterModel === "TIP3P" ? "leaprc.water.tip3p" : "leaprc.water.opc";
    if (waters.length !== 1 || waters[0] !== waterSource)
      throw new Error("Solvation water model must match its explicit force-field source");
    if (ions === undefined) throw new Error("Solvation requires an explicit ion policy");
  } else if (existingSolvent !== undefined) {
    const waterSource =
      existingSolvent.waterModel === "TIP3P" ? "leaprc.water.tip3p" : "leaprc.water.opc";
    const waterComponent = components.find(
      (component) => component.variable === existingSolvent.componentVariable,
    );
    if (
      waters.length !== 1 ||
      waters[0] !== waterSource ||
      !waterComponent ||
      waterComponent.format !== "pdb"
    ) {
      throw new Error("Prepacked solvent must bind a PDB water component and matching water model");
    }
    if (ions === undefined) throw new Error("Prepacked solvent requires an explicit ion policy");
  } else if (ions !== undefined || saltPairs !== undefined) {
    throw new Error("Ion policies require an explicitly solvated or prepacked-water system");
  }
  if (saltPairs !== undefined) {
    if (
      existingSolvent === undefined ||
      saltPairs.waterMoleculeCount !== existingSolvent.waterMoleculeCount ||
      ions === undefined
    ) {
      throw new Error("Salt pairs require the exact prepacked-water count and separate ion policy");
    }
  }
  if (peptideTemplate !== undefined && ions !== undefined && ions.soluteNetCharge !== 0)
    throw new Error("ACE-ALA-NME has neutral capped termini");
  if (ions?.kind === "neutralize" && ions.soluteNetCharge > 0 !== (ions.counterIon === "Cl-")) {
    throw new Error("Counterion charge must oppose the declared solute charge");
  }
  const unitName = leapVariableSchema.parse(plan.unitName ?? "system");
  if (components.some((component) => component.variable === unitName)) {
    throw new Error("The assembled LEaP unit name must not shadow a component variable");
  }
  if (new Set(components.map((component) => component.variable)).size !== components.length) {
    throw new Error("LEaP component variables must be unique");
  }

  const scriptPath = LogicalPathSchema.parse(plan.scriptPath);
  const topologyPath = LogicalPathSchema.parse(plan.topologyPath);
  const coordinatesPath = LogicalPathSchema.parse(plan.coordinatesPath);
  const snapshotPdbPath = LogicalPathSchema.parse(plan.snapshotPdbPath);
  const logPath = LogicalPathSchema.parse(plan.logPath);
  const cwd = LogicalPathSchema.parse(plan.cwd ?? "work");
  assertExtension(scriptPath, ".in", "LEaP input");
  assertExtension(topologyPath, ".prmtop", "AMBER topology");
  assertExtension(coordinatesPath, ".rst7", "AMBER coordinates");
  assertExtension(snapshotPdbPath, ".pdb", "LEaP structure snapshot");
  assertExtension(logPath, ".log", "LEaP log");

  for (const frcmod of frcmods) assertExtension(frcmod.logicalPath, ".frcmod", "frcmod input");
  for (const component of components) {
    assertExtension(
      component.artifact.logicalPath,
      `.${component.format}`,
      `${component.format} input`,
    );
  }

  const lines: string[] = [];
  for (const forceField of forceFields) lines.push(`source ${forceField}`);
  for (const frcmod of frcmods) lines.push(`loadamberparams ${frcmod.logicalPath}`);
  for (const component of components) {
    const loader = component.format === "pdb" ? "loadpdb" : "loadmol2";
    lines.push(`${component.variable} = ${loader} ${component.artifact.logicalPath}`);
  }
  lines.push(
    peptideTemplate === undefined
      ? `${unitName} = combine { ${components.map((item) => item.variable).join(" ")} }`
      : `${unitName} = sequence { ACE ALA NME }`,
  );
  if (solvation !== undefined) {
    const command = solvation.boxShape === "truncated_octahedron" ? "solvateOct" : "solvateBox";
    const box = solvation.waterModel === "TIP3P" ? "TIP3PBOX" : "OPCBOX";
    lines.push(
      `${command} ${unitName} ${box} ${solvation.paddingAngstrom}${solvation.boxShape === "cubic" ? " iso" : ""}`,
    );
  }
  if (ions?.kind === "neutralize")
    lines.push(`addIons ${unitName} ${ions.counterIon} ${Math.abs(ions.soluteNetCharge)}`);
  if (saltPairs !== undefined && saltPairs.numberOfPairs > 0) {
    lines.push(
      `addIonsRand ${unitName} ${saltPairs.cation} ${saltPairs.numberOfPairs} ${saltPairs.anion} ${saltPairs.numberOfPairs}`,
    );
  }
  lines.push(`check ${unitName}`);
  lines.push(`saveamberparm ${unitName} ${topologyPath} ${coordinatesPath}`);
  lines.push(`savepdb ${unitName} ${snapshotPdbPath}`);
  lines.push("quit");
  const content = `${lines.join("\n")}\n`;

  const scriptInput: CommandInput = {
    role: "leap.input",
    logicalPath: scriptPath,
    mediaType: "text/plain",
    sha256: sha256Bytes(content),
  };
  const componentInputs: CommandInput[] = components.map((component, index) => ({
    ...component.artifact,
    role: `component.${index}`,
  }));
  const frcmodInputs: CommandInput[] = frcmods.map((frcmod, index) => ({
    ...frcmod,
    role: `force-field.${index}`,
  }));
  const outputs: CommandOutput[] = [
    {
      role: "topology.prmtop",
      logicalPath: topologyPath,
      mediaType: "application/vnd.amber.prmtop",
      producedBy: "executable",
    },
    {
      role: "coordinates.rst7",
      logicalPath: coordinatesPath,
      mediaType: "application/vnd.amber.rst7",
      producedBy: "executable",
    },
    {
      role: "coordinates.pdb",
      logicalPath: snapshotPdbPath,
      mediaType: "chemical/x-pdb",
      producedBy: "executable",
    },
    {
      role: "leap.log",
      logicalPath: logPath,
      mediaType: "text/plain",
      producedBy: "captured_combined",
    },
  ];
  const command = createCommandSpec({
    operation: "amber.tleap.assemble",
    executable: "tleap",
    argv: ["-f", scriptPath],
    cwd,
    inputs: [scriptInput, ...frcmodInputs, ...componentInputs],
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
