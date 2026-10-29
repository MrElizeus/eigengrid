/**
 * Backend-neutral execution lifecycle. Adapters may project these states onto
 * legacy JobStatus values, but they must not skip the durable intent or
 * ambiguous/reconciliation states.
 */
export const EXECUTION_STATES = [
  "created",
  "intent_persisted",
  "staged",
  "submitted",
  "running",
  "observing",
  "completed",
  "failed",
  "cancel_requested",
  "cancelling",
  "cancelled",
  "ambiguous",
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const VALID_EXECUTION_TRANSITIONS: Readonly<
  Record<ExecutionState, readonly ExecutionState[]>
> = {
  created: ["intent_persisted", "failed", "cancel_requested"],
  intent_persisted: ["staged", "submitted", "failed", "ambiguous", "cancel_requested"],
  staged: ["submitted", "failed", "cancel_requested", "ambiguous"],
  submitted: ["running", "completed", "failed", "ambiguous", "cancel_requested"],
  running: ["observing", "completed", "failed", "ambiguous", "cancel_requested"],
  observing: ["completed", "failed", "ambiguous", "cancel_requested"],
  completed: [],
  failed: [],
  cancel_requested: ["cancelling", "cancelled", "ambiguous", "failed"],
  cancelling: ["cancelled", "ambiguous", "failed"],
  cancelled: [],
  ambiguous: ["submitted", "running", "completed", "failed", "cancelled", "cancel_requested"],
};

export function canTransitionExecution(from: ExecutionState, to: ExecutionState): boolean {
  return from === to || VALID_EXECUTION_TRANSITIONS[from]?.includes(to) === true;
}

export class InvalidExecutionTransitionError extends Error {
  readonly code = "INVALID_EXECUTION_TRANSITION";
  constructor(
    readonly from: ExecutionState,
    readonly to: ExecutionState,
  ) {
    super(`Invalid execution transition ${from} -> ${to}`);
    this.name = "InvalidExecutionTransitionError";
  }
}

export interface ExecutionIntent {
  operationId: string;
  requestId: string;
  idempotencyKey: string;
  jobId: string;
  attemptId: string;
  backend: "local" | "ssh" | "worker" | "slurm" | "pbs";
  state: ExecutionState;
  requestDigest: `sha256:${string}`;
  createdAt: string;
}

export interface EffectReceipt {
  operationId: string;
  jobId: string;
  attemptId: string;
  state: "confirmed" | "failed" | "cancelled" | "ambiguous";
  externalId?: string;
  observedAt: string;
  receiptDigest: `sha256:${string}`;
}

/** Small in-memory coordinator used by adapters/tests to prove idempotency and ambiguity rules. */
export class ExecutionIntentJournal {
  private readonly intents = new Map<string, ExecutionIntent>();
  private readonly receipts = new Map<string, EffectReceipt>();

  persist(intent: ExecutionIntent): ExecutionIntent {
    const current = this.intents.get(intent.operationId);
    if (current) {
      if (current.requestDigest !== intent.requestDigest)
        throw new Error(`operation ${intent.operationId} request digest conflict`);
      return current;
    }
    if (intent.state !== "intent_persisted")
      throw new Error("external effects require intent_persisted state");
    this.intents.set(intent.operationId, intent);
    return intent;
  }

  transition(operationId: string, next: ExecutionState): ExecutionIntent {
    const current = this.intents.get(operationId);
    if (!current) throw new Error(`unknown execution intent ${operationId}`);
    if (!canTransitionExecution(current.state, next))
      throw new InvalidExecutionTransitionError(current.state, next);
    const updated = { ...current, state: next };
    this.intents.set(operationId, updated);
    return updated;
  }

  observe(receipt: EffectReceipt): EffectReceipt {
    const current = this.receipts.get(receipt.operationId);
    if (current) {
      if (current.receiptDigest !== receipt.receiptDigest)
        throw new Error(`receipt conflict for ${receipt.operationId}`);
      return current;
    }
    this.receipts.set(receipt.operationId, receipt);
    return receipt;
  }

  get(operationId: string): { intent?: ExecutionIntent; receipt?: EffectReceipt } {
    return { intent: this.intents.get(operationId), receipt: this.receipts.get(operationId) };
  }
}
