import { z } from "zod";
import {
  CommandInputSchema,
  LogicalPathSchema,
  createCommandSpec,
  type CommandInput,
  type CommandOutput,
  type CommandSpec,
  type LogicalPath,
} from "./contracts";

const residueNameSchema = z.string().regex(/^[A-Z][A-Z0-9]{0,2}$/);

export interface AntechamberRequest {
  ligand: CommandInput;
  outputMol2: LogicalPath;
  formalCharge: number;
  residueName: string;
  cwd?: LogicalPath;
}

export function renderAntechamber(request: AntechamberRequest): CommandSpec {
  const ligand = CommandInputSchema.parse(request.ligand);
  const outputMol2 = LogicalPathSchema.parse(request.outputMol2);
  const cwd = LogicalPathSchema.parse(request.cwd ?? "work");
  const formalCharge = z.number().int().min(-12).max(12).parse(request.formalCharge);
  const residueName = residueNameSchema.parse(request.residueName);
  if (!outputMol2.toLowerCase().endsWith(".mol2")) {
    throw new Error("Antechamber output must be a MOL2 artifact");
  }
  if (!ligand.logicalPath.toLowerCase().endsWith(".sdf")) {
    throw new Error("The typed antechamber route accepts SDF input only");
  }

  const output: CommandOutput = {
    role: "ligand.mol2",
    logicalPath: outputMol2,
    mediaType: "chemical/x-mol2",
    producedBy: "executable",
  };
  return createCommandSpec({
    operation: "amber.antechamber.gaff2-am1bcc",
    executable: "antechamber",
    argv: [
      "-i",
      ligand.logicalPath,
      "-fi",
      "sdf",
      "-o",
      output.logicalPath,
      "-fo",
      "mol2",
      "-at",
      "gaff2",
      "-c",
      "bcc",
      "-nc",
      String(formalCharge),
      "-rn",
      residueName,
      "-pf",
      "y",
    ],
    cwd,
    inputs: [{ ...ligand, role: "ligand.sdf" }],
    outputs: [output],
  });
}

export interface Parmchk2Request {
  ligandMol2: CommandInput;
  outputFrcmod: LogicalPath;
  cwd?: LogicalPath;
}

export function renderParmchk2(request: Parmchk2Request): CommandSpec {
  const ligandMol2 = CommandInputSchema.parse(request.ligandMol2);
  const outputFrcmod = LogicalPathSchema.parse(request.outputFrcmod);
  const cwd = LogicalPathSchema.parse(request.cwd ?? "work");
  if (!ligandMol2.logicalPath.toLowerCase().endsWith(".mol2")) {
    throw new Error("parmchk2 input must be the materialized MOL2 produced by antechamber");
  }
  if (!outputFrcmod.toLowerCase().endsWith(".frcmod")) {
    throw new Error("parmchk2 output must be an frcmod artifact");
  }

  const output: CommandOutput = {
    role: "ligand.frcmod",
    logicalPath: outputFrcmod,
    mediaType: "application/vnd.amber.frcmod",
    producedBy: "executable",
  };
  return createCommandSpec({
    operation: "amber.parmchk2.gaff2",
    executable: "parmchk2",
    argv: ["-i", ligandMol2.logicalPath, "-f", "mol2", "-o", output.logicalPath, "-s", "gaff2"],
    cwd,
    inputs: [{ ...ligandMol2, role: "ligand.mol2" }],
    outputs: [output],
  });
}
