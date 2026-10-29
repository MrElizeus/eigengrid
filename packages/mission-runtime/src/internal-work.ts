import {
  WorkUnitSchema,
  assertScientificTransition,
  canonicalJson,
  digestCanonical,
  type WorkUnit,
  type WorkUnitState,
} from "@eigengrid/scientific-schema";
import {
  ScientificEntityConflictError,
  ScientificEntityNotFoundError,
  ScientificIntegrityError,
  ScientificRevisionConflictError,
  ScientificStoreUnsupportedDatabaseError,
} from "./errors";
import type { ScientificDatabase, ScientificTransaction } from "./types";

export interface SettleInternalWorkUnitInput {
  workUnitId: string;
  expectedRevision: number;
  claimOwner: string;
  outcome: "succeeded" | "failed";
  at: string;
}

export interface SettleInternalWorkUnitResult {
  workUnit: WorkUnit;
  transitionedThrough: WorkUnitState[];
  alreadySettled: boolean;
}

export interface ScientificInternalWorkUnitPersistence {
  settleInternalWorkUnit(input: SettleInternalWorkUnitInput): Promise<SettleInternalWorkUnitResult>;
}

type PayloadRow = { payload_json: unknown };

function parseWorkUnit(row: PayloadRow, id: string): WorkUnit {
  try {
    const payload =
      typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : row.payload_json;
    return WorkUnitSchema.parse(payload);
  } catch (error) {
    throw new ScientificIntegrityError(`Work unit ${id} contains invalid authoritative JSON`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function settlementPath(current: WorkUnitState, outcome: "succeeded" | "failed"): WorkUnitState[] {
  if (outcome === "succeeded") {
    if (current === "succeeded") return [];
    if (current === "claimed") return ["executing", "observing", "succeeded"];
    if (current === "executing") return ["observing", "succeeded"];
    if (current === "observing") return ["succeeded"];
  } else {
    if (current === "failed") return [];
    if (current === "claimed") return ["executing", "failed"];
    if (current === "executing" || current === "observing") return ["failed"];
  }
  throw new ScientificEntityConflictError(
    "internal work unit",
    current,
    `cannot settle as ${outcome}`,
  );
}

/**
 * Atomic terminal transition for deterministic internal WorkUnits. Application
 * records are written idempotently before this call; a crash before settlement
 * leaves a reclaimable lease, while this final state/claim release is atomic.
 */
export class ScientificInternalWorkUnitStore implements ScientificInternalWorkUnitPersistence {
  constructor(private readonly database: ScientificDatabase) {
    if (!database.beginTransaction || !["sqlite", "postgres"].includes(database._provider)) {
      throw new ScientificStoreUnsupportedDatabaseError(database._provider);
    }
  }

  async settleInternalWorkUnit(
    input: SettleInternalWorkUnitInput,
  ): Promise<SettleInternalWorkUnitResult> {
    const transaction = (await this.database.beginTransaction()) as ScientificTransaction;
    if (!transaction.queryRows) {
      await transaction.rollback();
      throw new ScientificStoreUnsupportedDatabaseError(this.database._provider);
    }
    try {
      const rows = await transaction.queryRows<PayloadRow>(
        "SELECT payload_json FROM scientific_work_units WHERE id = $1",
        [input.workUnitId],
      );
      const row = rows[0];
      if (!row) throw new ScientificEntityNotFoundError("work unit", input.workUnitId);
      const current = parseWorkUnit(row, input.workUnitId);
      if (current.revision !== input.expectedRevision) {
        throw new ScientificRevisionConflictError(
          "work unit",
          current.id,
          input.expectedRevision,
          current.revision,
        );
      }
      const path = settlementPath(current.state, input.outcome);
      if (path.length === 0) {
        await transaction.commit();
        return { workUnit: current, transitionedThrough: [], alreadySettled: true };
      }
      if (current.claimOwner !== input.claimOwner) {
        throw new ScientificEntityConflictError(
          "work-unit claim",
          current.id,
          `owned by ${current.claimOwner ?? "nobody"}, not ${input.claimOwner}`,
        );
      }
      let logicalState = current.state;
      for (const nextState of path) {
        assertScientificTransition("work_unit", logicalState, nextState);
        logicalState = nextState;
      }
      const next = WorkUnitSchema.parse({
        ...current,
        state: path[path.length - 1],
        revision: current.revision + path.length,
        claimOwner: null,
        claimExpiresAt: null,
        updatedAt: input.at,
      });
      const changed = await transaction.queryRows<{ id: string }>(
        `UPDATE scientific_work_units
         SET state = $1, revision = $2, claim_owner = NULL, claim_expires_at = NULL,
             payload_digest = $3, payload_json = $4, updated_at = $5
         WHERE id = $6 AND revision = $7 AND state = $8 AND claim_owner = $9
         RETURNING id`,
        [
          next.state,
          next.revision,
          digestCanonical(next),
          canonicalJson(next),
          next.updatedAt,
          next.id,
          current.revision,
          current.state,
          input.claimOwner,
        ],
      );
      if (changed.length === 0) {
        throw new ScientificRevisionConflictError(
          "work unit",
          current.id,
          current.revision,
          current.revision + path.length,
        );
      }
      await transaction.query(
        `UPDATE scientific_work_unit_claims
         SET active = $1, released_at = $2, release_reason = $3
         WHERE work_unit_id = $4 AND active = $5`,
        [false, input.at, `internal_work_${input.outcome}`, current.id, true],
      );
      await transaction.commit();
      return { workUnit: next, transitionedThrough: path, alreadySettled: false };
    } catch (error) {
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        throw new ScientificIntegrityError(
          "Internal WorkUnit settlement failed and rollback also failed",
          {
            cause: error instanceof Error ? error.message : String(error),
            rollback:
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          },
        );
      }
      throw error;
    }
  }
}
