// ────────────────────────────────────────────────────────────
// Provider-neutral typed DB errors with stable codes
// ────────────────────────────────────────────────────────────

/**
 * Stable error codes for the database layer.
 * Every error from any adapter must use one of these codes.
 */
export const DbErrorCode = {
  /** Database not initialized — call init() first */
  NOT_INITIALIZED: "DB_NOT_INITIALIZED",
  /** Connection or pool failure */
  CONNECTION_FAILED: "DB_CONNECTION_FAILED",
  /** Query execution failure */
  QUERY_FAILED: "DB_QUERY_FAILED",
  /** Row validation failure — malformed or missing required fields */
  ROW_VALIDATION: "DB_ROW_VALIDATION",
  /** Entity not found */
  NOT_FOUND: "DB_NOT_FOUND",
  /** Ambiguous identifier prefix matches multiple rows */
  AMBIGUOUS_PREFIX: "DB_AMBIGUOUS_PREFIX",
  /** Invalid status transition */
  INVALID_TRANSITION: "DB_INVALID_TRANSITION",
  /** Constraint violation (unique, foreign key, etc.) */
  CONSTRAINT: "DB_CONSTRAINT",
  /** Transaction error (commit, rollback failure) */
  TRANSACTION: "DB_TRANSACTION",
  /** Migration error */
  MIGRATION: "DB_MIGRATION",
  /** Event sequence allocation failure */
  EVENT_SEQUENCE: "DB_EVENT_SEQUENCE",
  /** Unsupported operation for this provider */
  UNSUPPORTED: "DB_UNSUPPORTED",
} as const;

export type DbErrorCode = (typeof DbErrorCode)[keyof typeof DbErrorCode];

/**
 * Typed database error with a stable machine-readable code
 * and a human-readable message. Never leaks credentials.
 */
export class DbError extends Error {
  constructor(
    message: string,
    public readonly code: DbErrorCode,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "DbError";
  }
}

/**
 * Error raised when a row from the database fails validation
 * (missing required fields, wrong types, etc.).
 */
export class DbRowValidationError extends DbError {
  constructor(table: string, field: string, detail: string) {
    super(
      `Row validation failed for ${table}.${field}: ${detail}`,
      DbErrorCode.ROW_VALIDATION,
      `${table}.${field}: ${detail}`,
    );
    this.name = "DbRowValidationError";
  }
}

/**
 * Error raised when an entity is not found.
 */
export class DbNotFoundError extends DbError {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`, DbErrorCode.NOT_FOUND, `${entity}:${id}`);
    this.name = "DbNotFoundError";
  }
}

/**
 * Error raised when a query fails.
 */
export class DbQueryError extends DbError {
  constructor(message: string, cause?: unknown) {
    super(
      `Database query error: ${message}`,
      DbErrorCode.QUERY_FAILED,
      cause instanceof Error ? cause.message : undefined,
    );
    this.name = "DbQueryError";
  }
}

/**
 * Error raised when a status transition is invalid.
 */
export class DbInvalidTransitionError extends DbError {
  constructor(entity: string, from: string, to: string, allowed: string[]) {
    super(
      `Invalid ${entity} status transition: ${from} -> ${to}. ` +
        `Valid transitions from '${from}': ${allowed.join(", ") || "none"}.`,
      DbErrorCode.INVALID_TRANSITION,
      `${entity}:${from}->${to}`,
    );
    this.name = "DbInvalidTransitionError";
  }
}

/**
 * Error raised when an ambiguous prefix matches multiple entities.
 */
export class DbAmbiguousPrefixError extends DbError {
  constructor(entity: string, prefix: string, count: number) {
    super(
      `Ambiguous ${entity} ID prefix: ${prefix} matches ${count} ${entity}s`,
      DbErrorCode.AMBIGUOUS_PREFIX,
      `${entity}:${prefix}:${count}`,
    );
    this.name = "DbAmbiguousPrefixError";
  }
}
