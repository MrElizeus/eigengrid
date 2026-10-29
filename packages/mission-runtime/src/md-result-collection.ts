import { z } from "zod";
import {
  DigestSchema,
  IdSchema,
  TimestampSchema,
  ExternalOperationSchema,
  WorkUnitSchema,
  ScientificObservationSchema,
  OperationReceiptSchema,
  canonicalJson,
  digestCanonical,
  type EvidenceReference,
  type ExternalOperation,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import { ScientificIntegrityError, ScientificStoreUnsupportedDatabaseError } from "./errors";
import { readMdEffectDelivery, type MdEffectDelivery } from "./effect-delivery";
import { mdStageEffectIdentity } from "./md-effect-authority";
import { assertMdStageOperationRequestAuthority } from "./md-projection-store";
import { ScientificEffectReconciliationStore } from "./effect-reconciliation";
import { ScientificStore } from "./store";
import type { ScientificDatabase, ScientificTransaction } from "./types";
import type { ContentAddressedArtifactStore } from "./content-addressed-store";

const artifact = z
  .object({
    role: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    kind: z.enum(["operation_receipt", "artifact", "restart", "trajectory", "mdout", "mdinfo"]),
    sha256: DigestSchema,
    sizeBytes: z.number().int().nonnegative().safe(),
    mediaType: z.string().min(1).max(256),
  })
  .strict();

/** Raw execution evidence. This is deliberately separate from scientific QC,
 * stage step/time projections, and replicated/durable-release acknowledgements. */
export const MdResultCollectionSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.md-result-collection/v1"),
    operationId: IdSchema,
    deliveryDigest: DigestSchema,
    bindingDigest: DigestSchema,
    publicationDigest: DigestSchema,
    accountingDigest: DigestSchema,
    workerReceiptDigest: DigestSchema,
    slurmJobId: z.string().regex(/^[1-9]\d{0,19}$/u),
    slurmCluster: z.string().min(1).max(256),
    submittedAt: z.string().min(1).max(256),
    uid: z.number().int().positive().safe(),
    outcome: z.enum(["completed", "failed", "cancelled"]),
    artifacts: z.array(artifact).min(4).max(24),
    artifactStatus: z.enum(["complete", "incomplete"]),
    durability: z.literal("pending_replication"),
    scientificVerdict: z.literal("not_evaluated"),
    collectedAt: TimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.artifacts.map((item) => item.role)).size !== value.artifacts.length ||
      !value.artifacts.some(
        (item) =>
          item.role === "worker_receipt" &&
          item.sha256 === value.workerReceiptDigest &&
          item.kind === "operation_receipt",
      ) ||
      !value.artifacts.some(
        (item) => item.role === "publication" && item.sha256 === value.publicationDigest,
      ) ||
      !value.artifacts.some(
        (item) => item.role === "accounting" && item.sha256 === value.accountingDigest,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Collection evidence inventory is not exact",
      });
    }
  });
export type MdResultCollection = z.infer<typeof MdResultCollectionSchema>;

export interface MdResultCollectionAuthority {
  operation: ExternalOperation;
  workUnit: WorkUnit;
  delivery: MdEffectDelivery;
}

function collectionId(operationId: string): string {
  return `md-collection-${digestCanonical({ operationId })}`;
}

function assertColumns(row: Record<string, unknown>, expected: Record<string, unknown>): void {
  if (Object.entries(expected).some(([key, value]) => row[key] !== value))
    throw new ScientificIntegrityError("MD collection index differs from its canonical payload");
}

/** PostgreSQL adoption boundary. Callers provide independently verified bytes;
 * this store rehashes the private CAS and rechecks durable execution identity.
 * Every metadata write, receipt, work-unit and budget settlement commits once.
 */
export class MdResultCollectionStore {
  constructor(
    private readonly database: ScientificDatabase,
    private readonly objects: Pick<ContentAddressedArtifactStore, "verify">,
  ) {
    if (database._provider !== "postgres")
      throw new ScientificStoreUnsupportedDatabaseError(database._provider);
  }

  private async transaction<T>(work: (tx: ScientificTransaction) => Promise<T>): Promise<T> {
    const raw = await this.database.beginTransaction();
    if (!raw.queryRows) {
      await raw.rollback();
      throw new ScientificStoreUnsupportedDatabaseError(this.database._provider);
    }
    const tx = raw as ScientificTransaction;
    try {
      const result = await work(tx);
      await tx.commit();
      return result;
    } catch (error) {
      await tx.rollback().catch(() => undefined);
      throw error;
    }
  }

