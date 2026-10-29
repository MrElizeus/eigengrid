import { z } from "zod";
import { sha256Canonical } from "./canonical";

export const AMBER_COMMAND_SCHEMA_VERSION = "amber-command/v1" as const;

export const AmberExecutableSchema = z.enum([
  "antechamber",
  "parmchk2",
  "tleap",
  "sander",
  "pmemd",
  "pmemd.cuda",
  "cpptraj",
]);
export type AmberExecutable = z.infer<typeof AmberExecutableSchema>;

const logicalSegment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Paths in adapter contracts are identifiers below a mission workspace, never
 * host paths. Resolution to a host path belongs to the execution coordinator.
 */
export const LogicalPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.startsWith("/") && !value.startsWith("\\"), {
    message: "logical paths must be relative",
  })
  .refine((value) => !/^[A-Za-z]:/.test(value), {
    message: "Windows absolute paths are forbidden",
  })
  .refine((value) => !value.includes("\\"), {
    message: "logical paths must use POSIX separators",
  })
  .refine((value) => value.split("/").every((segment) => logicalSegment.test(segment)), {
    message: "logical paths may not contain traversal or special path segments",
  });
export type LogicalPath = z.infer<typeof LogicalPathSchema>;

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const ArtifactRoleSchema = z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
const MediaTypeSchema = z.string().regex(/^[a-z0-9.+-]+\/[a-zA-Z0-9.+-]+$/);

export const CommandInputSchema = z
  .object({
    role: ArtifactRoleSchema,
    logicalPath: LogicalPathSchema,
    mediaType: MediaTypeSchema,
    sha256: Sha256Schema,
  })
  .strict();
export type CommandInput = z.infer<typeof CommandInputSchema>;

export const CommandOutputSchema = z
  .object({
    role: ArtifactRoleSchema,
    logicalPath: LogicalPathSchema,
    mediaType: MediaTypeSchema,
    producedBy: z.enum(["executable", "captured_stdout", "captured_stderr", "captured_combined"]),
  })
  .strict();
export type CommandOutput = z.infer<typeof CommandOutputSchema>;

