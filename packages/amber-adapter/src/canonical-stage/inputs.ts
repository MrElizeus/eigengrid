import {
  type MdArtifactReference,
  type MdExecutionBindingParameters,
  type MdStageSpec as CanonicalMdStageSpec,
} from "@eigengrid/scientific-schema";
import { deriveAmberAtomMapView, type AmberAtomMapView } from "../atom-map";
import type { CommandInput } from "../contracts";
import type { AmberCanonicalStageMapping } from "./schemas";

function bindCanonicalAtomMap(
  stage: CanonicalMdStageSpec,
  mapping: AmberCanonicalStageMapping,
  atomMapValue: unknown,
): AmberAtomMapView {
  const view = deriveAmberAtomMapView(atomMapValue, stage.system.atomMapDigest);
  if (
    mapping.canonicalAtomMap.id !== view.canonicalAtomMap.id ||
    mapping.canonicalAtomMap.revision !== view.canonicalAtomMap.revision ||
    mapping.canonicalAtomMap.mapDigest !== view.canonicalAtomMap.mapDigest ||
    mapping.canonicalAtomMap.viewVersion !== view.viewVersion
  ) {
    throw new Error("AMBER mapping AtomMap identity does not match the canonical scientific map");
  }
  if (
    view.systemManifestId !== stage.system.id ||
    view.systemManifestRevision !== stage.system.revision ||
    view.topologyDigest !== stage.system.topologyDigest ||
    view.coordinateDigest !== stage.system.coordinateDigest
  ) {
    throw new Error("Canonical AtomMap does not belong to the exact stage system revision");
  }
  return view;
}

function canonicalState(
  stage: CanonicalMdStageSpec,
  executionBinding: MdExecutionBindingParameters,
): MdArtifactReference {
  if (stage.sequence === 1) {
    const coordinates = stage.inputs.find((input) => input.role === "coordinates");
    if (!coordinates) throw new Error("Initial canonical stage is missing coordinates");
    if (executionBinding.parentRestart !== undefined) {
      throw new Error("Initial execution binding cannot inject a parent restart");
    }
    return coordinates;
  }
  if (executionBinding.parentRestart === undefined) {
    throw new Error("Downstream execution requires the exact parent restart artifact");
  }
  if (stage.inputs.some((input) => ["coordinates", "parent_restart"].includes(input.role))) {
    throw new Error("Downstream canonical stages cannot embed a planned state artifact");
  }
  return executionBinding.parentRestart;
}

function bindInputs(
  stage: CanonicalMdStageSpec,
  mapping: AmberCanonicalStageMapping,
  executionBinding: MdExecutionBindingParameters,
): { topology: CommandInput; state: CommandInput } {
  const supportedRoles = new Set(["topology", ...(stage.sequence === 1 ? ["coordinates"] : [])]);
  const expectedStageInputCount = stage.sequence === 1 ? 2 : 1;
  if (
    stage.inputs.length !== expectedStageInputCount ||
    stage.inputs.some((input) => !supportedRoles.has(input.role))
  ) {
    throw new Error(
      "Canonical AMBER rendering requires topology plus initial coordinates; downstream state belongs to the execution binding",
    );
  }
  const bindings = mapping.artifactPaths.inputs;
  const stateArtifact = canonicalState(stage, executionBinding);
  const effectiveInputs =
    stage.sequence === 1
      ? stage.inputs
      : [...stage.inputs, { ...stateArtifact, role: "parent_restart" as const }];
  const bindingIds = new Set(bindings.map((binding) => binding.artifactId));
  if (bindingIds.size !== bindings.length) throw new Error("Duplicate AMBER input path binding");
  for (const input of effectiveInputs) {
    const binding = bindings.find((candidate) => candidate.artifactId === input.artifactId);
    if (!binding || binding.role !== input.role || binding.contentDigest !== input.contentDigest) {
      throw new Error(`AMBER input binding does not match canonical artifact ${input.artifactId}`);
    }
  }
  if (
    bindings.some(
      (binding) => !effectiveInputs.some((input) => input.artifactId === binding.artifactId),
    )
  ) {
    throw new Error("AMBER input path binding contains a non-canonical artifact");
  }
  const topologyArtifact = stage.inputs.find((input) => input.role === "topology")!;
  const topologyBinding = bindings.find(
    (binding) => binding.artifactId === topologyArtifact.artifactId,
  )!;
  const stateBinding = bindings.find((binding) => binding.artifactId === stateArtifact.artifactId)!;
  return {
    topology: {
      role: "topology.prmtop",
      logicalPath: topologyBinding.logicalPath,
      mediaType: topologyArtifact.mediaType,
      sha256: topologyArtifact.contentDigest,
    },
    state: {
      role: "coordinates.input",
      logicalPath: stateBinding.logicalPath,
      mediaType: stateArtifact.mediaType,
      sha256: stateArtifact.contentDigest,
    },
  };
}

export { bindCanonicalAtomMap, bindInputs };
export { canonicalState };