  private async authority(
    tx: ScientificTransaction,
    operationId: string,
  ): Promise<MdResultCollectionAuthority> {
    const [initial] = await tx.queryRows<{ mission_id: string; work_unit_id: string }>(
      "SELECT mission_id, work_unit_id FROM scientific_external_operations WHERE id = $1",
      [operationId],
    );
    if (!initial) throw new ScientificIntegrityError("MD result has no durable operation");
    // Match admission's mission -> plan -> work unit -> operation lock order.
    await tx.queryRows("SELECT id FROM scientific_missions WHERE id = $1 FOR UPDATE", [
      initial.mission_id,
    ]);
    const [workIndex] = await tx.queryRows<{ plan_id: string }>(
      "SELECT plan_id FROM scientific_work_units WHERE id = $1",
      [initial.work_unit_id],
    );
    if (!workIndex) throw new ScientificIntegrityError("MD result has no durable work unit");
    await tx.queryRows("SELECT id FROM scientific_plans WHERE id = $1 FOR UPDATE", [
      workIndex.plan_id,
    ]);
    const [workRow] = await tx.queryRows(
      "SELECT * FROM scientific_work_units WHERE id = $1 FOR UPDATE",
      [initial.work_unit_id],
    );
    const [operationRow] = await tx.queryRows(
      "SELECT * FROM scientific_external_operations WHERE id = $1 FOR UPDATE",
      [operationId],
    );
    if (!workRow || !operationRow)
      throw new ScientificIntegrityError("MD collection authority disappeared");
    const workUnit = WorkUnitSchema.parse(JSON.parse(String(workRow.payload_json)));
    const operation = ExternalOperationSchema.parse(JSON.parse(String(operationRow.payload_json)));
    assertColumns(workRow, {
      id: workUnit.id,
      mission_id: workUnit.missionId,
      plan_id: workUnit.planId,
      state: workUnit.state,
      revision: workUnit.revision,
    });
    assertColumns(operationRow, {
      id: operation.id,
      mission_id: operation.missionId,
      work_unit_id: operation.workUnitId,
      request_digest: operation.requestDigest,
      state: operation.state,
      revision: operation.revision,
    });
    if (
      operation.id !== operationId ||
      operation.missionId !== initial.mission_id ||
      workUnit.planId !== workIndex.plan_id ||
      operation.workUnitId !== workUnit.id ||
      workUnit.missionId !== operation.missionId ||
      operation.kind !== "md_stage_execution"
    )
      throw new ScientificIntegrityError("MD collection crosses its durable mission/work unit");
    assertMdStageOperationRequestAuthority(workUnit, operation.request);
    mdStageEffectIdentity(operation);
    const delivery = await readMdEffectDelivery(tx, operation);
    if (!delivery) throw new ScientificIntegrityError("MD collection requires a consumed delivery");
    return { operation, workUnit, delivery };
  }

  async readAuthority(operationId: string): Promise<MdResultCollectionAuthority> {
    return this.transaction((tx) => this.authority(tx, IdSchema.parse(operationId)));
  }

  private async existing(
    tx: ScientificTransaction,
    authority: MdResultCollectionAuthority,
  ): Promise<MdResultCollection | null> {
    const [row] = await tx.queryRows("SELECT * FROM scientific_observations WHERE id = $1", [
      collectionId(authority.operation.id),
    ]);
    if (!row) return null;
    const observation = ScientificObservationSchema.parse(JSON.parse(String(row.payload_json)));
    const collection = MdResultCollectionSchema.parse(observation.payload);
    assertColumns(row, {
      id: observation.id,
      mission_id: observation.missionId,
      work_unit_id: observation.workUnitId,
      payload_digest: digestCanonical(observation.payload),
    });
    if (
      observation.id !== collectionId(authority.operation.id) ||
      observation.missionId !== authority.operation.missionId ||
      observation.workUnitId !== authority.workUnit.id ||
      observation.type !== "artifact_integrity" ||
      collection.operationId !== authority.operation.id ||
      collection.deliveryDigest !== authority.delivery.deliveryDigest ||
      collection.bindingDigest !== authority.delivery.bindingDigest
    )
      throw new ScientificIntegrityError("Stored MD collection differs from its durable delivery");
    const [receiptRow] = await tx.queryRows(
      "SELECT payload_json FROM scientific_operation_receipts WHERE operation_id = $1",
      [authority.operation.id],
    );
    if (!receiptRow)
      throw new ScientificIntegrityError("Stored MD collection lost its canonical receipt");
    const receipt = OperationReceiptSchema.parse(JSON.parse(String(receiptRow.payload_json)));
    if (
      receipt.id !== authority.operation.receiptId ||
      receipt.detailDigest !== digestCanonical(collection) ||
      receipt.requestDigest !== authority.operation.requestDigest ||
      receipt.status !== (collection.outcome === "completed" ? "confirmed" : "failed") ||
      authority.operation.state !== receipt.status
    )
      throw new ScientificIntegrityError("Stored MD collection receipt is inconsistent");
    return collection;
  }

  async get(operationId: string): Promise<MdResultCollection | null> {
    return this.transaction(async (tx) =>
      this.existing(tx, await this.authority(tx, IdSchema.parse(operationId))),
    );
  }

