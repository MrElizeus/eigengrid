export const ScientificStoreErrorCode = {
  UNSUPPORTED_DATABASE: "SCIENTIFIC_STORE_UNSUPPORTED_DATABASE",
  NOT_FOUND: "SCIENTIFIC_STORE_NOT_FOUND",
  CONFLICT: "SCIENTIFIC_STORE_CONFLICT",
  CONSTRAINT: "SCIENTIFIC_STORE_CONSTRAINT",
  REVISION_CONFLICT: "SCIENTIFIC_STORE_REVISION_CONFLICT",
  ILLEGAL_TRANSITION: "SCIENTIFIC_STORE_ILLEGAL_TRANSITION",
  DIGEST_MISMATCH: "SCIENTIFIC_STORE_DIGEST_MISMATCH",
  IDEMPOTENCY_CONFLICT: "SCIENTIFIC_STORE_IDEMPOTENCY_CONFLICT",
  INTEGRITY: "SCIENTIFIC_STORE_INTEGRITY",
  CLAIM_UNAVAILABLE: "SCIENTIFIC_STORE_CLAIM_UNAVAILABLE",
  BUDGET_EXCEEDED: "SCIENTIFIC_STORE_BUDGET_EXCEEDED",
  RECONCILIATION_REQUIRED: "SCIENTIFIC_STORE_RECONCILIATION_REQUIRED",
  APPROVAL_STALE: "SCIENTIFIC_APPROVAL_STALE",
  APPROVAL_MODIFIED: "SCIENTIFIC_APPROVAL_MODIFIED",
  APPROVAL_EXPIRED: "SCIENTIFIC_APPROVAL_EXPIRED",
  APPROVAL_UNAUTHORIZED: "SCIENTIFIC_APPROVAL_UNAUTHORIZED",
  APPROVAL_POLICY_MISMATCH: "SCIENTIFIC_APPROVAL_POLICY_MISMATCH",
  APPROVAL_MISSING_DECISION: "SCIENTIFIC_APPROVAL_MISSING_DECISION",
  APPROVAL_INCOMPATIBLE_STATE: "SCIENTIFIC_APPROVAL_INCOMPATIBLE_STATE",
} as const;

export type ScientificStoreErrorCode =
  (typeof ScientificStoreErrorCode)[keyof typeof ScientificStoreErrorCode];

/** Provider-neutral base error. It intentionally never includes connection strings. */
export class ScientificStoreError extends Error {
  constructor(
    message: string,
    public readonly code: ScientificStoreErrorCode,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ScientificStoreError";
  }
}

export class ScientificStoreUnsupportedDatabaseError extends ScientificStoreError {
  constructor(provider: string) {
    super(
      `Database provider ${provider} does not implement transactional row reads`,
      ScientificStoreErrorCode.UNSUPPORTED_DATABASE,
      { provider },
    );
    this.name = "ScientificStoreUnsupportedDatabaseError";
  }
}

