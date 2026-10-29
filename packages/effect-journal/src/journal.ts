import {
  canonicalEffectJson,
  digestEffectValue,
  parseVerifiedEffectJournalFrame,
  sealEffectJournalFrame,
} from "./digest";
import {
  AcknowledgeEffectOutboxInputSchema,
  AppendEffectIntentInputSchema,
  EffectIntentSchema,
  EffectOperationIdentitySchema,
  ReconcileEffectIntentInputSchema,
  type AcknowledgeEffectOutboxInput,
  type AppendEffectIntentInput,
  type EffectIntent,
  type EffectIntentState,
  type EffectJournalFrame,
  type EffectOperationCommitFrame,
  type EffectOperationIdentity,
  type EffectOutboxAcknowledgementFrame,
  type EffectOutboxEvent,
  type ReconcileEffectIntentInput,
} from "./schemas";

export const VALID_EFFECT_INTENT_TRANSITIONS: Readonly<
  Record<EffectIntentState, readonly EffectIntentState[]>
> = {
  pending: ["submitted", "ambiguous", "confirmed", "failed", "cancel_requested"],
  submitted: ["ambiguous", "confirmed", "failed", "cancel_requested"],
  ambiguous: ["submitted", "confirmed", "failed", "cancel_requested", "cancelled"],
  confirmed: [],
  failed: [],
  cancel_requested: ["ambiguous", "confirmed", "failed", "cancelled"],
  cancelled: [],
};

export function canTransitionEffectIntent(from: EffectIntentState, to: EffectIntentState): boolean {
  return from !== to && VALID_EFFECT_INTENT_TRANSITIONS[from].includes(to);
}

export class EffectJournalConflictError extends Error {
  readonly code = "EFFECT_JOURNAL_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "EffectJournalConflictError";
  }
}

export class EffectJournalRevisionConflictError extends Error {
  readonly code = "EFFECT_JOURNAL_REVISION_CONFLICT";

  constructor(
    readonly operationId: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`Effect operation ${operationId} expected revision ${expected}, found ${actual}`);
    this.name = "EffectJournalRevisionConflictError";
  }
}

export class InvalidEffectIntentTransitionError extends Error {
  readonly code = "INVALID_EFFECT_INTENT_TRANSITION";

  constructor(
    readonly from: EffectIntentState,
    readonly to: EffectIntentState,
  ) {
    super(`Invalid effect intent transition ${from} -> ${to}`);
    this.name = "InvalidEffectIntentTransitionError";
  }
}

export class EffectJournalIntegrityError extends Error {
  readonly code = "EFFECT_JOURNAL_INTEGRITY_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "EffectJournalIntegrityError";
  }
}

export class EffectJournalContentionError extends Error {
  readonly code = "EFFECT_JOURNAL_CONTENTION";

  constructor(readonly attempts: number) {
    super(`Effect journal compare-and-append did not converge after ${attempts} attempts`);
    this.name = "EffectJournalContentionError";
  }
}

/** Verified anchor into an immutable, append-only history. */
export interface EffectJournalCursor {
  sequence: number;
  frameDigest: string | null;
}

export interface EffectJournalTail {
  after: EffectJournalCursor;
  head: EffectJournalCursor;
  frames: readonly EffectJournalFrame[];
}

/**
 * Minimal provider-neutral atomic primitive. A database adapter should bind
 * compareAndAppend to one transaction and a unique monotonically increasing
 * sequence. The operation snapshot and outbox event are already one frame.
 */
export interface EffectJournalStore {
  /**
   * Optional immutable-history contract. Return an atomic, complete suffix and
   * reject a cursor that no longer identifies the retained prefix. Implement only
   * when committed frames cannot be changed or removed for this store's lifetime.
   * Mutable files must use full read/replay instead; a digest alone cannot prove
   * that an earlier record was not rewritten.
   */
  readAfter?(cursor: EffectJournalCursor): Promise<EffectJournalTail>;
  read(): Promise<readonly EffectJournalFrame[]>;
  compareAndAppend(expectedSequence: number, frame: EffectJournalFrame): Promise<boolean>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Deterministic in-memory adapter for contract tests and embedding tests only. */
export class InMemoryEffectJournalStore implements EffectJournalStore {
  private readonly frames: EffectJournalFrame[];

