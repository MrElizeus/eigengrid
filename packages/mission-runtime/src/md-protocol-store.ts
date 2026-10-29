/** Internal domain repository; callers use the public store facade. */
import {
  ReplicaSetSchema,
  assertAtomMapDigest,
  assertForceFieldStackDigest,
  assertMdStageSpecDigest,
  assertMdWorkflowProtocolDigest,
  assertPublishedBiomolecularSystemManifestDigest,
  canonicalJson,
  type MdStageSpec,
  type MdWorkflowProtocol,
  type ReplicaSet,
} from "@eigengrid/scientific-schema";
import { ScientificEntityNotFoundError, ScientificIntegrityError } from "./errors";
import { resolveDecisionRequirements } from "./md-store-authority";
import { MdStoreContext } from "./md-store-context";
import { JsonRow, one, parseJson, queryRows } from "./md-store-queries";
import {
  assertAtomMapCoversSystem,
  assertForceFieldStackCoversSystem,
  assertMdProtocolForceFieldAuthority,
  computeMdProtocolMaterialDigest,
  computeMdReplicaSetPayloadDigest,
  mdEvidenceKindByArtifactRole,
} from "./md-store-validation";
export class MdProtocolStore {
  constructor(private readonly context: MdStoreContext) {}

  async putProtocol(
    input: MdWorkflowProtocol,
    context: { planId: string; planVersion: number },
  ): Promise<MdWorkflowProtocol> {
    const protocol = assertMdWorkflowProtocolDigest(input);
    if (protocol.status !== "draft" && protocol.status !== "under_review") {
      throw new ScientificIntegrityError(
        "An MD protocol may enter persistence only as draft or under_review",
        { protocolId: protocol.id, status: protocol.status },
      );
    }
    for (const stage of protocol.stages) assertMdStageSpecDigest(stage);
    const materialDigest = computeMdProtocolMaterialDigest(protocol);
    await this.context.inTransaction("persist MD protocol", async (tx) => {
      const plan = await this.context.required<{
        mission_id: string;
        version: number;
        status: string;
      }>(tx, "scientific plan", "scientific_plans", context.planId);
      if (
        String(plan.mission_id) !== protocol.missionId ||
        Number(plan.version) !== context.planVersion ||
        !["under_review", "approved"].includes(String(plan.status))
      ) {
        throw new ScientificIntegrityError("MD protocol does not match its exact mission plan", {
          protocolId: protocol.id,
        });
      }
      const system = await one<
        JsonRow & {
          mission_id: string;
          manifest_digest: string;
          topology_digest: string;
          coordinate_digest: string;
          atom_map_digest: string;
        }
      >(
        tx,
        `SELECT mission_id, manifest_digest, topology_digest, coordinate_digest, atom_map_digest,
                payload_json
         FROM scientific_biomolecular_system_manifests WHERE id = $1 AND revision = $2`,
        [protocol.system.id, protocol.system.revision],
      );
      if (
        !system ||
        String(system.mission_id) !== protocol.missionId ||
        String(system.manifest_digest) !== protocol.system.manifestDigest ||
        String(system.topology_digest) !== protocol.system.topologyDigest ||
        String(system.coordinate_digest) !== protocol.system.coordinateDigest ||
        String(system.atom_map_digest) !== protocol.system.atomMapDigest
      ) {
        throw new ScientificIntegrityError("MD protocol system reference is stale or mismatched", {
          protocolId: protocol.id,
        });
      }
      const manifest = assertPublishedBiomolecularSystemManifestDigest(
        parseJson(system, "MD protocol system manifest"),
      );
      const stackRow = await one<JsonRow & { mission_id: string; stack_digest: string }>(
        tx,
        `SELECT mission_id, stack_digest, payload_json
         FROM scientific_force_field_stack_revisions WHERE id = $1 AND revision = $2`,
        [manifest.forceFieldStack.id, manifest.forceFieldStack.revision],
      );
      const atomMapRows = await queryRows<JsonRow & { mission_id: string; map_digest: string }>(
        tx,
        `SELECT mission_id, map_digest, payload_json FROM scientific_atom_map_revisions
         WHERE system_manifest_id = $1 AND system_manifest_revision = $2 AND map_digest = $3`,
        [manifest.id, manifest.revision, manifest.atomMapDigest],
      );
      if (!stackRow || atomMapRows.length !== 1) {
        throw new ScientificIntegrityError(
          "MD protocol requires exact durable force-field stack and atom-map authorities",
          { protocolId: protocol.id, manifestId: manifest.id },
        );
      }
      const stack = assertForceFieldStackDigest(
        parseJson(stackRow, "MD protocol force-field stack"),
      );
      const atomMap = assertAtomMapDigest(parseJson(atomMapRows[0]!, "MD protocol atom map"));
      if (
        String(stackRow.mission_id) !== protocol.missionId ||
        stack.id !== manifest.forceFieldStack.id ||
        stack.revision !== manifest.forceFieldStack.revision ||
        stack.stackDigest !== manifest.forceFieldStack.digest ||
        String(stackRow.stack_digest) !== manifest.forceFieldStack.digest ||
        String(atomMapRows[0]!.mission_id) !== protocol.missionId ||
        atomMap.mapDigest !== manifest.atomMapDigest ||
        String(atomMapRows[0]!.map_digest) !== manifest.atomMapDigest
      ) {
        throw new ScientificIntegrityError("MD protocol material authority is stale", {
          protocolId: protocol.id,
        });
      }
      assertMdProtocolForceFieldAuthority(protocol, manifest, stack);
      await this.context.assertMdEngineAdmissionCas(tx, protocol);
      assertForceFieldStackCoversSystem(stack, manifest);
      assertAtomMapCoversSystem(atomMap, manifest);
      await this.context.assertDecisionRequirements(
        tx,
        protocol.missionId,
        await resolveDecisionRequirements(tx, protocol.missionId, protocol.decisionRefs),
      );
      for (const stage of protocol.stages) {
        for (const artifact of stage.inputs) {
          await this.context.assertCasEvidence(tx, {
            missionId: protocol.missionId,
            evidenceRef: artifact.evidenceRef,
            expectedDigest: artifact.contentDigest,
            expectedKind: mdEvidenceKindByArtifactRole[artifact.role],
            expectedMediaType: artifact.mediaType,
            expectedSizeBytes: artifact.sizeBytes,
          });
        }
      }
      await this.context.insertRevision(tx, {
        entity: "MD protocol",
        table: "scientific_md_protocols",
        id: protocol.id,
        revision: protocol.revision,
        payload: canonicalJson(protocol),
        columns: [
          "id",
          "revision",
          "mission_id",
          "plan_id",
          "plan_version",
          "system_manifest_id",
          "system_manifest_revision",
          "protocol_digest",
          "material_digest",
          "review_status",
          "payload_json",
          "created_at",
          "updated_at",
        ],
        values: [
          protocol.id,
          protocol.revision,
          protocol.missionId,
          context.planId,
          context.planVersion,
          protocol.system.id,
          protocol.system.revision,
          protocol.protocolDigest,
          materialDigest,
          protocol.status,
          canonicalJson(protocol),
          protocol.createdAt,
          protocol.updatedAt,
        ],
      });
      for (const stage of protocol.stages) {
        await this.context.insertRevision(tx, {
          entity: "MD stage spec",
          table: "scientific_md_stage_specs",
          id: stage.id,
          revision: stage.revision,
          payload: canonicalJson(stage),
          columns: [
            "id",
            "revision",
            "mission_id",
            "protocol_id",
            "protocol_revision",
            "sequence",
            "stage_kind",
            "stage_digest",
            "payload_json",
            "created_at",
          ],
          values: [
            stage.id,
            stage.revision,
            protocol.missionId,
            protocol.id,
            protocol.revision,
            stage.sequence,
            stage.kind,
            stage.stageDigest,
            canonicalJson(stage),
            protocol.createdAt,
          ],
        });
      }
    });
    return protocol;
  }

