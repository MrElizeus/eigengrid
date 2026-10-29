import { sha256Canonical } from "../canonical";
import { validateCommandSpec } from "../contracts";
import type { MdStageSpec as CanonicalMdStageSpec } from "@eigengrid/scientific-schema";
import {
  AMBER_STAGE_OUTPUT_ROLE_MAPPING_VERSION,
  type AmberCanonicalStageMapping,
  type AmberStageOutputRoleBinding,
  type AmberStageOutputRoleMapping,
} from "./schemas";

const CLOSED_STAGE_OUTPUT_ROLE_BINDINGS: AmberStageOutputRoleBinding[] = [
  { engineRole: "stage.restart", canonicalRole: "restart" },
  { engineRole: "stage.trajectory", canonicalRole: "trajectory" },
  { engineRole: "stage.mdout", canonicalRole: "mdout" },
  { engineRole: "stage.mdinfo", canonicalRole: "mdinfo" },
];

/** Maps engine-local roles by exact identity; paths and suffixes are deliberately irrelevant. */
export function mapAmberStageCommandOutputRoles(
  commandValue: unknown,
): AmberStageOutputRoleMapping {
  const command = validateCommandSpec(commandValue);
  if (!new Set<string>(["sander", "pmemd", "pmemd.cuda"]).has(command.executable)) {
    throw new Error("Only an AMBER MD stage command may use the stage output-role mapping");
  }
  const bindings = CLOSED_STAGE_OUTPUT_ROLE_BINDINGS.filter(
    (binding) =>
      command.operation !== "amber.stage.minimization" || binding.canonicalRole !== "trajectory",
  );
  const observedRoles = command.outputs.map((output) => output.role);
  const expectedRoles = bindings.map((binding) => binding.engineRole);
  if (
    observedRoles.length !== expectedRoles.length ||
    new Set(observedRoles).size !== observedRoles.length ||
    expectedRoles.some((role) => !observedRoles.includes(role))
  ) {
    throw new Error("AMBER stage command outputs do not match the closed canonical role mapping");
  }
  return {
    version: AMBER_STAGE_OUTPUT_ROLE_MAPPING_VERSION,
    digest: sha256Canonical({ version: AMBER_STAGE_OUTPUT_ROLE_MAPPING_VERSION, bindings }),
    bindings: bindings.map((binding) => ({ ...binding })),
  };
}

function outputContract(
  stage: CanonicalMdStageSpec,
  role: "restart" | "trajectory" | "mdout" | "mdinfo",
) {
  const output = stage.outputs.find((candidate) => candidate.role === role);
  if (!output || !output.required) {
    throw new Error(`Canonical AMBER rendering requires output contract ${role}`);
  }
  return output;
}

function bindOutputs(stage: CanonicalMdStageSpec, mapping: AmberCanonicalStageMapping) {
  const isMinimization = stage.kind === "minimization";
  const supportedRoles = new Set(
    isMinimization ? ["restart", "mdout", "mdinfo"] : ["restart", "trajectory", "mdout", "mdinfo"],
  );
  if (
    stage.outputs.length !== supportedRoles.size ||
    mapping.artifactPaths.outputs.length !== supportedRoles.size ||
    stage.outputs.some((output) => !supportedRoles.has(output.role)) ||
    mapping.artifactPaths.outputs.some(
      (binding) => !stage.outputs.some((output) => output.role === binding.role),
    )
  ) {
    throw new Error(
      "Canonical AMBER rendering requires restart, mdout, mdinfo and a trajectory only for dynamics",
    );
  }
  const outputRoles = mapping.artifactPaths.outputs.map((binding) => binding.role);
  if (new Set(outputRoles).size !== supportedRoles.size) {
    throw new Error("AMBER output path bindings must be unique");
  }

  const restart = outputContract(stage, "restart");
  const trajectory = isMinimization ? undefined : outputContract(stage, "trajectory");
  const mdout = outputContract(stage, "mdout");
  const mdinfo = outputContract(stage, "mdinfo");
  const expectedRestartMediaType =
    mapping.restart.format === "netcdf" ? "application/x-netcdf" : "application/vnd.amber.rst7";
  if (restart.mediaType !== expectedRestartMediaType) {
    throw new Error(`Canonical restart media type must be ${expectedRestartMediaType}`);
  }
  if (trajectory !== undefined && trajectory.mediaType !== "application/x-netcdf") {
    throw new Error("Canonical trajectory media type must be application/x-netcdf");
  }
  if (mdout.mediaType !== "text/plain" || mdinfo.mediaType !== "text/plain") {
    throw new Error("Canonical mdout and mdinfo media types must be text/plain");
  }
  if (
    restart.cadenceSteps === undefined ||
    (trajectory !== undefined && trajectory.cadenceSteps === undefined) ||
    mdout.cadenceSteps === undefined
  ) {
    throw new Error("Canonical restart, trajectory, and mdout cadences must be explicit");
  }
  if (restart.cadenceSteps !== stage.checkpoint.cadenceSteps) {
    throw new Error("Restart output cadence must equal the canonical checkpoint cadence");
  }
  if (
    isMinimization &&
    (restart.cadenceSteps !== stage.steps || stage.checkpoint.stopAfterCheckpointSupported)
  ) {
    throw new Error(
      "AMBER minimization has only a final restart, not periodic stoppable checkpoints",
    );
  }
  if (mdinfo.cadenceSteps !== undefined) {
    throw new Error("AMBER mdinfo does not support a discrete output cadence mapping");
  }

  const path = (role: "restart" | "trajectory" | "mdout" | "mdinfo") =>
    mapping.artifactPaths.outputs.find((binding) => binding.role === role)!.logicalPath;
  return {
    paths: {
      restart: path("restart"),
      ...(isMinimization ? {} : { trajectory: path("trajectory") }),
      mdout: path("mdout"),
      mdinfo: path("mdinfo"),
    },
    cadence: {
      restartEvery: restart.cadenceSteps,
      trajectoryEvery: trajectory?.cadenceSteps ?? 0,
      energiesEvery: mdout.cadenceSteps,
    },
  };
}

export { CLOSED_STAGE_OUTPUT_ROLE_BINDINGS, bindOutputs };
