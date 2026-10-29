import type { ContentAddressedArtifactStore } from "@eigengrid/mission-runtime";
import { canonicalJson, computeMdStageSpecDigest } from "@eigengrid/scientific-schema";
import {
  computeAmberCanonicalStageMappingDigest,
  computeCanonicalMdEnvironmentDigest,
  computeCanonicalMdExecutionBindingDigest,
  createAmberEnvironmentBinding,
  createAmberMdStageOperationRequest,
  renderCanonicalAmberStage,
  sha256Canonical,
} from "@eigengrid/amber-adapter";
import {
  adapterEnvironment,
  digest,
  executionBindingFor,
  snapshotBase,
} from "../../../../packages/amber-adapter/src/canonical-stage.fixture";
import { syntheticAmberBundleFixture } from "./amber-stage-bundle.fixture";

/** Synthetic contract fixture only; byte inputs are not valid molecular data. */
export const SYNTHETIC_PMEMD_CUDA_SHA256 = digest("a");

export async function syntheticGpuAmberSeed(
  store: ContentAddressedArtifactStore,
  resourceProfile: { cpuCores?: number; memoryBytes?: number; scratchBytes?: number } = {},
) {
  const { seed } = await syntheticAmberBundleFixture(store, {
    resourceProfile: { ...resourceProfile, backendCapabilityId: "slurm-gpu-fixture" },
  });
  seed.stage.resourceProfile.gpuCount = 1;
  seed.stage.stageDigest = computeMdStageSpecDigest(seed.stage);
  const observations = adapterEnvironment.observations.map((observation) =>
    observation.executable === "pmemd.cuda"
      ? {
          executable: "pmemd.cuda",
          available: true,
          version: "24",
          binarySha256: SYNTHETIC_PMEMD_CUDA_SHA256,
          gpu: true,
        }
      : observation,
  );
  const observedEnvironment = {
    ...adapterEnvironment,
    observations,
    environmentDigest: sha256Canonical(observations),
    capabilities: { ...adapterEnvironment.capabilities, gpuMd: true },
  };
  const snapshotBaseForGpu = {
    ...snapshotBase,
    engine: {
      ...snapshotBase.engine,
      executable: "pmemd.cuda",
      buildDigest: SYNTHETIC_PMEMD_CUDA_SHA256,
      environmentDigest: observedEnvironment.environmentDigest,
    },
  };
  const snapshot = {
    ...snapshotBaseForGpu,
    environmentDigest: computeCanonicalMdEnvironmentDigest(snapshotBaseForGpu),
  };
  const environment = createAmberEnvironmentBinding(snapshot, observedEnvironment, "pmemd.cuda");
  const executionBinding = executionBindingFor(seed.stage);
  const mappingBase = {
    ...seed.mapping,
    canonicalStage: { ...seed.mapping.canonicalStage, stageDigest: seed.stage.stageDigest },
    canonicalWorkUnit: {
      ...seed.mapping.canonicalWorkUnit,
      bindingDigest: computeCanonicalMdExecutionBindingDigest(executionBinding),
    },
    environment,
    engineSelection: { engine: "pmemd.cuda" as const },
  };
  const mapping = {
    ...mappingBase,
    mappingDigest: computeAmberCanonicalStageMappingDigest(mappingBase),
  };
  const rendered = renderCanonicalAmberStage(seed.stage, mapping, executionBinding, seed.atomMap);
  const request = createAmberMdStageOperationRequest(rendered, environment, {
    workUnitId: seed.request.workUnitId,
    bindingDigest: mapping.canonicalWorkUnit.bindingDigest,
    outputContractDigest: seed.request.outputContractDigest,
  });
  // Force serialization once here so malformed synthetic fixture metadata fails at setup.
  canonicalJson(request);
  return { ...seed, executionBinding, mapping, request };
}