  async getProtocol(id: string, revision: number): Promise<MdWorkflowProtocol | null> {
    return this.context.inTransaction("get MD protocol", async (tx) => {
      const row = await one<
        JsonRow & {
          mission_id: string;
          protocol_digest: string;
          material_digest: string;
          review_status: string;
        }
      >(
        tx,
        `SELECT mission_id, protocol_digest, material_digest, review_status, payload_json
         FROM scientific_md_protocols WHERE id = $1 AND revision = $2`,
        [id, revision],
      );
      if (!row) return null;
      const protocol = assertMdWorkflowProtocolDigest(parseJson(row, "MD protocol"));
      if (
        protocol.id !== id ||
        protocol.revision !== revision ||
        protocol.missionId !== String(row.mission_id) ||
        protocol.status !== String(row.review_status) ||
        protocol.protocolDigest !== String(row.protocol_digest) ||
        protocol.protocolDigest !== String(row.material_digest)
      ) {
        throw new ScientificIntegrityError("MD protocol columns are corrupt", { id, revision });
      }
      const manifestRow = await one<JsonRow & { mission_id: string; manifest_digest: string }>(
        tx,
        `SELECT mission_id, manifest_digest, payload_json
         FROM scientific_biomolecular_system_manifests WHERE id = $1 AND revision = $2`,
        [protocol.system.id, protocol.system.revision],
      );
      if (!manifestRow) {
        throw new ScientificEntityNotFoundError("MD protocol system manifest", protocol.system.id);
      }
      const manifest = assertPublishedBiomolecularSystemManifestDigest(
        parseJson(manifestRow, "MD protocol system manifest"),
      );
      const stackRow = await one<JsonRow & { mission_id: string; stack_digest: string }>(
        tx,
        `SELECT mission_id, stack_digest, payload_json
         FROM scientific_force_field_stack_revisions WHERE id = $1 AND revision = $2`,
        [manifest.forceFieldStack.id, manifest.forceFieldStack.revision],
      );
      if (!stackRow) {
        throw new ScientificEntityNotFoundError(
          "MD protocol force-field stack",
          manifest.forceFieldStack.id,
        );
      }
      const stack = assertForceFieldStackDigest(
        parseJson(stackRow, "MD protocol force-field stack"),
      );
      if (
        String(manifestRow.mission_id) !== protocol.missionId ||
        String(manifestRow.manifest_digest) !== manifest.manifestDigest ||
        String(stackRow.mission_id) !== protocol.missionId ||
        String(stackRow.stack_digest) !== stack.stackDigest
      ) {
        throw new ScientificIntegrityError("MD protocol material relation is corrupt", {
          id,
          revision,
        });
      }
      assertMdProtocolForceFieldAuthority(protocol, manifest, stack);
      await this.context.assertMdEngineAdmissionCas(tx, protocol);
      return protocol;
    });
  }

