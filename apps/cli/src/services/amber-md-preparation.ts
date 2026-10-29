import { lstat } from "node:fs/promises";
import { z } from "zod";
import {
  AmberCanonicalStageMappingSchema,
  renderCanonicalAmberStage,
  createAmberMdStageOperationRequest,
} from "@eigengrid/amber-adapter";
import {
  IdSchema,
  MdExecutionBindingParametersSchema,
  digestCanonical,
} from "@eigengrid/scientific-schema";
import {
  ContentAddressedArtifactStore,
  MdPreparationPublicationStore,
  type MdProjectionStore,
  type ScientificStore,
} from "@eigengrid/mission-runtime";
import { AmberPreparationPublicationService } from "./amber-preparation-publication";
import { publishAmberStageBundle, copyAmberStageBundle } from "./amber-stage-bundle";
import type { HeadMdSiteAuthorityReader } from "./head-md-site-authority";

export const AmberMdPreparationRequestSchema = z
  .object({
    projectId: IdSchema,
    missionId: IdSchema,
    workUnitId: IdSchema,
    mapping: AmberCanonicalStageMappingSchema,
  })
  .strict();

/** No scheduler effects. The protected site selects the writable namespace;
 * the request can only map an already approved, durable canonical stage. */
export async function publishApprovedMdPreparation(
  value: unknown,
  deps: {
    store: Pick<ScientificStore, "getWorkUnit">;
    mdStore: Pick<MdProjectionStore, "getAtomMap"> & {
      getProtocol: (
        ...args: Parameters<MdProjectionStore["getProtocol"]>
      ) => Promise<{ stages: import("@eigengrid/scientific-schema").MdStageSpec[] } | null>;
    };
    artifacts: ContentAddressedArtifactStore;
    publications: Pick<MdPreparationPublicationStore, "authorize" | "publish" | "resolve">;
    siteAuthority: Pick<HeadMdSiteAuthorityReader, "resolvePublication">;
    policyDigest: string;
    assertAccess: (address: { projectId: string; missionId: string }) => Promise<void>;
  },
) {
  const input = AmberMdPreparationRequestSchema.parse(value);
  await deps.assertAccess({ projectId: input.projectId, missionId: input.missionId });
  const work = await deps.store.getWorkUnit(input.workUnitId);
  if (!work || work.missionId !== input.missionId)
    throw new Error("MD preparation WorkUnit is outside this mission");
  const binding = MdExecutionBindingParametersSchema.parse(work.protocolFragment.parameters);
  const protocol = await deps.mdStore.getProtocol(binding.protocol.id, binding.protocol.revision);
  const stage = protocol?.stages.find(
    (item) => item.id === binding.stage.id && item.stageDigest === binding.stage.digest,
  );
  const atomMap = await deps.mdStore.getAtomMap(
    input.missionId,
    input.mapping.canonicalAtomMap.id,
    input.mapping.canonicalAtomMap.revision,
  );
  if (!stage || !atomMap) throw new Error("MD preparation lacks a durable stage or AtomMap");
  const rendered = renderCanonicalAmberStage(stage, input.mapping, binding, atomMap);
  const request = createAmberMdStageOperationRequest(rendered, input.mapping.environment, {
    workUnitId: work.id,
    bindingDigest: digestCanonical(binding),
    outputContractDigest: digestCanonical(work.outputContract),
  });
  const at = new Date().toISOString();
  const authorized = await deps.publications.authorize(work.id, {
    request,
    at,
    currentPolicyDigest: deps.policyDigest,
  });
  if (authorized.association.projectId !== input.projectId)
    throw new Error("MD preparation project differs from authority");
  const association = { subject: authorized.association.ownerUserId, projectId: input.projectId };
  const authority = deps.siteAuthority.resolvePublication(association);
  if (authority.grant.currentPolicyDigest !== deps.policyDigest)
    throw new Error("MD publication policy changed");
  const bundle = await publishAmberStageBundle(deps.artifacts, {
    stage,
    mapping: input.mapping,
    executionBinding: binding,
    atomMap,
    request,
  });
  await deps.assertAccess({ projectId: input.projectId, missionId: input.missionId });
  const provisioned = await lstat(authority.publicationRoot);
  if (
    !provisioned.isDirectory() ||
    provisioned.isSymbolicLink() ||
    provisioned.uid !== process.getuid?.() ||
    (provisioned.mode & 0o7777) !== 0o2750
  )
    throw new Error("MD publication requires a preprovisioned group-readable setgid CAS");
  const destination = new ContentAddressedArtifactStore(authority.publicationRoot, {
    publicationGroup: provisioned.gid,
  });
  try {
    await destination.init();
    await copyAmberStageBundle(deps.artifacts, destination, bundle.reference, request);
    if (
      digestCanonical(deps.siteAuthority.resolvePublication(association)) !==
      digestCanonical(authority)
    )
      throw new Error("Protected MD publication authority changed");
    return await new AmberPreparationPublicationService(
      deps.publications,
      deps.siteAuthority,
      deps.policyDigest,
      undefined,
      deps.artifacts,
    ).registerPublished({ workUnitId: work.id, reference: bundle.reference, request });
  } finally {
    await destination.close();
  }
}
