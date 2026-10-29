import { assertMdStageSpecDigest } from "@eigengrid/scientific-schema";
import { sha256Canonical } from "./canonical";
import { renderMdin } from "./mdin";
import { renderMdStageCommand } from "./stage";
import {
  AMBER_CANONICAL_STAGE_RENDER_SCHEMA_VERSION,
  RenderedCanonicalAmberStageSchema,
  type RenderedCanonicalAmberStage,
} from "./canonical-stage/schemas";
import {
  assertAmberCanonicalStageMappingDigest,
  assertCanonicalIdentity,
  assertExecutionBinding,
  computeAmberCanonicalStageMappingDigest,
  computeCanonicalMdExecutionBindingDigest,
} from "./canonical-stage/identity";
import { assertDecisionBindings } from "./canonical-stage/decisions";
import { bindCanonicalAtomMap, bindInputs } from "./canonical-stage/inputs";
import { bindOutputs, mapAmberStageCommandOutputRoles } from "./canonical-stage/outputs";
import {
  adapterStage,
  assertEngineResourceCompatibility,
  assertNoUnboundMaterialMappings,
} from "./canonical-stage/controls";

export * from "./canonical-stage/schemas";
export {
  assertAmberCanonicalStageMappingDigest,
  computeAmberCanonicalStageMappingDigest,
  computeCanonicalMdExecutionBindingDigest,
  mapAmberStageCommandOutputRoles,
};

export function computeRenderedCanonicalAmberStageDigest(
  value: Omit<RenderedCanonicalAmberStage, "renderDigest">,
): string {
  return sha256Canonical(value);
}

export function assertRenderedCanonicalAmberStageDigest(
  value: unknown,
): RenderedCanonicalAmberStage {
  const rendered = RenderedCanonicalAmberStageSchema.parse(value) as RenderedCanonicalAmberStage;
  const { renderDigest: _renderDigest, ...withoutDigest } = rendered;
  const observed = computeRenderedCanonicalAmberStageDigest(withoutDigest);
  if (rendered.renderDigest !== observed) {
    throw new Error(
      `Canonical AMBER render digest mismatch: expected ${rendered.renderDigest}, observed ${observed}`,
    );
  }
  return rendered;
}

/**
 * Pure, render-only mapping. It neither resolves host paths nor starts an AMBER
 * executable. Unsupported scientific controls fail closed instead of falling back.
 */
export function renderCanonicalAmberStage(
  stageValue: unknown,
  mappingValue: unknown,
  executionBindingValue: unknown,
  canonicalAtomMapValue: unknown,
): RenderedCanonicalAmberStage {
  const stage = assertMdStageSpecDigest(stageValue);
  const mapping = assertAmberCanonicalStageMappingDigest(mappingValue);
  assertCanonicalIdentity(stage, mapping);
  const executionBinding = assertExecutionBinding(stage, mapping, executionBindingValue);
  const verifiedDecisionIdentities = assertDecisionBindings(
    stage,
    mapping,
    executionBinding.parameters,
  );
  assertEngineResourceCompatibility(stage, mapping);
  assertNoUnboundMaterialMappings(stage);
  const atomMapView = bindCanonicalAtomMap(stage, mapping, canonicalAtomMapValue);
  const { topology, state } = bindInputs(stage, mapping, executionBinding.parameters);
  const outputs = bindOutputs(stage, mapping);
  const mappedStage = adapterStage(
    stage,
    mapping,
    executionBinding.parameters,
    verifiedDecisionIdentities,
    outputs.cadence,
    atomMapView.atomCount,
    atomMapView.entries,
  );
  const renderedMdin = renderMdin(mappedStage, mapping.artifactPaths.mdin);
  const referenceCoordinates =
    mapping.artifactPaths.referenceArtifactId === null ? undefined : state;
  const commandRequest = renderMdStageCommand({
    kind: stage.kind,
    engine: mapping.engineSelection.engine,
    topology,
    coordinates: state,
    mdin: renderedMdin,
    ...(referenceCoordinates ? { referenceCoordinates } : {}),
    outputs: outputs.paths,
    cwd: mapping.artifactPaths.cwd,
  });
  const outputRoleMapping = mapAmberStageCommandOutputRoles(commandRequest);
  const withoutDigest: Omit<RenderedCanonicalAmberStage, "renderDigest"> = {
    schemaVersion: AMBER_CANONICAL_STAGE_RENDER_SCHEMA_VERSION,
    canonicalStage: {
      id: stage.id,
      revision: stage.revision,
      kind: stage.kind,
      stageDigest: stage.stageDigest,
    },
    mapping: {
      version: mapping.mappingVersion,
      digest: mapping.mappingDigest,
    },
    executionBindingDigest: executionBinding.bindingDigest,
    environmentBindingDigest: mapping.environment.bindingDigest,
    renderedMdin,
    commandRequest,
    outputRoleMapping,
    runtimeBindings: {
      sequence: stage.sequence,
      parentStageId: stage.parentStageId,
      parentRestart: executionBinding.parameters.parentRestart ?? null,
      system: stage.system,
      resourceProfile: stage.resourceProfile,
      checkpoint: stage.checkpoint,
      acceptanceCriteria: stage.acceptanceCriteria,
      outputs: stage.outputs,
      sourceDecisionRefs: stage.sourceDecisionRefs,
      replicaSegment: executionBinding.parameters.replicaSegment ?? null,
      atomMapView,
    },
  };
  const rendered = {
    ...withoutDigest,
    renderDigest: computeRenderedCanonicalAmberStageDigest(withoutDigest),
  };
  return assertRenderedCanonicalAmberStageDigest(rendered);
}