  constructor(initialFrames: readonly EffectJournalFrame[] = []) {
    this.frames = initialFrames.map((frame) => clone(parseVerifiedEffectJournalFrame(frame)));
  }

  async read(): Promise<readonly EffectJournalFrame[]> {
    return clone(this.frames);
  }

  async readAfter(cursor: EffectJournalCursor): Promise<EffectJournalTail> {
    if (
      !Number.isSafeInteger(cursor.sequence) ||
      cursor.sequence < 0 ||
      cursor.sequence > this.frames.length ||
      cursor.frameDigest !== (this.frames[cursor.sequence - 1]?.frameDigest ?? null)
    )
      throw new EffectJournalIntegrityError("Immutable journal cursor no longer matches history");
    return {
      after: { ...cursor },
      head: {
        sequence: this.frames.length,
        frameDigest: this.frames.at(-1)?.frameDigest ?? null,
      },
      frames: clone(this.frames.slice(cursor.sequence)),
    };
  }

  async compareAndAppend(expectedSequence: number, frame: EffectJournalFrame): Promise<boolean> {
    const verified = parseVerifiedEffectJournalFrame(frame);
    if (this.frames.length !== expectedSequence) return false;
    if (verified.sequence !== expectedSequence + 1) {
      throw new EffectJournalIntegrityError(
        `Frame sequence ${verified.sequence} does not follow ${expectedSequence}`,
      );
    }
    this.frames.push(clone(verified));
    return true;
  }
}

interface ReplayState {
  sequence: number;
  frameDigest: string | null;
  operations: Map<string, EffectIntent>;
  idempotency: Map<string, string>;
  mutations: Map<string, EffectOperationCommitFrame>;
  acknowledgements: Map<string, EffectOutboxAcknowledgementFrame>;
  events: Map<string, EffectOutboxEvent>;
  eventByOperationRevision: Map<string, EffectOutboxEvent>;
  acknowledgedEventIds: Set<string>;
}

function idempotencyKey(identity: EffectOperationIdentity): string {
  return `${identity.idempotency.scope}\u0000${identity.idempotency.key}`;
}

function operationRevisionKey(operationId: string, revision: number): string {
  return `${operationId}\u0000${revision}`;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalEffectJson(left) === canonicalEffectJson(right);
}

function failIntegrity(sequence: number, detail: string): never {
  throw new EffectJournalIntegrityError(`Invalid effect journal frame ${sequence}: ${detail}`);
}

function verifyCommitBindings(
  frame: EffectOperationCommitFrame,
  previous: EffectIntent | undefined,
): void {
  const { operation, outboxEvent: event } = frame;
  if (frame.mutationId !== operation.lastMutationId) {
    failIntegrity(frame.sequence, "mutationId does not bind the operation snapshot");
  }
  if (frame.mutationId !== event.eventId) {
    failIntegrity(frame.sequence, "eventId must equal the stable mutationId");
  }
  if (frame.mutationDigest !== event.mutationDigest) {
    failIntegrity(frame.sequence, "mutation digest differs between commit and outbox event");
  }
  if (frame.sequence !== event.sequence) {
    failIntegrity(frame.sequence, "outbox sequence differs from commit sequence");
  }
  if (operation.revision !== event.operationRevision) {
    failIntegrity(frame.sequence, "outbox revision differs from operation revision");
  }
  if (!same(operation.identity, event.identity)) {
    failIntegrity(frame.sequence, "outbox identity differs from operation identity");
  }
  if (operation.state !== event.state || operation.updatedAt !== event.occurredAt) {
    failIntegrity(frame.sequence, "outbox state/time differs from operation snapshot");
  }
  if (frame.committedAt !== operation.updatedAt) {
    failIntegrity(frame.sequence, "commit time differs from operation update time");
  }
  if (operation.evidence?.evidenceDigest !== event.evidenceDigest) {
    failIntegrity(frame.sequence, "outbox evidence digest differs from operation evidence");
  }
  if (!previous) {
    if (
      operation.revision !== 1 ||
      operation.state !== "pending" ||
      event.previousState !== null ||
      event.eventType !== "effect.intent.recorded" ||
      operation.createdAt !== operation.updatedAt
    ) {
      failIntegrity(frame.sequence, "initial intent/event boundary is inconsistent");
    }
    return;
  }
  if (!same(previous.identity, operation.identity)) {
    failIntegrity(frame.sequence, "operation identity changed after intent persistence");
  }
  if (
    operation.revision !== previous.revision + 1 ||
    operation.createdAt !== previous.createdAt ||
    event.previousState !== previous.state ||
    event.eventType !== "effect.intent.state_changed"
  ) {
    failIntegrity(frame.sequence, "operation revision/event predecessor is inconsistent");
  }
  if (!canTransitionEffectIntent(previous.state, operation.state)) {
    failIntegrity(frame.sequence, `illegal transition ${previous.state} -> ${operation.state}`);
  }
  if (Date.parse(operation.updatedAt) < Date.parse(previous.updatedAt)) {
    failIntegrity(frame.sequence, "operation time moved backwards");
  }
}

function emptyReplayState(): ReplayState {
  return {
    sequence: 0,
    frameDigest: null,
    operations: new Map(),
    idempotency: new Map(),
    mutations: new Map(),
    acknowledgements: new Map(),
    events: new Map(),
    eventByOperationRevision: new Map(),
    acknowledgedEventIds: new Set(),
  };
}

function extendReplay(state: ReplayState, frames: readonly EffectJournalFrame[]): ReplayState {
  for (const raw of frames) {
    const frame = parseVerifiedEffectJournalFrame(raw);
    const expectedSequence = state.sequence + 1;
    if (frame.sequence !== expectedSequence) {
      failIntegrity(frame.sequence, `expected contiguous sequence ${expectedSequence}`);
    }
    if (frame.schema === "eigengrid.effect-journal-operation-commit.v1") {
      if (state.mutations.has(frame.mutationId) || state.acknowledgements.has(frame.mutationId)) {
        failIntegrity(frame.sequence, `duplicate mutation identity ${frame.mutationId}`);
      }
      if (state.events.has(frame.outboxEvent.eventId)) {
        failIntegrity(frame.sequence, `duplicate outbox event ${frame.outboxEvent.eventId}`);
      }
      const operationId = frame.operation.identity.operationId;
      const previous = state.operations.get(operationId);
      verifyCommitBindings(frame, previous);
      const key = idempotencyKey(frame.operation.identity);
      const indexedOperationId = state.idempotency.get(key);
      if (!previous && indexedOperationId && indexedOperationId !== operationId) {
        failIntegrity(frame.sequence, `idempotency key already binds ${indexedOperationId}`);
      }
      if (previous && indexedOperationId !== operationId) {
        failIntegrity(frame.sequence, "operation lost its idempotency binding");
      }
      state.operations.set(operationId, frame.operation);
      state.idempotency.set(key, operationId);
      state.mutations.set(frame.mutationId, frame);
      state.events.set(frame.outboxEvent.eventId, frame.outboxEvent);
      state.eventByOperationRevision.set(
        operationRevisionKey(operationId, frame.operation.revision),
        frame.outboxEvent,
      );
      state.sequence = frame.sequence;
      state.frameDigest = frame.frameDigest;
      continue;
    }

    if (
      state.acknowledgements.has(frame.acknowledgementId) ||
      state.mutations.has(frame.acknowledgementId)
    ) {
      failIntegrity(
        frame.sequence,
        `duplicate acknowledgement identity ${frame.acknowledgementId}`,
      );
    }
    if (!state.events.has(frame.eventId)) {
      failIntegrity(frame.sequence, `acknowledgement references unknown event ${frame.eventId}`);
    }
    if (state.acknowledgedEventIds.has(frame.eventId)) {
      failIntegrity(frame.sequence, `outbox event ${frame.eventId} is acknowledged twice`);
    }
    state.acknowledgements.set(frame.acknowledgementId, frame);
    state.acknowledgedEventIds.add(frame.eventId);
    state.sequence = frame.sequence;
    state.frameDigest = frame.frameDigest;
  }
  return state;
}

function replay(frames: readonly EffectJournalFrame[]): ReplayState {
  return extendReplay(emptyReplayState(), frames);
}

export interface EffectJournalSnapshot {
  sequence: number;
  operations: readonly EffectIntent[];
  outboxEvents: readonly EffectOutboxEvent[];
  pendingOutboxEvents: readonly EffectOutboxEvent[];
  acknowledgements: readonly EffectOutboxAcknowledgementFrame[];
}

export interface EffectJournalWriteResult {
  operation: EffectIntent;
  outboxEvent: EffectOutboxEvent;
  appended: boolean;
}

export interface EffectOutboxAcknowledgementResult {
  acknowledgement: EffectOutboxAcknowledgementFrame;
  appended: boolean;
}

function publicSnapshot(state: ReplayState): EffectJournalSnapshot {
  const events = [...state.events.values()].sort((left, right) => left.sequence - right.sequence);
  return {
    sequence: state.sequence,
    operations: clone([...state.operations.values()]).sort((left, right) =>
      left.identity.operationId.localeCompare(right.identity.operationId),
    ),
    outboxEvents: clone(events),
    pendingOutboxEvents: clone(
      events.filter((event) => !state.acknowledgedEventIds.has(event.eventId)),
    ),
    acknowledgements: clone([...state.acknowledgements.values()]).sort(
      (left, right) => left.sequence - right.sequence,
    ),
  };
}

const MAX_COMPARE_AND_APPEND_ATTEMPTS = 128;

export class EffectJournal {
  private projection?: ReplayState;
  private refresh: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: EffectJournalStore) {}