export class ScientificEntityNotFoundError extends ScientificStoreError {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`, ScientificStoreErrorCode.NOT_FOUND, { entity, id });
    this.name = "ScientificEntityNotFoundError";
  }
}

export class ScientificEntityConflictError extends ScientificStoreError {
  constructor(entity: string, id: string, reason = "identifier already has different content") {
    super(`${entity} conflict for ${id}: ${reason}`, ScientificStoreErrorCode.CONFLICT, {
      entity,
      id,
      reason,
    });
    this.name = "ScientificEntityConflictError";
  }
}

export class ScientificConstraintError extends ScientificStoreError {
  constructor(operation: string) {
    super(
      `Scientific persistence constraint failed during ${operation}`,
      ScientificStoreErrorCode.CONSTRAINT,
      { operation },
    );
    this.name = "ScientificConstraintError";
  }
}

export class ScientificRevisionConflictError extends ScientificStoreError {
  constructor(entity: string, id: string, expected: number, actual: number) {
    super(
      `${entity} ${id} revision conflict: expected ${expected}, found ${actual}`,
      ScientificStoreErrorCode.REVISION_CONFLICT,
      { entity, id, expected, actual },
    );
    this.name = "ScientificRevisionConflictError";
  }
}

export class ScientificIllegalTransitionError extends ScientificStoreError {
  constructor(entity: string, id: string, from: string, to: string) {
    super(
      `Illegal ${entity} transition for ${id}: ${from} -> ${to}`,
      ScientificStoreErrorCode.ILLEGAL_TRANSITION,
      { entity, id, from, to },
    );
    this.name = "ScientificIllegalTransitionError";
  }
}

export class ScientificDigestMismatchError extends ScientificStoreError {
  constructor(subject: string, expected: string, actual: string) {
    super(`${subject} digest mismatch`, ScientificStoreErrorCode.DIGEST_MISMATCH, {
      subject,
      expected,
      actual,
    });
    this.name = "ScientificDigestMismatchError";
  }
}

export class ScientificIdempotencyConflictError extends ScientificStoreError {
  constructor(key: string, existingOperationId?: string) {
    super(
      `Idempotency key ${key} is already bound to different content`,
      ScientificStoreErrorCode.IDEMPOTENCY_CONFLICT,
      { key, existingOperationId },
    );
    this.name = "ScientificIdempotencyConflictError";
  }
}

export class ScientificIntegrityError extends ScientificStoreError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, ScientificStoreErrorCode.INTEGRITY, details);
    this.name = "ScientificIntegrityError";
  }
}

export class ScientificBudgetExceededError extends ScientificStoreError {
  constructor(kind: string, requested: number, available: number) {
    super(
      `Mission budget exceeded for ${kind}: requested ${requested}, available ${available}`,
      ScientificStoreErrorCode.BUDGET_EXCEEDED,
      { kind, requested, available },
    );
    this.name = "ScientificBudgetExceededError";
  }
}

export class ScientificReconciliationRequiredError extends ScientificStoreError {
  constructor(operationId: string, state: string) {
    super(
      `External operation ${operationId} in state ${state} requires explicit reconciliation`,
      ScientificStoreErrorCode.RECONCILIATION_REQUIRED,
      { operationId, state },
    );
    this.name = "ScientificReconciliationRequiredError";
  }
}

abstract class ScientificApprovalError extends ScientificStoreError {
  constructor(
    name: string,
    requestId: string,
    message: string,
    code: ScientificStoreErrorCode,
    details: Record<string, unknown> = {},
  ) {
    super(message, code, { requestId, ...details });
    this.name = name;
  }
}

export class ScientificApprovalStaleError extends ScientificApprovalError {
  constructor(requestId: string, expected: number, actual: number, dimension = "revision") {
    super(
      "ScientificApprovalStaleError",
      requestId,
      `Approval ${requestId} is stale: ${dimension} ${expected} no longer matches ${actual}`,
      ScientificStoreErrorCode.APPROVAL_STALE,
      { expected, actual, dimension },
    );
  }
}

export class ScientificApprovalModifiedError extends ScientificApprovalError {
  constructor(requestId: string, expectedDigest: string, actualDigest: string) {
    super(
      "ScientificApprovalModifiedError",
      requestId,
      `Approval ${requestId} no longer matches the exact subject payload`,
      ScientificStoreErrorCode.APPROVAL_MODIFIED,
      { expectedDigest, actualDigest },
    );
  }
}

export class ScientificApprovalExpiredError extends ScientificApprovalError {
  constructor(requestId: string, expiresAt: string) {
    super(
      "ScientificApprovalExpiredError",
      requestId,
      `Approval ${requestId} expired at ${expiresAt}`,
      ScientificStoreErrorCode.APPROVAL_EXPIRED,
      { expiresAt },
    );
  }
}

export class ScientificApprovalUnauthorizedError extends ScientificApprovalError {
  constructor(requestId: string, requiredRole: string, actualRole: string, actorKind?: string) {
    super(
      "ScientificApprovalUnauthorizedError",
      requestId,
      `Approval ${requestId} requires human role ${requiredRole}; received ${actualRole}`,
      ScientificStoreErrorCode.APPROVAL_UNAUTHORIZED,
      { requiredRole, actualRole, actorKind },
    );
  }
}

export class ScientificApprovalPolicyMismatchError extends ScientificApprovalError {
  constructor(requestId: string, expectedDigest: string, actualDigest: string) {
    super(
      "ScientificApprovalPolicyMismatchError",
      requestId,
      `Approval ${requestId} was evaluated under an incompatible policy`,
      ScientificStoreErrorCode.APPROVAL_POLICY_MISMATCH,
      { expectedDigest, actualDigest },
    );
  }
}

export class ScientificApprovalMissingDecisionError extends ScientificApprovalError {
  constructor(requestId: string, decisionIds: string[]) {
    super(
      "ScientificApprovalMissingDecisionError",
      requestId,
      `Approval ${requestId} is missing required scientific decisions`,
      ScientificStoreErrorCode.APPROVAL_MISSING_DECISION,
      { decisionIds },
    );
  }
}

export class ScientificApprovalIncompatibleStateError extends ScientificApprovalError {
  constructor(requestId: string, missionState: string, approvalState?: string) {
    super(
      "ScientificApprovalIncompatibleStateError",
      requestId,
      `Approval ${requestId} is incompatible with mission state ${missionState}`,
      ScientificStoreErrorCode.APPROVAL_INCOMPATIBLE_STATE,
      { missionState, approvalState },
    );
  }
}
