import type {
  MdExecutionBindingParameters,
  MdStageSpec as CanonicalMdStageSpec,
} from "@eigengrid/scientific-schema";
import type { AmberCanonicalStageMapping, AmberMappingDecisionBinding } from "./schemas";

function mappingDecisionIdentity(decision: AmberMappingDecisionBinding): string {
  return `${decision.id}\0${decision.revision}\0${decision.decisionDigest}\0${decision.approvalRef}`;
}

function canonicalDecisionIdentity(
  decision: MdExecutionBindingParameters["decisions"][number],
): string {
  return `${decision.id}\0${decision.revision}\0${decision.decisionDigest}\0${decision.approvalRef}`;
}

function assertDecisionBindings(
  stage: CanonicalMdStageSpec,
  mapping: AmberCanonicalStageMapping,
  executionBinding: MdExecutionBindingParameters,
): Set<string> {
  const bindings = [
    ...(mapping.schemaVersion === "eigengrid.amber-canonical-stage-mapping/v3" &&
    mapping.minimizationSplit
      ? [mapping.minimizationSplit.decision]
      : []),
    ...mapping.restraintMasks.map((binding) => binding.decision),
    ...(mapping.membranePressure ? [mapping.membranePressure.decision] : []),
  ];
  if (
    mapping.schemaVersion === "eigengrid.amber-canonical-stage-mapping/v4" &&
    mapping.minimizationSplit
  ) {
    const split = mapping.minimizationSplit;
    const protocol = executionBinding.protocol;
    const boundStage = executionBinding.stage;
    if (
      split.protocol.id !== protocol.id ||
      split.protocol.revision !== protocol.revision ||
      split.protocol.digest !== protocol.digest ||
      split.protocol.approvalRef !== protocol.approvalRef ||
      split.stage.id !== boundStage.id ||
      split.stage.revision !== boundStage.revision ||
      split.stage.digest !== boundStage.digest ||
      split.stage.id !== stage.id ||
      split.stage.revision !== stage.revision ||
      split.stage.digest !== stage.stageDigest
    )
      throw new Error(
        "AMBER minimization split lacks the exact protocol and stage approval binding",
      );
  }
  const exactById = new Map(executionBinding.decisions.map((decision) => [decision.id, decision]));
  for (const decisionId of new Set(stage.sourceDecisionRefs)) {
    if (!exactById.has(decisionId)) {
      throw new Error(
        `Canonical WorkUnit binding has no exact decision reference for stage decision ${decisionId}`,
      );
    }
  }
  const verified = new Set<string>();
  for (const binding of bindings) {
    if (!stage.sourceDecisionRefs.includes(binding.id)) {
      throw new Error(
        `AMBER mapping decision ${binding.id} is absent from stage.sourceDecisionRefs`,
      );
    }
    const canonical = exactById.get(binding.id);
    if (
      canonical === undefined ||
      canonicalDecisionIdentity(canonical) !== mappingDecisionIdentity(binding)
    ) {
      throw new Error(
        `AMBER mapping decision ${binding.id} does not match the WorkUnit revision, digest, and approval`,
      );
    }
    verified.add(mappingDecisionIdentity(binding));
  }
  return verified;
}

export { assertDecisionBindings, mappingDecisionIdentity };