  private readState(): Promise<ReplayState> {
    const readAfter = this.store.readAfter;
    if (!readAfter) return this.store.read().then(replay);
    // Serialize projection refreshes, not durable writers. Independent journal
    // instances still compete through the store's compare-and-append boundary.
    const next = this.refresh.then(async () => {
      const state = this.projection ?? emptyReplayState();
      const cursor = { sequence: state.sequence, frameDigest: state.frameDigest };
      try {
        const tail = await readAfter.call(this.store, cursor);
        if (
          !same(tail.after, cursor) ||
          !Number.isSafeInteger(tail.head.sequence) ||
          tail.head.sequence !== cursor.sequence + tail.frames.length
        ) {
          throw new EffectJournalIntegrityError(
            "Incomplete or mismatched immutable journal suffix",
          );
        }
        extendReplay(state, tail.frames);
        if (state.sequence !== tail.head.sequence || state.frameDigest !== tail.head.frameDigest) {
          throw new EffectJournalIntegrityError(
            "Immutable journal head does not match verified suffix",
          );
        }
        this.projection = state;
        return state;
      } catch (error) {
        // A partially verified suffix must never become authority on a later call.
        this.projection = undefined;
        throw error;
      }
    });
    this.refresh = next.catch(() => undefined);
    return next;
  }

