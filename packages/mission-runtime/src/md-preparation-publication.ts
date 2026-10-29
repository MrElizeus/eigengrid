import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DigestSchema,
  IdSchema,
  MdExecutionBindingParametersSchema,
  MdStageOperationRequestSchema,
  MdStageSpecSchema,
  ScientificMissionSchema,
  TimestampSchema,
  WorkUnitSchema,
  assertAtomMapDigest,
  assertMdEnvironmentCapabilitySnapshotDigest,
  canonicalJson,
  digestCanonical,
  type AtomMap,
  type ApprovalRequest,
  type MdStageSpec,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import { assertMdWorkUnitScientificAuthority } from "./md-effect-authority";
import {
  assertMissionProjectCreationAuthority,
  readScientificMissionProjectAssociation,
  type ScientificMissionProjectAssociation,
} from "./mission-project";
import { ScientificEntityConflictError, ScientificIntegrityError } from "./errors";
import type { ScientificDatabase, ScientificTransaction } from "./types";

const positiveSize = z.number().int().positive().safe();
const objectReference = z
  .object({ sha256: DigestSchema, sizeBytes: positiveSize.max(1024 ** 3) })
  .strict();
const logicalPath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      ![...value].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  );
const publicationInput = z
  .object({
    mediaType: z.string().regex(/^[a-z0-9.+-]+\/[a-zA-Z0-9.+-]+$/u),
    role: z.enum(["topology.prmtop", "coordinates.input", "stage.mdin"]),
    logicalPath,
    sha256: DigestSchema,
    sizeBytes: positiveSize.max(1024 ** 3),
  })
  .strict();

/** Adapter-owned mapping remains inert JSON here. The application must parse and
 * reconstruct it with its versioned adapter before publication and dispatch. */
export const MdPreparationManifestSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.amber-stage-bundle/v1"),
    stage: MdStageSpecSchema,
    mapping: z.record(z.unknown()),
    executionBinding: MdExecutionBindingParametersSchema,
    request: MdStageOperationRequestSchema,
    atomMap: objectReference.extend({ sizeBytes: positiveSize.max(64 * 1024 ** 2) }),
    inputs: z.array(publicationInput).length(3),
  })
  .strict();
export type MdPreparationManifest = z.infer<typeof MdPreparationManifestSchema>;
export const MdPreparationPublicationSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.md-preparation-publication/v1"),
    workUnitId: IdSchema,
    missionId: IdSchema,
    projectId: IdSchema,
    ownerUserId: IdSchema,
    associationDigest: DigestSchema,
    bindingDigest: DigestSchema,
    requestDigest: DigestSchema,
    mappingDigest: DigestSchema,
    environmentBindingDigest: DigestSchema,
    inputEvidenceRefs: z.array(IdSchema),
    bundle: objectReference.extend({ sizeBytes: positiveSize.max(4 * 1024 ** 2) }),
    manifest: MdPreparationManifestSchema,
    createdAt: TimestampSchema,
    publicationDigest: DigestSchema,
  })
  .strict();
export type MdPreparationPublication = z.infer<typeof MdPreparationPublicationSchema>;
export interface MdPreparationAuthorityContext {
  currentPolicyDigest: string;
  at: string;
}
export interface MdPreparationAuthority {
  workUnit: WorkUnit;
  stage: MdStageSpec;
  association: ScientificMissionProjectAssociation;
}
export interface PublishMdPreparationInput extends MdPreparationAuthorityContext {
  workUnitId: string;
  bundle: MdPreparationPublication["bundle"];
  manifest: MdPreparationManifest;
}
type LockedAuthority = MdPreparationAuthority & { approvals: ApprovalRequest[] };
type Row = Record<string, unknown> & { payload_json: string };