  async adopt(
    value: unknown,
  ): Promise<{ collection: MdResultCollection; created: boolean; canonicalAcknowledged: false }> {
    const collection = MdResultCollectionSchema.parse(value);
    // No database locks while reading potentially large trajectories.
    for (const item of collection.artifacts) {
      const verified = await this.objects.verify(item.sha256, { maxBytes: item.sizeBytes });
      if (verified.sizeBytes !== item.sizeBytes)
        throw new ScientificIntegrityError("MD collection CAS size differs from its evidence");
    }
    return this.transaction(async (tx) => {
      const authority = await this.authority(tx, collection.operationId);
      const { operation, workUnit, delivery } = authority;
      if (
        collection.deliveryDigest !== delivery.deliveryDigest ||
        collection.bindingDigest !== delivery.bindingDigest ||
        collection.uid !== delivery.principal.uid
      )
        throw new ScientificIntegrityError("MD result belongs to another delivery/principal");
      const previous = await this.existing(tx, authority);
      if (previous) {
        // Retried transfer/accounting clocks cannot mutate the first adoption.
        if (
          canonicalJson({ ...previous, collectedAt: collection.collectedAt }) !==
          canonicalJson(collection)
        )
          throw new ScientificIntegrityError("A collected MD result cannot be replaced");
        return { collection: previous, created: false, canonicalAcknowledged: false };
      }
      if (!["effect_started", "acknowledged", "ambiguous"].includes(operation.state))
        throw new ScientificIntegrityError("MD collection requires an unsettled consumed effect");
      for (const [key, expected] of Object.entries({
        slurmJobId: collection.slurmJobId,
        slurmCluster: collection.slurmCluster,
        slurmUid: collection.uid,
        slurmSubmittedAt: collection.submittedAt,
      })) {
        if (
          operation.externalIdentity?.[key] !== undefined &&
          operation.externalIdentity[key] !== expected
        )
          throw new ScientificIntegrityError(
            "MD result conflicts with the durable scheduler acknowledgement",
          );
      }
      // Existing domain stores share only this transaction. Their logical commit
      // cannot release locks or partially commit; any rollback poisons adoption.
      let poisoned = false;
      const scope: ScientificDatabase = {
        _provider: "postgres",
        beginTransaction: async () => ({
          query: tx.query.bind(tx),
          queryRows: tx.queryRows.bind(tx),
          commit: async () => {
            if (poisoned) throw new ScientificIntegrityError("MD adoption transaction failed");
          },
          rollback: async () => {
            poisoned = true;
          },
        }),
      };
      const store = new ScientificStore(scope);
      const receiptId = `receipt-md-${digestCanonical({ operationId: operation.id })}`;
      const evidence: EvidenceReference[] = collection.artifacts.map((item) => ({
        id: `evidence-md-${digestCanonical({ operationId: operation.id, role: item.role })}`,
        missionId: operation.missionId,
        workUnitId: workUnit.id,
        kind: item.kind,
        uri: `cas://sha256/${item.sha256}`,
        contentDigest: item.sha256,
        sizeBytes: item.sizeBytes,
        mediaType: item.mediaType,
        immutable: true,
        sourceId: receiptId,
        createdAt: collection.collectedAt,
      }));
      for (const item of evidence) await store.createEvidence(item);
      const ids = mdStageEffectIdentity(operation);
      await store.finalizeOperationReceipt(operation.id, operation.revision, {
        id: receiptId,
        operationId: operation.id,
        requestDigest: operation.requestDigest,
        status: collection.outcome === "completed" ? "confirmed" : "failed",
        ...ids,
        detailDigest: digestCanonical(collection),
        recordedAt: collection.collectedAt,
        externalIdentity: {
          ...operation.externalIdentity,
          ...ids,
          slurmJobId: collection.slurmJobId,
          slurmCluster: collection.slurmCluster,
          slurmUid: collection.uid,
          slurmSubmittedAt: collection.submittedAt,
          status: collection.outcome,
          collectionId: collectionId(operation.id),
          durability: collection.durability,
          scientificVerdict: collection.scientificVerdict,
        },
      });
      await store.createObservation({
        id: collectionId(operation.id),
        missionId: operation.missionId,
        workUnitId: workUnit.id,
        type: "artifact_integrity",
        payload: collection,
        source: { kind: "runtime", id: receiptId },
        evidenceRefs: evidence.map((item) => item.id),
        qualityFlags: ["scientific_not_evaluated", "pending_replication"],
        observedAt: collection.collectedAt,
      });
      await new ScientificEffectReconciliationStore(scope).reconcileWorkUnitEffect({
        operationId: operation.id,
        workUnitId: workUnit.id,
        ...ids,
        outcome: collection.outcome,
        retryable: false,
        at: collection.collectedAt,
      });
      if (operation.budgetReservationId) {
        const budget = await store.getMissionBudget(operation.missionId);
        await store.settleBudgetReservation({
          missionId: operation.missionId,
          reservationId: operation.budgetReservationId,
          expectedBudgetRevision: budget.revision,
          state: "consumed",
          at: collection.collectedAt,
        });
      }
      if (poisoned) throw new ScientificIntegrityError("MD adoption transaction failed");
      return { collection, created: true, canonicalAcknowledged: false };
    });
  }
}