  async snapshot(): Promise<EffectJournalSnapshot> {
    return publicSnapshot(await this.readState());
  }

  async get(operationId: string): Promise<EffectIntent | undefined> {
    const state = await this.readState();
    const operation = state.operations.get(operationId);
    return operation ? clone(operation) : undefined;
  }

  async appendIntent(input: AppendEffectIntentInput): Promise<EffectJournalWriteResult> {
    const parsed = AppendEffectIntentInputSchema.parse(input);
    const mutationDigest = digestEffectValue(parsed);

    for (let attempt = 0; attempt < MAX_COMPARE_AND_APPEND_ATTEMPTS; attempt += 1) {
      const state = await this.readState();
      const priorMutation = state.mutations.get(parsed.mutationId);
      if (priorMutation) {
        if (priorMutation.mutationDigest !== mutationDigest) {
          throw new EffectJournalConflictError(
            `Mutation ${parsed.mutationId} was replayed with different content`,
          );
        }
        return {
          operation: clone(priorMutation.operation),
          outboxEvent: clone(priorMutation.outboxEvent),
          appended: false,
        };
      }
      if (state.acknowledgements.has(parsed.mutationId)) {
        throw new EffectJournalConflictError(
          `Mutation ${parsed.mutationId} collides with an outbox acknowledgement`,
        );
      }

      const existingOperation = state.operations.get(parsed.identity.operationId);
      if (existingOperation) {
        if (!same(existingOperation.identity, parsed.identity)) {
          throw new EffectJournalConflictError(
            `Operation ${parsed.identity.operationId} was replayed with a different identity or request digest`,
          );
        }
        return this.writeResultFor(state, existingOperation, false);
      }
      const indexedOperationId = state.idempotency.get(idempotencyKey(parsed.identity));
      if (indexedOperationId) {
        throw new EffectJournalConflictError(
          `Idempotency key ${parsed.identity.idempotency.scope}/${parsed.identity.idempotency.key} already binds operation ${indexedOperationId}`,
        );
      }

      const operation = EffectIntentSchema.parse({
        schema: "eigengrid.effect-intent.v1",
        identity: EffectOperationIdentitySchema.parse(parsed.identity),
        state: "pending",
        revision: 1,
        createdAt: parsed.at,
        updatedAt: parsed.at,
        lastMutationId: parsed.mutationId,
      });
      const event: EffectOutboxEvent = {
        schema: "eigengrid.effect-outbox-event.v1",
        eventId: parsed.mutationId,
        eventType: "effect.intent.recorded",
        sequence: state.sequence + 1,
        operationRevision: 1,
        identity: operation.identity,
        previousState: null,
        state: "pending",
        occurredAt: parsed.at,
        mutationDigest,
      };
      const frame = sealEffectJournalFrame({
        schema: "eigengrid.effect-journal-operation-commit.v1",
        sequence: state.sequence + 1,
        mutationId: parsed.mutationId,
        mutationDigest,
        committedAt: parsed.at,
        operation,
        outboxEvent: event,
      });
      if (await this.store.compareAndAppend(state.sequence, frame)) {
        return { operation: clone(operation), outboxEvent: clone(event), appended: true };
      }
    }
    throw new EffectJournalContentionError(MAX_COMPARE_AND_APPEND_ATTEMPTS);
  }