function fail(message: string): never {
  throw new ScientificIntegrityError(message);
}
function exact(left: unknown, right: unknown, label: string): void {
  if (canonicalJson(left) !== canonicalJson(right))
    fail(`MD preparation ${label} differs from canonical authority`);
}
function columns(row: Row, expected: Record<string, unknown>): void {
  if (Object.entries(expected).some(([key, value]) => row[key] !== value))
    fail("MD preparation index differs from its immutable payload");
}
function reference(value: unknown): { sha256: string; sizeBytes: number } {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  return { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`MD preparation ${label} is not an object`);
  return value as Record<string, unknown>;
}
function selfDigest(value: Record<string, unknown>, field: string): string {
  const digest = DigestSchema.parse(value[field]);
  const rest = { ...value };
  delete rest[field];
  if (digestCanonical(rest) !== digest) fail(`MD preparation ${field} is invalid`);
  return digest;
}
function assertPublication(value: unknown): MdPreparationPublication {
  const result = MdPreparationPublicationSchema.parse(value);
  const { publicationDigest, ...unsigned } = result;
  if (digestCanonical(unsigned) !== publicationDigest)
    fail("MD preparation publication digest is invalid");
  exact(reference(result.manifest), result.bundle, "bundle identity");
  if (result.bundle.sizeBytes > 4 * 1024 ** 2)
    fail("MD preparation manifest exceeds its byte limit");
  return result;
}

/** A trusted application port, not a caller-supplied locator. PostgreSQL remains
 * authoritative; CAS contents are rehashed separately by the application. This
 * table grants no admission, lease, UID, filesystem root or execution permission. */
