import {
  ContentAddressedArtifactStore,
  MdPreparationPublicationStore,
  MdPreparationManifestSchema,
  assertMdStageOperationRequestAuthority,
  type ScientificDatabase,
} from "@eigengrid/mission-runtime";
import {
  DigestSchema,
  IdSchema,
  MdStageOperationRequestSchema,
  WorkUnitSchema,
  canonicalJson,
  type MdStageOperationRequest,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import {
  AmberBundleReferenceSchema,
  AmberStageBundleSchema,
  readAmberStageBundle,
  copyAmberStageBundle,
  type VerifiedAmberStageBundle,
} from "./amber-stage-bundle";
import {
  createHeadMdSiteAuthorityReader,
  type HeadMdSiteAuthorityReader,
} from "./head-md-site-authority";
import type { CanonicalMdExecutionGateway } from "./md-driver-binding";
import { CanonicalMdStagePostprocessor } from "./md-stage-postprocessor";
import { createHeadMdPostprocessingAuthority } from "./head-md-postprocessing-authority";
import { CanonicalMdResultCollector } from "./md-result-collector";

type PublicationAuthority = ReturnType<HeadMdSiteAuthorityReader["resolvePublication"]>;
type PublicationStore = Pick<MdPreparationPublicationStore, "authorize" | "publish" | "resolve">;
type PublicationReader = Pick<HeadMdSiteAuthorityReader, "resolvePublication">;

function assertEnvironment(
  request: MdStageOperationRequest,
  authority: PublicationAuthority,
): void {
  const executable = request.environment.engine.executable;
  const expectedDigest =
    executable === "sander"
      ? authority.environment.sanderSha256
      : executable === "pmemd.cuda"
        ? authority.environment.pmemdCudaSha256
        : undefined;
  if (
    request.environment.engine.engine !== "amber" ||
    expectedDigest === undefined ||
    request.environment.engine.version !== authority.environment.amberVersion ||
    request.environment.binaryDigest !== expectedDigest ||
    request.environment.engineEnvironmentDigest !== authority.environment.engineEnvironmentDigest
  ) {
    throw new Error("Amber preparation differs from the currently provisioned engine tuple");
  }
}

/** Only application composition supplies these dependencies. The production
 * factory below constructs the PostgreSQL store and protected site reader; a
 * caller can never choose a filesystem root, UID, profile or CAS implementation.
 */
export class AmberPreparationPublicationService {
  private readonly policyDigest: string;

  constructor(
    private readonly publications: PublicationStore,
    private readonly siteAuthority: PublicationReader,
    currentPolicyDigest: string,
    private readonly now: () => Date = () => new Date(),
    private readonly privateObjects?: ContentAddressedArtifactStore,
  ) {
    this.policyDigest = DigestSchema.parse(currentPolicyDigest);
  }

  private context() {
    return { currentPolicyDigest: this.policyDigest, at: this.now().toISOString() };
  }

  private authority(association: { ownerUserId: string; projectId: string }): PublicationAuthority {
    const result = this.siteAuthority.resolvePublication({
      subject: association.ownerUserId,
      projectId: association.projectId,
    });
    if (result.grant.currentPolicyDigest !== this.policyDigest)
      throw new Error("Head policy differs from current protected publication authority");
    return result;
  }

  private assertUnchanged(
    association: { ownerUserId: string; projectId: string },
    initial: PublicationAuthority,
  ): void {
    if (canonicalJson(this.authority(association)) !== canonicalJson(initial))
      throw new Error("Protected Amber publication authority changed during artifact verification");
  }

  private async read(
    authority: PublicationAuthority,
    reference: unknown,
    request: MdStageOperationRequest,
  ): Promise<VerifiedAmberStageBundle> {
    assertEnvironment(request, authority);
    const reader = new ContentAddressedArtifactStore(authority.publicationRoot, {
      access: "read-only",
    });
    try {
      await reader.init();
      return this.privateObjects
        ? await copyAmberStageBundle(reader, this.privateObjects, reference, request)
        : await readAmberStageBundle(reader, reference, request);
    } finally {
      await reader.close();
    }
  }

  /** Register an already published, completely verified bundle before admission.
   * Publication writers continue to use publishAmberStageBundle/copyAmberStageBundle
   * in their site-authorized namespace. This method neither creates directories
   * nor grants write access to that namespace. Metadata alone cannot register an
   * absent, corrupt or noncanonical bundle.
   */
  async registerPublished(input: { workUnitId: string; reference: unknown; request: unknown }) {
    const workUnitId = IdSchema.parse(input.workUnitId);
    const reference = AmberBundleReferenceSchema.parse(input.reference);
    const request = MdStageOperationRequestSchema.parse(input.request);
    const authorized = await this.publications.authorize(workUnitId, {
      ...this.context(),
      request,
    });
    const association = authorized.association;
    const authority = this.authority(association);
    const verified = await this.read(authority, reference, request);
    assertMdStageOperationRequestAuthority(authorized.workUnit, verified.manifest.request);
    if (
      canonicalJson(verified.manifest.stage) !== canonicalJson(authorized.stage) ||
      canonicalJson(verified.manifest.executionBinding) !==
        canonicalJson(authorized.workUnit.protocolFragment.parameters)
    ) {
      throw new Error("Published Amber preparation differs from the authorized durable projection");
    }
    this.assertUnchanged(association, authority);
    const result = await this.publications.publish({
      ...this.context(),
      workUnitId,
      bundle: verified.reference,
      manifest: MdPreparationManifestSchema.parse(verified.manifest),
    });
    this.assertUnchanged(association, authority);
    return result;
  }

  /** The sole production prepareBundle implementation. Resolve authority before
   * any filesystem access, rehash the consumed bytes, reconstruct the renderer,
   * then revalidate DB and protected site authority after potentially slow I/O.
   * No cached bundle survives a policy, approval, membership or material change.
   */
  async prepareBundle(workUnitValue: WorkUnit): Promise<VerifiedAmberStageBundle> {
    const workUnit = WorkUnitSchema.parse(workUnitValue);
    const publication = await this.publications.resolve(workUnit.id, this.context());
    if (!publication) throw new Error("WorkUnit has no durable MD preparation publication");
    if (publication.missionId !== workUnit.missionId)
      throw new Error("MD preparation belongs to another mission");
    const manifest = AmberStageBundleSchema.parse(publication.manifest);
    assertMdStageOperationRequestAuthority(workUnit, manifest.request);
    const authority = this.authority(publication);
    const verified = await this.read(authority, publication.bundle, manifest.request);
    if (canonicalJson(verified.manifest) !== canonicalJson(manifest))
      throw new Error("Amber bundle bytes differ from the immutable preparation publication");
    const after = await this.publications.resolve(workUnit.id, this.context());
    if (!after || canonicalJson(after) !== canonicalJson(publication))
      throw new Error("Durable MD preparation changed during artifact verification");
    this.assertUnchanged(publication, authority);
    return verified;
  }
}

/** Production wiring accepts only service configuration. The returned gateway
 * uses the existing canonical driver, admission, signer and submitter client.
 * It does not enable dispatch or create another execution lifecycle.
 */
export function createHeadMdExecutionGateway(input: {
  database: ScientificDatabase;
  siteAuthorityConfigPath: string;
  currentPolicyDigest: string;
  /** Service-owned private CAS, never a user/project publication namespace. */
  artifactRoot: string;
  postprocessingConfigPath?: string;
  now?: () => Date;
}): CanonicalMdExecutionGateway {
  if (input.database._provider !== "postgres")
    throw new Error("The canonical Head MD gateway requires PostgreSQL");
  const siteAuthority = createHeadMdSiteAuthorityReader(input.siteAuthorityConfigPath);
  const postprocessing = input.postprocessingConfigPath
    ? createHeadMdPostprocessingAuthority(input.postprocessingConfigPath, input.currentPolicyDigest)
    : undefined;
  async function withObjects<T>(
    work: (objects: ContentAddressedArtifactStore) => Promise<T>,
  ): Promise<T> {
    const objects = new ContentAddressedArtifactStore(input.artifactRoot);
    try {
      await objects.init();
      return await work(objects);
    } finally {
      await objects.close();
    }
  }
  return {
    database: input.database,
    siteAuthority,
    ...(postprocessing
      ? {
          postprocessResult: (operationId: string, ownerId: string, signal?: AbortSignal) =>
            withObjects(async (objects) => {
              const authority = postprocessing.resolve();
              return new CanonicalMdStagePostprocessor({
                database: input.database,
                objects,
                ...authority,
                now: input.now,
                assertAuthorityCurrent: authority.assertCurrent,
              }).process(operationId, ownerId, signal);
            }),
        }
      : {}),
    prepareBundle: (workUnit) =>
      withObjects((objects) =>
        new AmberPreparationPublicationService(
          new MdPreparationPublicationStore(input.database, input.now),
          siteAuthority,
          input.currentPolicyDigest,
          input.now,
          objects,
        ).prepareBundle(workUnit),
      ),
    collectResult: (operationId, signal) =>
      withObjects((objects) =>
        new CanonicalMdResultCollector({
          database: input.database,
          objects,
          siteAuthority,
          now: input.now,
        }).collect(operationId, signal),
      ),
  };
}
