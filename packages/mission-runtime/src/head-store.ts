import {
  ExternalOperationSchema,
  type ExternalOperation,
  type MissionCheckpoint,
  type ScientificMission,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import { ScientificIntegrityError, ScientificStoreUnsupportedDatabaseError } from "./errors";
import type { ScientificMissionHeadStore } from "./head";
import { ScientificStore } from "./store";
import type {
  MissionProvenance,
  ScientificDatabase,
  ScientificTransaction,
  WorkUnitClaimResult,
} from "./types";

type PayloadRow = { payload_json: unknown } & Record<string, unknown>;

function parseOperation(row: PayloadRow): ExternalOperation {
  try {
    const payload =
      typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : row.payload_json;
    return ExternalOperationSchema.parse(payload);
  } catch (error) {
    throw new ScientificIntegrityError("Terminal operation contains invalid authoritative JSON", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Finds receipt-backed operations whose effect is terminal but whose WorkUnit
 * still needs effect settlement or idempotent scientific postprocessing. This
 * closes both receipt→WorkUnit and observing→evidence crash windows without
 * replaying the external effect.
 */
export class ScientificTerminalOperationScanner {
  constructor(private readonly database: ScientificDatabase) {
    if (!database.beginTransaction || !["sqlite", "postgres"].includes(database._provider)) {
      throw new ScientificStoreUnsupportedDatabaseError(database._provider);
    }
  }

  async listUnsettledTerminalOperations(missionId: string): Promise<ExternalOperation[]> {
    const transaction = (await this.database.beginTransaction()) as ScientificTransaction;
    if (!transaction.queryRows) {
      await transaction.rollback();
      throw new ScientificStoreUnsupportedDatabaseError(this.database._provider);
    }
    try {
      const rows = await transaction.queryRows<PayloadRow>(
        `SELECT external_op.payload_json
         FROM scientific_external_operations AS external_op
         JOIN scientific_work_units AS work_unit ON work_unit.id = external_op.work_unit_id
         WHERE external_op.mission_id = $1
           AND external_op.receipt_id IS NOT NULL
           AND (
             (external_op.state = 'confirmed' AND work_unit.state IN
               ('claimed','executing','observing'))
             OR
             (external_op.state = 'failed' AND work_unit.state IN
               ('claimed','executing','observing','cancel_requested','cancelling'))
             OR
             (external_op.operation_kind_id = 'md_stage_execution'
               AND external_op.state IN ('confirmed','failed')
               AND EXISTS (
                 SELECT 1 FROM scientific_budget_reservations AS reservation
                 WHERE reservation.id = external_op.budget_reservation_id
                   AND reservation.state IN ('reserved','ambiguous')
               ))
           )
         ORDER BY external_op.created_at, external_op.id`,
        [missionId],
      );
      await transaction.commit();
      return rows.map(parseOperation);
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
}

/**
 * Production head-store composition. ScientificStore remains the aggregate
 * owner; the scanner adds only receipt-backed recovery visibility.
 */
export class RestartSafeScientificMissionHeadStore implements ScientificMissionHeadStore {
  private readonly scanner: ScientificTerminalOperationScanner;

  constructor(
    private readonly store: ScientificStore,
    database: ScientificDatabase,
  ) {
    this.scanner = new ScientificTerminalOperationScanner(database);
  }

  listRecoverableMissions(): Promise<ScientificMission[]> {
    return this.store.listRecoverableMissions();
  }

  async listOperationsForReconciliation(missionId: string): Promise<ExternalOperation[]> {
    const [nonterminal, terminal] = await Promise.all([
      this.store.listOperationsForReconciliation(missionId),
      this.scanner.listUnsettledTerminalOperations(missionId),
    ]);
    const unique = new Map<string, ExternalOperation>();
    for (const operation of [...nonterminal, ...terminal]) unique.set(operation.id, operation);
    return [...unique.values()].sort((left, right) =>
      `${left.createdAt}\0${left.id}`.localeCompare(`${right.createdAt}\0${right.id}`),
    );
  }

  listRunnableWorkUnits(missionId: string, now: string): Promise<WorkUnit[]> {
    return this.store.listRunnableWorkUnits(missionId, now);
  }

  claimWorkUnit(input: {
    workUnitId: string;
    ownerId: string;
    now: string;
    expiresAt: string;
    claimId?: string;
    policyDigest?: string;
  }): Promise<WorkUnitClaimResult> {
    return this.store.claimWorkUnit(input);
  }

  renewWorkUnitClaim(input: {
    workUnitId: string;
    claimId: string;
    ownerId: string;
    now: string;
    expiresAt: string;
    expectedRevision?: number;
  }): Promise<WorkUnit> {
    return this.store.renewWorkUnitClaim(input);
  }

  getMissionProvenance(missionId: string): Promise<MissionProvenance> {
    return this.store.getMissionProvenance(missionId);
  }

  createCheckpoint(checkpoint: MissionCheckpoint): Promise<MissionCheckpoint> {
    return this.store.createCheckpoint(checkpoint);
  }
}
