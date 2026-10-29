import type { ContentAddressedArtifactStore } from "@eigengrid/mission-runtime";
import {
  assertMdStageSpecDigest,
  computeAtomMapDigest,
  computeMdStageSpecDigest,
  type MdStageSpec,
} from "@eigengrid/scientific-schema";
import {
  AmberCanonicalStageMappingSchema,
  computeAmberCanonicalStageMappingDigest,
  computeCanonicalMdExecutionBindingDigest,
  createAmberMdStageOperationRequest,
  renderCanonicalAmberStage,
} from "@eigengrid/amber-adapter";
import {
  canonicalAtomMap,
  digest,
  executionBindingFor,
  explicitMinimization,
  reviewedSander26Environment,
  signedStage,
  signedMapping,
  unsignedMapping,
} from "../../../../packages/amber-adapter/src/canonical-stage.fixture";

/** Byte fixtures deliberately are NOT valid molecular topology or coordinates.
 * Tests qualify integrity/authority, not Amber execution or scientific QC.
 */
export async function syntheticAmberBundleFixture(
  store: ContentAddressedArtifactStore,
  options: {
    atomCount?: number;
    largeInput?: boolean;
    continuation?: boolean;
    resourceProfile?: Partial<MdStageSpec["resourceProfile"]>;
  } = {},
) {
  const topology = await store.put(
    options.largeInput
      ? Buffer.alloc(5 * 1024 * 1024, 65)
      : Buffer.from("synthetic topology bytes\n"),
  );
  const coordinates = await store.put(Buffer.from("synthetic coordinate bytes\n"));
  const initial = explicitMinimization();
  const originalStage = assertMdStageSpecDigest(
    options.continuation ? signedStage() : initial.stage,
  );
  const originalMapping = AmberCanonicalStageMappingSchema.parse(
    options.continuation ? signedMapping(unsignedMapping(originalStage)) : initial.mapping,
  );
  const parent = options.continuation
    ? await store.put(Buffer.from("synthetic parent checkpoint bytes\n"))
    : undefined;
  const atomBase = {
    ...structuredClone(canonicalAtomMap),
    topologyDigest: topology.digest,
    coordinateDigest: coordinates.digest,
    ...(options.atomCount
      ? {
          atomCount: options.atomCount,
          entries: Array.from({ length: options.atomCount }, (_, index) => ({
            ...canonicalAtomMap.entries[0]!,
            systemAtomIndex: index + 1,
            componentAtomIndex: index + 1,
          })),
        }
      : {}),
  };
  const atomMap = { ...atomBase, mapDigest: computeAtomMapDigest(atomBase) };
  const stageBase = {
    ...originalStage,
    resourceProfile: { ...originalStage.resourceProfile, ...options.resourceProfile },
    system: {
      ...originalStage.system,
      topologyDigest: topology.digest,
      coordinateDigest: coordinates.digest,
      atomMapDigest: atomMap.mapDigest,
    },
    inputs: originalStage.inputs.map((input) => ({
      ...input,
      contentDigest: input.role === "topology" ? topology.digest : coordinates.digest,
    })),
  };
  const stage = { ...stageBase, stageDigest: computeMdStageSpecDigest(stageBase) };
  const initialBinding = executionBindingFor(stage);
  const executionBinding = parent
    ? {
        ...initialBinding,
        parentRestart: { ...initialBinding.parentRestart!, contentDigest: parent.digest },
      }
    : initialBinding;
  // Parse through the renderer's closed schema below; the historical fixture's
  // generic mapping type is intentional so its existing adversarial tests work.
  const mappingBase = {
    ...originalMapping,
    canonicalStage: {
      id: stage.id,
      revision: stage.revision,
      kind: stage.kind,
      stageDigest: stage.stageDigest,
      rendererCompatibilityVersion: stage.rendererCompatibilityVersion,
    },
    canonicalWorkUnit: {
      bindingDigest: computeCanonicalMdExecutionBindingDigest(executionBinding),
      plan: executionBinding.plan,
      system: executionBinding.system,
      protocol: executionBinding.protocol,
    },
    canonicalAtomMap: {
      id: atomMap.id,
      revision: atomMap.revision,
      mapDigest: atomMap.mapDigest,
      viewVersion: "1.0.0",
    },
    environment: reviewedSander26Environment(),
    artifactPaths: {
      ...originalMapping.artifactPaths,
      inputs: [
        {
          artifactId: "topology",
          role: "topology",
          contentDigest: topology.digest,
          logicalPath: "inputs/system.prmtop",
        },
        {
          artifactId: parent ? "parent-restart" : "coordinates",
          role: parent ? "parent_restart" : "coordinates",
          contentDigest: parent?.digest ?? coordinates.digest,
          logicalPath: parent ? "inputs/parent.rst7" : "inputs/system.rst7",
        },
      ],
    },
  };
  const mapping = {
    ...mappingBase,
    mappingDigest: computeAmberCanonicalStageMappingDigest(mappingBase),
  };
  const rendered = renderCanonicalAmberStage(stage, mapping, executionBinding, atomMap);
  const request = createAmberMdStageOperationRequest(rendered, mapping.environment, {
    workUnitId: "work-unit-bundle-1",
    bindingDigest: mapping.canonicalWorkUnit.bindingDigest,
    outputContractDigest: digest("e"),
  });
  return {
    topology,
    coordinates,
    seed: { stage, mapping, executionBinding, atomMap, request },
  };
}