const forbiddenShellSyntax = /[\r\n;&|<>`$]/;
const forbiddenPathToken = /(^|\/)\.\.?($|\/)|^[A-Za-z]:|^[/\\]|\\/;
const artifactLikeToken =
  /\/|\.(?:sdf|mol2|frcmod|pdb|prmtop|parm7|rst7|ncrst|inpcrd|in|mdin|out|mdout|mdinfo|nc|netcdf|csv|dat|log)$/i;

export const ArgumentTokenSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0") && !forbiddenShellSyntax.test(value), {
    message: "shell syntax, redirection, interpolation, and control characters are forbidden",
  })
  .refine((value) => !forbiddenPathToken.test(value), {
    message: "absolute paths, traversal, and platform paths are forbidden",
  });

export const CommandSpecSchema = z
  .object({
    schemaVersion: z.literal(AMBER_COMMAND_SCHEMA_VERSION),
    operation: z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/),
    executable: AmberExecutableSchema,
    argv: z.array(ArgumentTokenSchema).min(1).max(128),
    shell: z.literal(false),
    cwd: LogicalPathSchema,
    inputs: z.array(CommandInputSchema).min(1).max(128),
    outputs: z.array(CommandOutputSchema).min(1).max(128),
  })
  .strict();
export type CommandSpec = z.infer<typeof CommandSpecSchema>;

export type CommandSpecInput = Omit<CommandSpec, "schemaVersion" | "shell">;

type ExecutableOptionKind = "flag" | "value" | "inputPath" | "outputPath";

const executableOptions: Record<AmberExecutable, Record<string, ExecutableOptionKind>> = {
  antechamber: {
    "-i": "inputPath",
    "-fi": "value",
    "-o": "outputPath",
    "-fo": "value",
    "-at": "value",
    "-c": "value",
    "-nc": "value",
    "-rn": "value",
    "-pf": "value",
  },
  parmchk2: { "-i": "inputPath", "-f": "value", "-o": "outputPath", "-s": "value" },
  tleap: { "-f": "inputPath" },
  sander: {
    "-O": "flag",
    "-i": "inputPath",
    "-o": "outputPath",
    "-p": "inputPath",
    "-c": "inputPath",
    "-r": "outputPath",
    "-x": "outputPath",
    "-inf": "outputPath",
    "-ref": "inputPath",
  },
  pmemd: {
    "-O": "flag",
    "-i": "inputPath",
    "-o": "outputPath",
    "-p": "inputPath",
    "-c": "inputPath",
    "-r": "outputPath",
    "-x": "outputPath",
    "-inf": "outputPath",
    "-ref": "inputPath",
  },
  "pmemd.cuda": {
    "-O": "flag",
    "-i": "inputPath",
    "-o": "outputPath",
    "-p": "inputPath",
    "-c": "inputPath",
    "-r": "outputPath",
    "-x": "outputPath",
    "-inf": "outputPath",
    "-ref": "inputPath",
  },
  cpptraj: { "-i": "inputPath", "-o": "outputPath" },
};

const requiredOptions: Record<AmberExecutable, readonly string[]> = {
  antechamber: ["-i", "-fi", "-o", "-fo", "-at", "-c", "-nc", "-rn", "-pf"],
  parmchk2: ["-i", "-f", "-o", "-s"],
  tleap: ["-f"],
  sander: ["-O", "-i", "-o", "-p", "-c", "-r", "-x", "-inf"],
  pmemd: ["-O", "-i", "-o", "-p", "-c", "-r", "-x", "-inf"],
  "pmemd.cuda": ["-O", "-i", "-o", "-p", "-c", "-r", "-x", "-inf"],
  cpptraj: ["-i", "-o"],
};

function assertUniqueInventory(spec: CommandSpec): void {
  for (const [kind, inventory] of [
    ["input", spec.inputs],
    ["output", spec.outputs],
  ] as const) {
    const roles = new Set<string>();
    const paths = new Set<string>();
    for (const artifact of inventory) {
      if (roles.has(artifact.role)) throw new Error(`Duplicate ${kind} role: ${artifact.role}`);
      if (paths.has(artifact.logicalPath)) {
        throw new Error(`Duplicate ${kind} path: ${artifact.logicalPath}`);
      }
      roles.add(artifact.role);
      paths.add(artifact.logicalPath);
    }
  }

  const inputPaths = new Set(spec.inputs.map((item) => item.logicalPath));
  for (const output of spec.outputs) {
    if (inputPaths.has(output.logicalPath)) {
      throw new Error(`A command may not overwrite an input artifact: ${output.logicalPath}`);
    }
  }
}

function assertClosedPathInventory(spec: CommandSpec): void {
  const declared = new Set([
    ...spec.inputs.map((item) => item.logicalPath),
    ...spec.outputs.map((item) => item.logicalPath),
  ]);
  for (const token of spec.argv) {
    if (artifactLikeToken.test(token) && !declared.has(token)) {
      throw new Error(`Argument path is absent from the closed artifact inventory: ${token}`);
    }
  }
}

function assertStreamCaptureInventory(spec: CommandSpec): void {
  const captures = spec.outputs.filter((output) => output.producedBy !== "executable");
  const captureKinds = captures.map((output) => output.producedBy);
  if (new Set(captureKinds).size !== captureKinds.length) {
    throw new Error("A command may declare at most one output for each captured stream kind");
  }
  if (captureKinds.includes("captured_combined") && captureKinds.length > 1) {
    throw new Error("Combined stream capture cannot be mixed with separate stdout/stderr capture");
  }
}

function assertOperationIdentity(spec: CommandSpec): void {
  const exact: Partial<Record<AmberExecutable, string>> = {
    antechamber: "amber.antechamber.gaff2-am1bcc",
    parmchk2: "amber.parmchk2.gaff2",
    tleap: "amber.tleap.assemble",
    cpptraj: "amber.cpptraj.analyze",
  };
  const expected = exact[spec.executable];
  if (expected !== undefined && spec.operation !== expected) {
    throw new Error(`Operation ${spec.operation} does not match executable ${spec.executable}`);
  }
  if (
    ["sander", "pmemd", "pmemd.cuda"].includes(spec.executable) &&
    !/^amber\.stage\.(?:minimization|heating|equilibration|production)$/.test(spec.operation)
  ) {
    throw new Error(`Operation ${spec.operation} is not an AMBER MD stage identity`);
  }
}

function assertTypedArgv(spec: CommandSpec): void {
  const options = executableOptions[spec.executable];
  const observedOptions = new Map<string, string | true>();
  const inputPaths = new Set(spec.inputs.map((item) => item.logicalPath));
  const outputPaths = new Set(spec.outputs.map((item) => item.logicalPath));
  for (let index = 0; index < spec.argv.length; index += 1) {
    const option = spec.argv[index]!;
    const kind = options[option];
    if (kind === undefined) {
      throw new Error(`Unsupported ${spec.executable} option or positional argument: ${option}`);
    }
    if (observedOptions.has(option))
      throw new Error(`Duplicate ${spec.executable} option: ${option}`);
    if (kind === "flag") {
      observedOptions.set(option, true);
      continue;
    }
    const value = spec.argv[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${option}`);
    if (kind === "inputPath" && !inputPaths.has(value)) {
      throw new Error(`Input path ${value} for ${option} is absent from input inventory`);
    }
    if (kind === "outputPath" && !outputPaths.has(value)) {
      throw new Error(`Output path ${value} for ${option} is absent from output inventory`);
    }
    observedOptions.set(option, value);
    index += 1;
  }
  for (const required of requiredOptions[spec.executable]) {
    // Preserve readability of historical command records; current minimization
    // renderers omit -x and require only the three outputs Amber actually writes.
    if (required === "-x" && spec.operation === "amber.stage.minimization") continue;
    if (!observedOptions.has(required)) {
      throw new Error(`Missing required ${spec.executable} option: ${required}`);
    }
  }

  if (spec.executable === "antechamber") {
    const exact = { "-fi": "sdf", "-fo": "mol2", "-at": "gaff2", "-c": "bcc", "-pf": "y" };
    for (const [option, expected] of Object.entries(exact)) {
      if (observedOptions.get(option) !== expected) {
        throw new Error(`The typed antechamber route requires ${option} ${expected}`);
      }
    }
    const formalCharge = observedOptions.get("-nc");
    if (
      typeof formalCharge !== "string" ||
      !/^-?\d+$/.test(formalCharge) ||
      Number(formalCharge) < -12 ||
      Number(formalCharge) > 12
    ) {
      throw new Error("Antechamber formal charge must be an integer from -12 through 12");
    }
    if (!/^[A-Z][A-Z0-9]{0,2}$/.test(String(observedOptions.get("-rn")))) {
      throw new Error("Antechamber residue name must be a one-to-three character upper-case ID");
    }
  }
  if (
    spec.executable === "parmchk2" &&
    (observedOptions.get("-f") !== "mol2" || observedOptions.get("-s") !== "gaff2")
  ) {
    throw new Error("The typed parmchk2 route requires MOL2 input and GAFF2 parameters");
  }
}

export function validateCommandSpec(value: unknown): CommandSpec {
  const spec = CommandSpecSchema.parse(value);
  assertUniqueInventory(spec);
  assertClosedPathInventory(spec);
  assertStreamCaptureInventory(spec);
  assertOperationIdentity(spec);
  assertTypedArgv(spec);
  return spec;
}

/** The returned value deliberately has no configurable shell field. */
export function createCommandSpec(input: CommandSpecInput): CommandSpec {
  return validateCommandSpec({
    schemaVersion: AMBER_COMMAND_SCHEMA_VERSION,
    shell: false,
    ...input,
  });
}

/** Digest of the complete, validated request used as its idempotency identity. */
export function commandRequestDigest(value: unknown): string {
  return sha256Canonical(validateCommandSpec(value));
}
