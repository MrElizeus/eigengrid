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
import {
  MdStageKindSchema,
  RenderedMdinSchema,
  RestartFormatSchema,
  type MdStageKind,
  type RenderedMdin,
} from "./mdin";

export const AmberMdEngineSchema = z.enum(["sander", "pmemd", "pmemd.cuda"]);
export type AmberMdEngine = z.infer<typeof AmberMdEngineSchema>;

export interface MdStageOutputPaths {
  mdout: LogicalPath;
  restart: LogicalPath;
  trajectory?: LogicalPath;
  mdinfo: LogicalPath;
}

export interface MdStageCommandRequest {
  kind: MdStageKind;
  engine: AmberMdEngine;
  topology: CommandInput;
  coordinates: CommandInput;
  mdin: MaterializedMdinInput | RenderedMdin;
  referenceCoordinates?: CommandInput;
  outputs: MdStageOutputPaths;
  cwd?: LogicalPath;
}

export const MaterializedMdinInputSchema = CommandInputSchema.extend({
  role: z.literal("stage.mdin"),
  mediaType: z.literal("application/vnd.amber.mdin"),
  stageKind: MdStageKindSchema,
  requiresReferenceCoordinates: z.boolean(),
  restartFormat: RestartFormatSchema,
}).strict();
export type MaterializedMdinInput = z.infer<typeof MaterializedMdinInputSchema>;

function mdinMetadata(value: MaterializedMdinInput | RenderedMdin): {
  input: CommandInput;
  stageKind: MdStageKind;
  requiresReferenceCoordinates: boolean;
  restartFormat: "formatted" | "netcdf";
} {
  if ("content" in value) {
    const rendered = RenderedMdinSchema.parse(value);
    return {
      input: {
        role: "stage.mdin",
        logicalPath: rendered.logicalPath,
        mediaType: rendered.mediaType,
        sha256: rendered.sha256,
      },
      stageKind: rendered.kind,
      requiresReferenceCoordinates: rendered.requiresReferenceCoordinates,
      restartFormat: rendered.restartFormat,
    };
  }
  const materialized = MaterializedMdinInputSchema.parse(value);
  return {
    input: {
      role: materialized.role,
      logicalPath: materialized.logicalPath,
      mediaType: materialized.mediaType,
      sha256: materialized.sha256,
    },
    stageKind: materialized.stageKind,
    requiresReferenceCoordinates: materialized.requiresReferenceCoordinates,
    restartFormat: materialized.restartFormat,
  };
}

function requireExtension(path: string, extensions: string[], label: string): void {
  if (!extensions.some((extension) => path.toLowerCase().endsWith(extension))) {
    throw new Error(`${label} must use one of: ${extensions.join(", ")}`);
  }
}

export function renderMdStageCommand(request: MdStageCommandRequest): CommandSpec {
  const kind = MdStageKindSchema.parse(request.kind);
  const engine = AmberMdEngineSchema.parse(request.engine);
  const topology = { ...CommandInputSchema.parse(request.topology), role: "topology.prmtop" };
  const coordinates = {
    ...CommandInputSchema.parse(request.coordinates),
    role: "coordinates.input",
  };
  const mdin = mdinMetadata(request.mdin);
  const inputMdin = mdin.input;
  if (mdin.stageKind !== kind) {
    throw new Error(`mdin kind ${mdin.stageKind} does not match requested stage ${kind}`);
  }
  const cwd = LogicalPathSchema.parse(request.cwd ?? "work");
  requireExtension(topology.logicalPath, [".prmtop", ".parm7"], "Topology input");
  requireExtension(coordinates.logicalPath, [".rst7", ".ncrst", ".inpcrd"], "Coordinate input");
  requireExtension(inputMdin.logicalPath, [".mdin"], "Stage input");

  const outputs = {
    mdout: LogicalPathSchema.parse(request.outputs.mdout),
    restart: LogicalPathSchema.parse(request.outputs.restart),
    trajectory:
      request.outputs.trajectory === undefined
        ? undefined
        : LogicalPathSchema.parse(request.outputs.trajectory),
    mdinfo: LogicalPathSchema.parse(request.outputs.mdinfo),
  };
  requireExtension(outputs.mdout, [".mdout"], "MD output");
  requireExtension(
    outputs.restart,
    [mdin.restartFormat === "netcdf" ? ".ncrst" : ".rst7"],
    `${mdin.restartFormat} restart output`,
  );
  if ((kind === "minimization") !== (outputs.trajectory === undefined)) {
    throw new Error("Only dynamics stages require a trajectory; minimization must omit it");
  }
  if (outputs.trajectory !== undefined) {
    requireExtension(outputs.trajectory, [".nc", ".netcdf"], "Trajectory output");
  }
  requireExtension(outputs.mdinfo, [".mdinfo"], "MD info output");

  const inventoryOutputs: CommandOutput[] = [
    {
      role: "stage.mdout",
      logicalPath: outputs.mdout,
      mediaType: "text/plain",
      producedBy: "executable",
    },
    {
      role: "stage.restart",
      logicalPath: outputs.restart,
      mediaType:
        mdin.restartFormat === "netcdf" ? "application/x-netcdf" : "application/vnd.amber.rst7",
      producedBy: "executable",
    },
    {
      role: "stage.mdinfo",
      logicalPath: outputs.mdinfo,
      mediaType: "text/plain",
      producedBy: "executable",
    },
  ];
  const argv = [
    "-O",
    "-i",
    inputMdin.logicalPath,
    "-o",
    outputs.mdout,
    "-p",
    topology.logicalPath,
    "-c",
    coordinates.logicalPath,
    "-r",
    outputs.restart,
    "-inf",
    outputs.mdinfo,
  ];
  if (outputs.trajectory !== undefined) {
    inventoryOutputs.splice(2, 0, {
      role: "stage.trajectory",
      logicalPath: outputs.trajectory,
      mediaType: "application/x-netcdf",
      producedBy: "executable",
    });
    argv.splice(argv.length - 2, 0, "-x", outputs.trajectory);
  }
  const inputs: CommandInput[] = [topology, coordinates, inputMdin];
  if (mdin.requiresReferenceCoordinates && request.referenceCoordinates === undefined) {
    throw new Error("Restrained mdin requires explicit referenceCoordinates and -ref");
  }
  if (request.referenceCoordinates !== undefined) {
    const reference = {
      ...CommandInputSchema.parse(request.referenceCoordinates),
      role: "coordinates.reference",
    };
    requireExtension(reference.logicalPath, [".rst7", ".ncrst", ".inpcrd"], "Reference input");
    if (reference.logicalPath === coordinates.logicalPath) {
      if (reference.sha256 !== coordinates.sha256) {
        throw new Error("A shared coordinate/reference path has conflicting digests");
      }
    } else {
      inputs.push(reference);
    }
    argv.push("-ref", reference.logicalPath);
  }

  return createCommandSpec({
    operation: `amber.stage.${kind}`,
    executable: engine,
    argv,
    cwd,
    inputs,
    outputs: inventoryOutputs,
  });
}