  async reconcile(input: ReconcileEffectIntentInput): Promise<EffectJournalWriteResult> {
    const parsed = ReconcileEffectIntentInputSchema.parse(input);
    const mutationDigest = digestEffectValue(parsed);

    for (let attempt = 0; attempt < MAX_COMPARE_AND_APPEND_ATTEMPTS; attempt += 1) {
      const state = await this.readState();
      const priorMutation = state.mutations.get(parsed.mutationId);
      if (priorMutation) {
        if (priorMutation.mutationDigest !== mutationDigest) {
          throw new EffectJournalConflictError(
            `Mutation ${parsed.mutationId} was replayed with different content`,
          );
        }
        return {
          operation: clone(priorMutation.operation),
          outboxEvent: clone(priorMutation.outboxEvent),
          appended: false,
        };
      }
      if (state.acknowledgements.has(parsed.mutationId)) {
        throw new EffectJournalConflictError(
          `Mutation ${parsed.mutationId} collides with an outbox acknowledgement`,
        );
      }

      const previous = state.operations.get(parsed.operationId);
      if (!previous) {
        throw new EffectJournalConflictError(`Unknown effect operation ${parsed.operationId}`);
      }
      if (previous.identity.requestDigest !== parsed.requestDigest) {
        throw new EffectJournalConflictError(
          `Operation ${parsed.operationId} request digest does not match its durable intent`,
        );
      }
      if (previous.state === parsed.state && same(previous.evidence, parsed.evidence)) {
        return this.writeResultFor(state, previous, false);
      }
      if (previous.revision !== parsed.expectedRevision) {
        throw new EffectJournalRevisionConflictError(
          parsed.operationId,
          parsed.expectedRevision,
          previous.revision,
        );
      }
      if (!canTransitionEffectIntent(previous.state, parsed.state)) {
        throw new InvalidEffectIntentTransitionError(previous.state, parsed.state);
      }
      if (Date.parse(parsed.at) < Date.parse(previous.updatedAt)) {
        throw new EffectJournalConflictError(
          `Operation ${parsed.operationId} reconciliation time precedes its durable state`,
        );
      }

      const operation = EffectIntentSchema.parse({
        ...previous,
        state: parsed.state,
        revision: previous.revision + 1,
        updatedAt: parsed.at,
        lastMutationId: parsed.mutationId,
        evidence: parsed.evidence,
      });
      const event: EffectOutboxEvent = {
        schema: "eigengrid.effect-outbox-event.v1",
        eventId: parsed.mutationId,
        eventType: "effect.intent.state_changed",
        sequence: state.sequence + 1,
        operationRevision: operation.revision,
        identity: operation.identity,
        previousState: previous.state,
        state: operation.state,
        occurredAt: parsed.at,
        mutationDigest,
        evidenceDigest: parsed.evidence.evidenceDigest,
      };
      const frame = sealEffectJournalFrame({
        schema: "eigengrid.effect-journal-operation-commit.v1",
        sequence: state.sequence + 1,
        mutationId: parsed.mutationId,
        mutationDigest,
        committedAt: parsed.at,
        operation,
        outboxEvent: event,
      });
      if (await this.store.compareAndAppend(state.sequence, frame)) {
        return { operation: clone(operation), outboxEvent: clone(event), appended: true };
      }
    }
    throw new EffectJournalContentionError(MAX_COMPARE_AND_APPEND_ATTEMPTS);
  }