export class MdPreparationPublicationStore {
  constructor(
    private readonly database: ScientificDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private fence(authority: LockedAuthority): string {
    const at = TimestampSchema.parse(this.now().toISOString());
    for (const approval of authority.approvals) {
      if (
        Date.parse(approval.requestedAt) > Date.parse(at) ||
        (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.parse(at)) ||
        !approval.response ||
        Date.parse(approval.response.decidedAt) > Date.parse(at)
      )
        fail("MD preparation approval expired while waiting for authority locks");
    }
    return at;
  }

  private async transaction<T>(run: (tx: ScientificTransaction) => Promise<T>): Promise<T> {
    if (this.database._provider !== "postgres")
      fail("MD preparation publication requires PostgreSQL");
    const tx = (await this.database.beginTransaction()) as ScientificTransaction;
    try {
      const result = await run(tx);
      await tx.commit();
      return result;
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  private async authority(
    tx: ScientificTransaction,
    workUnitId: string,
    context: MdPreparationAuthorityContext & { request: unknown },
  ): Promise<LockedAuthority> {
    IdSchema.parse(workUnitId);
    TimestampSchema.parse(context.at);
    DigestSchema.parse(context.currentPolicyDigest);
    // Match the canonical aggregate lock order: mission, plan, WorkUnit.
    const [missionRow] = await tx.queryRows<Row>(
      "SELECT * FROM scientific_missions WHERE id = (SELECT mission_id FROM scientific_work_units WHERE id = $1) FOR UPDATE",
      [workUnitId],
    );
    if (!missionRow) fail("MD preparation mission/WorkUnit is missing");
    const mission = ScientificMissionSchema.parse(JSON.parse(missionRow.payload_json));
    columns(missionRow, {
      id: mission.id,
      revision: mission.revision,
      state: mission.state,
      active_plan_id: mission.activePlanId,
      payload_digest: digestCanonical(mission),
    });
    const [planRow] = await tx.queryRows<Row>(
      "SELECT * FROM scientific_plans WHERE id = (SELECT plan_id FROM scientific_work_units WHERE id = $1) FOR UPDATE",
      [workUnitId],
    );
    const [workUnitRow] = await tx.queryRows<Row>(
      "SELECT * FROM scientific_work_units WHERE id = $1 FOR UPDATE",
      [workUnitId],
    );
    if (!workUnitRow || !planRow) fail("MD preparation WorkUnit/plan is missing");
    const workUnit = WorkUnitSchema.parse(JSON.parse(workUnitRow.payload_json));
    columns(workUnitRow, {
      id: workUnit.id,
      mission_id: workUnit.missionId,
      plan_id: workUnit.planId,
      plan_version: workUnit.planVersion,
      state: workUnit.state,
      revision: workUnit.revision,
      payload_digest: digestCanonical(workUnit),
    });
    if (
      workUnit.id !== workUnitId ||
      workUnit.missionId !== mission.id ||
      mission.activePlanId !== workUnit.planId ||
      !["ready", "executing", "awaiting_approval"].includes(mission.state) ||
      !["created", "ready", "claimed", "awaiting_approval"].includes(workUnit.state)
    )
      fail("MD preparation requires an active plan and a pre-effect WorkUnit");
    const association = await readScientificMissionProjectAssociation(
      tx,
      mission.id,
      "postgres",
      true,
    );
    if (!association) fail("MD preparation lacks an immutable mission-project association");
    await assertMissionProjectCreationAuthority(
      tx,
      {
        mission,
        projectId: association.projectId,
        ownerUserId: association.ownerUserId,
      },
      "postgres",
    );
    const at = TimestampSchema.parse(this.now().toISOString());
    if (Date.parse(context.at) > Date.parse(at))
      fail("MD preparation caller timestamp exceeds its trusted authority clock");
    const { stage, approvals } = await assertMdWorkUnitScientificAuthority(tx, {
      ...context,
      at,
      workUnit,
      provider: "postgres",
    });
    const authority = { workUnit, stage, association, approvals };
    this.fence(authority);
    return authority;
  }

  async authorize(
    workUnitId: string,
    context: MdPreparationAuthorityContext & { request: unknown },
  ): Promise<MdPreparationAuthority> {
    const id = IdSchema.parse(workUnitId);
    const snapshot = {
      at: TimestampSchema.parse(context.at),
      currentPolicyDigest: DigestSchema.parse(context.currentPolicyDigest),
      request: MdStageOperationRequestSchema.parse(context.request),
    };
    return this.transaction(async (tx) => {
      const authority = await this.authority(tx, id, snapshot);
      this.fence(authority);
      return {
        workUnit: authority.workUnit,
        stage: authority.stage,
        association: authority.association,
      };
    });
  }

  private async assertManifest(
    tx: ScientificTransaction,
    authority: MdPreparationAuthority,
    manifest: MdPreparationManifest,
  ): Promise<void> {
    const { workUnit, stage } = authority;
    const binding = MdExecutionBindingParametersSchema.parse(workUnit.protocolFragment.parameters);
    exact(manifest.stage, stage, "stage");
    exact(manifest.executionBinding, binding, "execution binding");
    const mapping = manifest.mapping;
    if (selfDigest(mapping, "mappingDigest") !== manifest.request.render.mapperDigest)
      fail("MD preparation mapping is outside its exact request");
    const mappedWorkUnit = record(mapping.canonicalWorkUnit, "mapped WorkUnit");
    exact(
      mappedWorkUnit,
      {
        bindingDigest: digestCanonical(binding),
        plan: binding.plan,
        system: binding.system,
        protocol: binding.protocol,
      },
      "mapping plan/system/protocol",
    );
    exact(
      mapping.canonicalStage,
      {
        id: stage.id,
        revision: stage.revision,
        kind: stage.kind,
        stageDigest: stage.stageDigest,
        rendererCompatibilityVersion: stage.rendererCompatibilityVersion,
      },
      "mapping stage",
    );
    const environment = record(mapping.environment, "environment binding");
    if (selfDigest(environment, "bindingDigest") !== manifest.request.environment.bindingDigest)
      fail("MD preparation environment is outside its request");
    const snapshot = assertMdEnvironmentCapabilitySnapshotDigest(environment.canonicalSnapshot);
    exact(snapshot.engine, manifest.request.environment.engine, "environment engine");
    if (
      snapshot.id !== manifest.request.environment.canonicalSnapshotId ||
      snapshot.environmentDigest !== manifest.request.environment.canonicalSnapshotDigest ||
      environment.bindingVersion !== manifest.request.environment.bindingVersion
    )
      fail("MD preparation canonical environment snapshot changed");
    const mappedAtom = record(mapping.canonicalAtomMap, "AtomMap binding");
    const [atomRow] = await tx.queryRows<Row>(
      `SELECT * FROM scientific_atom_map_revisions WHERE mission_id = $1 AND system_manifest_id = $2
       AND system_manifest_revision = $3 AND id = $4 AND revision = $5 FOR UPDATE`,
      [
        workUnit.missionId,
        binding.system.id,
        binding.system.revision,
        mappedAtom.id,
        mappedAtom.revision,
      ],
    );
    if (!atomRow) fail("MD preparation exact AtomMap is missing");
    const atomMap: AtomMap = assertAtomMapDigest(JSON.parse(atomRow.payload_json));
    columns(atomRow, {
      id: atomMap.id,
      revision: atomMap.revision,
      map_digest: atomMap.mapDigest,
      topology_digest: atomMap.topologyDigest,
      coordinate_digest: atomMap.coordinateDigest,
      mission_id: workUnit.missionId,
      system_manifest_id: binding.system.id,
      system_manifest_revision: binding.system.revision,
    });
    if (
      mappedAtom.mapDigest !== atomMap.mapDigest ||
      atomMap.mapDigest !== stage.system.atomMapDigest ||
      atomMap.systemManifestId !== stage.system.id ||
      atomMap.systemManifestRevision !== stage.system.revision ||
      atomMap.topologyDigest !== stage.system.topologyDigest ||
      atomMap.coordinateDigest !== stage.system.coordinateDigest
    )
      fail("MD preparation mapped AtomMap differs from its durable material");
    exact(reference(atomMap), manifest.atomMap, "AtomMap CAS object");
    const roles = manifest.inputs.map((item) => item.role).sort();
    exact(roles, ["coordinates.input", "stage.mdin", "topology.prmtop"], "closed input roles");
    const topology = manifest.inputs.find((item) => item.role === "topology.prmtop")!;
    const coordinates = manifest.inputs.find((item) => item.role === "coordinates.input")!;
    const mdin = manifest.inputs.find((item) => item.role === "stage.mdin")!;
    const expectedTopology = stage.inputs.find((item) => item.role === "topology");
    const expectedCoordinates =
      binding.parentRestart ?? stage.inputs.find((item) => item.role === "coordinates");
    if (
      !expectedTopology ||
      !expectedCoordinates ||
      topology.sha256 !== expectedTopology.contentDigest ||
      topology.mediaType !== expectedTopology.mediaType ||
      coordinates.sha256 !== expectedCoordinates.contentDigest ||
      coordinates.mediaType !== expectedCoordinates.mediaType ||
      topology.sha256 !== atomMap.topologyDigest ||
      mdin.sha256 !== manifest.request.render.mdinDigest ||
      mdin.sizeBytes > 64 * 1024 ||
      manifest.inputs.reduce((sum, item) => sum + item.sizeBytes, 0) >
        Math.min(1024 ** 3, stage.resourceProfile.scratchBytes)
    )
      fail("MD preparation input inventory differs from exact scientific authority");
    if (!binding.parentRestart && coordinates.sha256 !== atomMap.coordinateDigest)
      fail("MD preparation initial coordinates differ from the exact AtomMap");
    const paths = manifest.inputs.map((item) => item.logicalPath);
    if (
      paths.some((path, index) =>
        paths.some(
          (other, otherIndex) =>
            index !== otherIndex && (path === other || other.startsWith(`${path}/`)),
        ),
      )
    )
      fail("MD preparation inputs collide");
  }

  private async existing(
    tx: ScientificTransaction,
    workUnitId: string,
  ): Promise<MdPreparationPublication | null> {
    const [row] = await tx.queryRows<Row>(
      "SELECT * FROM scientific_md_preparation_publications WHERE work_unit_id = $1",
      [workUnitId],
    );
    if (!row) return null;
    const publication = assertPublication(JSON.parse(row.payload_json));
    const plan = publication.manifest.executionBinding.plan;
    columns(row, {
      work_unit_id: publication.workUnitId,
      mission_id: publication.missionId,
      plan_id: plan.id,
      plan_version: plan.version,
      plan_revision: plan.revision,
      approval_ref: plan.approvalRef,
      binding_digest: publication.bindingDigest,
      request_digest: publication.requestDigest,
      bundle_digest: publication.bundle.sha256,
      publication_digest: publication.publicationDigest,
      created_at: publication.createdAt,
    });
    return publication;
  }

  private bound(publication: MdPreparationPublication, authority: MdPreparationAuthority): void {
    const { workUnit, association } = authority;
    exact(
      {
        missionId: publication.missionId,
        projectId: publication.projectId,
        ownerUserId: publication.ownerUserId,
        associationDigest: publication.associationDigest,
      },
      {
        missionId: association.missionId,
        projectId: association.projectId,
        ownerUserId: association.ownerUserId,
        associationDigest: association.associationDigest,
      },
      "mission/project association",
    );
    exact(publication.inputEvidenceRefs, [...workUnit.inputRefs].sort(), "input evidence set");
    if (
      publication.workUnitId !== workUnit.id ||
      publication.bindingDigest !== digestCanonical(publication.manifest.executionBinding) ||
      publication.requestDigest !== digestCanonical(publication.manifest.request) ||
      publication.mappingDigest !== publication.manifest.mapping.mappingDigest ||
      publication.environmentBindingDigest !==
        publication.manifest.request.environment.bindingDigest
    )
      fail("MD preparation immutable identity is inconsistent");
  }

  async publish(
    input: PublishMdPreparationInput,
  ): Promise<{ publication: MdPreparationPublication; created: boolean }> {
    // Parse before acquiring DB resources; retain a private snapshot across awaits.
    const workUnitId = IdSchema.parse(input.workUnitId);
    const context = {
      at: TimestampSchema.parse(input.at),
      currentPolicyDigest: DigestSchema.parse(input.currentPolicyDigest),
    };
    const manifest = MdPreparationManifestSchema.parse(JSON.parse(canonicalJson(input.manifest)));
    const bundle = MdPreparationPublicationSchema.shape.bundle.parse(input.bundle);
    exact(reference(manifest), bundle, "bundle digest/size");
    return this.transaction(async (tx) => {
      const authority = await this.authority(tx, workUnitId, {
        ...context,
        request: manifest.request,
      });
      await this.assertManifest(tx, authority, manifest);
      const existing = await this.existing(tx, workUnitId);
      if (existing) {
        this.bound(existing, authority);
        exact(existing.manifest, manifest, "immutable publication replay");
        if (canonicalJson(existing.bundle) !== canonicalJson(bundle))
          throw new ScientificEntityConflictError("MD preparation", workUnitId);
        this.fence(authority);
        return { publication: existing, created: false };
      }
      const [admission] = await tx.queryRows(
        "SELECT operation_id FROM scientific_effect_admissions WHERE work_unit_id = $1 LIMIT 1",
        [workUnitId],
      );
      if (admission) fail("MD preparation cannot bootstrap a WorkUnit after admission");
      const unsigned = {
        schemaVersion: "eigengrid.md-preparation-publication/v1" as const,
        workUnitId: authority.workUnit.id,
        missionId: authority.workUnit.missionId,
        projectId: authority.association.projectId,
        ownerUserId: authority.association.ownerUserId,
        associationDigest: authority.association.associationDigest,
        bindingDigest: digestCanonical(manifest.executionBinding),
        requestDigest: digestCanonical(manifest.request),
        mappingDigest: DigestSchema.parse(manifest.mapping.mappingDigest),
        environmentBindingDigest: manifest.request.environment.bindingDigest,
        inputEvidenceRefs: [...authority.workUnit.inputRefs].sort(),
        bundle,
        manifest,
        createdAt: this.fence(authority),
      };
      const publication = assertPublication({
        ...unsigned,
        publicationDigest: digestCanonical(unsigned),
      });
      const plan = manifest.executionBinding.plan;
      await tx.query(
        `INSERT INTO scientific_md_preparation_publications
        (work_unit_id,mission_id,plan_id,plan_version,plan_revision,approval_ref,binding_digest,request_digest,bundle_digest,publication_digest,payload_json,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          publication.workUnitId,
          publication.missionId,
          plan.id,
          plan.version,
          plan.revision,
          plan.approvalRef,
          publication.bindingDigest,
          publication.requestDigest,
          bundle.sha256,
          publication.publicationDigest,
          canonicalJson(publication),
          publication.createdAt,
        ],
      );
      this.fence(authority);
      return { publication, created: true };
    });
  }

  async resolve(
    workUnitId: string,
    context: MdPreparationAuthorityContext,
  ): Promise<MdPreparationPublication | null> {
    const id = IdSchema.parse(workUnitId);
    const snapshot = {
      at: TimestampSchema.parse(context.at),
      currentPolicyDigest: DigestSchema.parse(context.currentPolicyDigest),
    };
    return this.transaction(async (tx) => {
      const publication = await this.existing(tx, id);
      if (!publication) return null;
      const authority = await this.authority(tx, id, {
        ...snapshot,
        request: publication.manifest.request,
      });
      this.bound(publication, authority);
      await this.assertManifest(tx, authority, publication.manifest);
      this.fence(authority);
      return publication;
    });
  }
}