  async getStageSpec(id: string, revision: number): Promise<MdStageSpec | null> {
    return this.context.inTransaction("get MD stage spec", async (tx) => {
      const row = await one<
        JsonRow & {
          sequence: number;
          stage_kind: string;
          stage_digest: string;
        }
      >(
        tx,
        `SELECT sequence, stage_kind, stage_digest, payload_json
         FROM scientific_md_stage_specs WHERE id = $1 AND revision = $2`,
        [id, revision],
      );
      if (!row) return null;
      const stage = assertMdStageSpecDigest(parseJson(row, "MD stage"));
      if (
        stage.id !== id ||
        stage.revision !== revision ||
        stage.sequence !== Number(row.sequence) ||
        stage.kind !== String(row.stage_kind) ||
        stage.stageDigest !== String(row.stage_digest)
      ) {
        throw new ScientificIntegrityError("MD stage columns are corrupt", { id, revision });
      }
      return stage;
    });
  }

  async putReplicaSet(input: ReplicaSet): Promise<ReplicaSet> {
    const replicaSet = ReplicaSetSchema.parse(input);
    const payloadDigest = computeMdReplicaSetPayloadDigest(replicaSet);
    await this.context.inTransaction("persist MD replica set", async (tx) => {
      const protocol = await one<{
        mission_id: string;
        protocol_digest: string;
        payload_json: string;
      }>(
        tx,
        `SELECT mission_id, protocol_digest, payload_json FROM scientific_md_protocols
         WHERE id = $1 AND revision = $2`,
        [replicaSet.protocolId, replicaSet.protocolRevision],
      );
      if (!protocol || String(protocol.mission_id) !== replicaSet.missionId) {
        throw new ScientificIntegrityError("Replica set references a missing protocol revision");
      }
      const parsedProtocol = assertMdWorkflowProtocolDigest(
        parseJson(protocol as JsonRow, "MD protocol"),
      );
      if (
        parsedProtocol.protocolDigest !== replicaSet.protocolDigest ||
        parsedProtocol.system.manifestDigest !== replicaSet.systemManifestDigest
      ) {
        throw new ScientificIntegrityError("Replica set protocol or system digest is stale");
      }
      await this.context.assertDecisionRequirements(tx, replicaSet.missionId, [
        { id: replicaSet.decisionRef },
      ]);
      for (const replica of replicaSet.replicas) {
        await this.context.assertCasEvidence(tx, {
          missionId: replicaSet.missionId,
          evidenceRef: replica.initialRestart.evidenceRef,
          expectedDigest: replica.initialRestart.contentDigest,
          expectedKind: "restart",
          expectedMediaType: replica.initialRestart.mediaType,
          expectedSizeBytes: replica.initialRestart.sizeBytes,
        });
      }
      await this.context.insertRevision(tx, {
        entity: "MD replica set",
        table: "scientific_md_replica_set_revisions",
        id: replicaSet.id,
        revision: replicaSet.revision,
        payload: canonicalJson(replicaSet),
        columns: [
          "id",
          "revision",
          "mission_id",
          "protocol_id",
          "protocol_revision",
          "protocol_digest",
          "decision_id",
          "replica_count",
          "seed_policy_digest",
          "payload_digest",
          "payload_json",
          "created_at",
        ],
        values: [
          replicaSet.id,
          replicaSet.revision,
          replicaSet.missionId,
          replicaSet.protocolId,
          replicaSet.protocolRevision,
          replicaSet.protocolDigest,
          replicaSet.decisionRef,
          replicaSet.replicaCount,
          replicaSet.seedPolicyDigest,
          payloadDigest,
          canonicalJson(replicaSet),
          replicaSet.createdAt,
        ],
      });
    });
    return replicaSet;
  }

  async getReplicaSet(id: string, revision: number): Promise<ReplicaSet | null> {
    return this.context.inTransaction("get MD replica set", async (tx) => {
      const row = await one<JsonRow & { payload_digest: string }>(
        tx,
        `SELECT payload_json, payload_digest FROM scientific_md_replica_set_revisions
         WHERE id = $1 AND revision = $2`,
        [id, revision],
      );
      if (!row) return null;
      const replicaSet = ReplicaSetSchema.parse(parseJson(row, "MD replica set"));
      const digest = computeMdReplicaSetPayloadDigest(replicaSet);
      if (digest !== String(row.payload_digest)) {
        throw new ScientificIntegrityError("Replica-set payload digest is corrupt", {
          id,
          revision,
        });
      }
      return replicaSet;
    });
  }
}