  async acknowledgeOutbox(
    input: AcknowledgeEffectOutboxInput,
  ): Promise<EffectOutboxAcknowledgementResult> {
    const parsed = AcknowledgeEffectOutboxInputSchema.parse(input);
    for (let attempt = 0; attempt < MAX_COMPARE_AND_APPEND_ATTEMPTS; attempt += 1) {
      const state = await this.readState();
      if (state.mutations.has(parsed.acknowledgementId)) {
        throw new EffectJournalConflictError(
          `Acknowledgement ${parsed.acknowledgementId} collides with an operation mutation`,
        );
      }
      const prior = state.acknowledgements.get(parsed.acknowledgementId);
      if (prior) {
        if (
          prior.eventId !== parsed.eventId ||
          prior.consumerId !== parsed.consumerId ||
          prior.deliveredAt !== parsed.deliveredAt
        ) {
          throw new EffectJournalConflictError(
            `Acknowledgement ${parsed.acknowledgementId} was replayed with different content`,
          );
        }
        return { acknowledgement: clone(prior), appended: false };
      }
      if (!state.events.has(parsed.eventId)) {
        throw new EffectJournalConflictError(`Unknown outbox event ${parsed.eventId}`);
      }
      if (state.acknowledgedEventIds.has(parsed.eventId)) {
        const existing = [...state.acknowledgements.values()].find(
          (acknowledgement) => acknowledgement.eventId === parsed.eventId,
        );
        if (!existing) failIntegrity(state.sequence, "outbox acknowledgement index is corrupt");
        return { acknowledgement: clone(existing), appended: false };
      }
      const acknowledgement = sealEffectJournalFrame({
        schema: "eigengrid.effect-journal-outbox-ack.v1",
        sequence: state.sequence + 1,
        acknowledgementId: parsed.acknowledgementId,
        eventId: parsed.eventId,
        consumerId: parsed.consumerId,
        deliveredAt: parsed.deliveredAt,
      });
      if (acknowledgement.schema !== "eigengrid.effect-journal-outbox-ack.v1") {
        throw new EffectJournalIntegrityError("Sealed acknowledgement has the wrong schema");
      }
      if (await this.store.compareAndAppend(state.sequence, acknowledgement)) {
        return { acknowledgement: clone(acknowledgement), appended: true };
      }
    }
    throw new EffectJournalContentionError(MAX_COMPARE_AND_APPEND_ATTEMPTS);
  }

  private writeResultFor(
    state: ReplayState,
    operation: EffectIntent,
    appended: boolean,
  ): EffectJournalWriteResult {
    const event = state.eventByOperationRevision.get(
      operationRevisionKey(operation.identity.operationId, operation.revision),
    );
    if (!event) {
      throw new EffectJournalIntegrityError(
        `Operation ${operation.identity.operationId} revision ${operation.revision} has no outbox event`,
      );
    }
    return { operation: clone(operation), outboxEvent: clone(event), appended };
  }
}
