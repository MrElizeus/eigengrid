import { describe, expect, test } from "bun:test";
import {
  EFFECT_INTENT_STATES,
  EffectIntentSchema,
  EffectJournalFrameSchema,
  EffectOperationIdentitySchema,
  RequestDigestSchema,
  type EffectEvidence,
  type EffectIntentState,
  type EffectOperationIdentity,
} from "./schemas";
import {
  bindEffectOperationIdentity,
  canonicalEffectJson,
  digestEffectRequest,
  digestEffectValue,
  sealEffectJournalFrame,
} from "./digest";
import {
  EffectJournal,
  EffectJournalConflictError,
  EffectJournalIntegrityError,
  EffectJournalRevisionConflictError,
  InMemoryEffectJournalStore,
  InvalidEffectIntentTransitionError,
  VALID_EFFECT_INTENT_TRANSITIONS,
  canTransitionEffectIntent,
} from "./journal";

const BASE_TIME = Date.parse("2026-08-30T12:00:00.000Z");

function at(offset: number): string {
  return new Date(BASE_TIME + offset * 1_000).toISOString();
}

function identity(
  seed: string,
  request: unknown = { command: "run", seed },
): EffectOperationIdentity {
  return bindEffectOperationIdentity(
    {
      operationId: `operation:${seed}`,
      operationKind: "compute.submit",
      aggregate: { type: "mission-work-unit", id: `work:${seed}` },
      idempotency: { scope: `mission:${seed}`, key: `submit:${seed}` },
      correlationId: `correlation:${seed}`,
    },
    request,
  );
}

function evidence(state: Exclude<EffectIntentState, "pending">, seed: string): EffectEvidence {
  const kind: EffectEvidence["kind"] = {
    submitted: "transmission",
    ambiguous: "ambiguity",
    confirmed: "receipt",
    failed: "failure",
    cancel_requested: "cancel_request",
    cancelled: "receipt",
  }[state] as EffectEvidence["kind"];
  return {
    kind,
    source: `adapter:${seed}`,
    evidenceDigest: digestEffectValue({ state, seed }),
    detail: `${state} evidence for ${seed}`,
  };
}

async function journalAtState(
  state: EffectIntentState,
  seed: string,
): Promise<{ journal: EffectJournal; store: InMemoryEffectJournalStore }> {
  const store = new InMemoryEffectJournalStore();
  const journal = new EffectJournal(store);
  const operationIdentity = identity(seed);
  await journal.appendIntent({
    mutationId: `mutation:${seed}:pending`,
    identity: operationIdentity,
    at: at(0),
  });
  const paths: Record<EffectIntentState, Exclude<EffectIntentState, "pending">[]> = {
    pending: [],
    submitted: ["submitted"],
    ambiguous: ["ambiguous"],
    confirmed: ["confirmed"],
    failed: ["failed"],
    cancel_requested: ["cancel_requested"],
    cancelled: ["cancel_requested", "cancelled"],
  };
  let revision = 1;
  for (const [index, next] of paths[state].entries()) {
    await journal.reconcile({
      mutationId: `mutation:${seed}:${next}:${index}`,
      operationId: operationIdentity.operationId,
      requestDigest: operationIdentity.requestDigest,
      expectedRevision: revision,
      state: next,
      at: at(index + 1),
      evidence: evidence(next, `${seed}:${index}`),
    });
    revision += 1;
  }
  return { journal, store };
}

describe("effect journal strict contracts", () => {
  test("binds stable operation identity to canonical request content", () => {
    const left = digestEffectRequest({ z: [3, 2, 1], a: { two: 2, one: 1 } });
    const right = digestEffectRequest({ a: { one: 1, two: 2 }, z: [3, 2, 1] });
    expect(left).toBe(right);
    expect(RequestDigestSchema.parse(left)).toBe(left);
    expect(identity("canonical").requestDigest).toBe(
      digestEffectRequest({ command: "run", seed: "canonical" }),
    );
  });

  test("rejects non-JSON requests, non-canonical ambiguity, bad digests, and unknown authority", () => {
    expect(() => digestEffectRequest({ value: undefined })).toThrow(
      "Cannot canonicalize undefined",
    );
    expect(() => digestEffectRequest({ value: Number.NaN })).toThrow("non-finite");
    expect(() => digestEffectRequest(new Date())).toThrow("non-plain");
    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = "present";
    expect(() => digestEffectRequest(sparse)).toThrow("sparse");

    const valid = identity("strict");
    expect(
      EffectOperationIdentitySchema.safeParse({ ...valid, inventedAuthority: true }).success,
    ).toBe(false);
    expect(
      EffectOperationIdentitySchema.safeParse({
        ...valid,
        requestDigest: `sha256:${"A".repeat(64)}`,
      }).success,
    ).toBe(false);
    expect(
      EffectOperationIdentitySchema.safeParse({
        ...valid,
        idempotency: { ...valid.idempotency, key: "contains whitespace" },
      }).success,
    ).toBe(false);
  });

  test("defines exactly the required intent states and state-bound evidence", () => {
    expect(EFFECT_INTENT_STATES).toEqual([
      "pending",
      "submitted",
      "ambiguous",
      "confirmed",
      "failed",
      "cancel_requested",
      "cancelled",
    ]);
    const operationIdentity = identity("evidence");
    expect(
      EffectIntentSchema.safeParse({
        schema: "eigengrid.effect-intent.v1",
        identity: operationIdentity,
        state: "pending",
        revision: 1,
        createdAt: at(0),
        updatedAt: at(0),
        lastMutationId: "mutation:evidence:pending",
        evidence: evidence("confirmed", "impossible"),
      }).success,
    ).toBe(false);
    expect(
      EffectIntentSchema.safeParse({
        schema: "eigengrid.effect-intent.v1",
        identity: operationIdentity,
        state: "confirmed",
        revision: 2,
        createdAt: at(0),
        updatedAt: at(1),
        lastMutationId: "mutation:evidence:confirmed",
        evidence: evidence("ambiguous", "wrong-kind"),
      }).success,
    ).toBe(false);
  });

  test("strictly rejects unknown properties on every persisted frame envelope", async () => {
    const { store } = await journalAtState("submitted", "frame-strict");
    const [frame] = await store.read();
    expect(EffectJournalFrameSchema.safeParse({ ...frame, inventedAuthority: true }).success).toBe(
      false,
    );
    if (frame?.schema !== "eigengrid.effect-journal-operation-commit.v1") {
      throw new Error("expected operation frame");
    }
    expect(
      EffectJournalFrameSchema.safeParse({
        ...frame,
        operation: { ...frame.operation, inventedAuthority: true },
      }).success,
    ).toBe(false);
    expect(
      EffectJournalFrameSchema.safeParse({
        ...frame,
        outboxEvent: { ...frame.outboxEvent, inventedAuthority: true },
      }).success,
    ).toBe(false);
  });
});

describe("effect intent transition and idempotency contract", () => {
  const expected: Readonly<Record<EffectIntentState, readonly EffectIntentState[]>> = {
    pending: ["submitted", "ambiguous", "confirmed", "failed", "cancel_requested"],
    submitted: ["ambiguous", "confirmed", "failed", "cancel_requested"],
    ambiguous: ["submitted", "confirmed", "failed", "cancel_requested", "cancelled"],
    confirmed: [],
    failed: [],
    cancel_requested: ["ambiguous", "confirmed", "failed", "cancelled"],
    cancelled: [],
  };

  test("enumerates every legal, illegal, and same-state/no-op transition", async () => {
    expect(VALID_EFFECT_INTENT_TRANSITIONS).toEqual(expected);
    for (const from of EFFECT_INTENT_STATES) {
      for (const to of EFFECT_INTENT_STATES) {
        expect(canTransitionEffectIntent(from, to)).toBe(expected[from].includes(to));
      }
    }

    let caseNumber = 0;
    for (const from of EFFECT_INTENT_STATES) {
      if (from === "pending") {
        const { journal } = await journalAtState("pending", `noop-${caseNumber++}`);
        const operationIdentity = identity(`noop-${caseNumber - 1}`);
        const replayed = await journal.appendIntent({
          mutationId: `mutation:noop-${caseNumber - 1}:pending`,
          identity: operationIdentity,
          at: at(0),
        });
        expect(replayed.appended).toBe(false);
      }
      for (const to of EFFECT_INTENT_STATES.filter(
        (candidate): candidate is Exclude<EffectIntentState, "pending"> => candidate !== "pending",
      )) {
        const seed = `matrix-${caseNumber++}`;
        const { journal } = await journalAtState(from, seed);
        const current = await journal.get(`operation:${seed}`);
        if (!current) throw new Error("operation missing");
        const input = {
          mutationId: `mutation:${seed}:try:${to}`,
          operationId: current.identity.operationId,
          requestDigest: current.identity.requestDigest,
          expectedRevision: current.revision,
          state: to,
          at: at(20),
          evidence: to === from && current.evidence ? current.evidence : evidence(to, seed),
        };
        if (to === from) {
          const result = await journal.reconcile(input);
          expect(result.appended).toBe(false);
          expect(result.operation.revision).toBe(current.revision);
        } else if (expected[from].includes(to)) {
          const result = await journal.reconcile(input);
          expect(result.appended).toBe(true);
          expect(result.operation.state).toBe(to);
          expect(result.operation.revision).toBe(current.revision + 1);
        } else {
          await expect(journal.reconcile(input)).rejects.toBeInstanceOf(
            InvalidEffectIntentTransitionError,
          );
        }
      }
    }
  });

  test("atomically appends intent plus outbox and replays exact or semantic duplicates", async () => {
    const store = new InMemoryEffectJournalStore();
    const journal = new EffectJournal(store);
    const operationIdentity = identity("append");
    const input = { mutationId: "mutation:append", identity: operationIdentity, at: at(0) };

    const created = await journal.appendIntent(input);
    const exactReplay = await journal.appendIntent(input);
    const idempotencyReplay = await journal.appendIntent({
      ...input,
      mutationId: "mutation:append:retry",
    });
    expect(created.appended).toBe(true);
    expect(exactReplay.appended).toBe(false);
    expect(idempotencyReplay.appended).toBe(false);
    expect(await store.read()).toHaveLength(1);
    expect(created.outboxEvent).toMatchObject({
      eventId: "mutation:append",
      state: "pending",
      previousState: null,
      operationRevision: 1,
    });

    const [frame] = await store.read();
    expect(frame?.schema).toBe("eigengrid.effect-journal-operation-commit.v1");
    if (frame?.schema === "eigengrid.effect-journal-operation-commit.v1") {
      expect(frame.operation).toEqual(created.operation);
      expect(frame.outboxEvent).toEqual(created.outboxEvent);
    }
  });

  test("fails closed on operation, request, idempotency, and mutation identity conflicts", async () => {
    const store = new InMemoryEffectJournalStore();
    const journal = new EffectJournal(store);
    const original = identity("conflict");
    await journal.appendIntent({ mutationId: "mutation:conflict", identity: original, at: at(0) });

    const changedRequest = identity("conflict", { command: "different" });
    await expect(
      journal.appendIntent({
        mutationId: "mutation:conflict:request",
        identity: changedRequest,
        at: at(1),
      }),
    ).rejects.toBeInstanceOf(EffectJournalConflictError);

    const changedOperation = EffectOperationIdentitySchema.parse({
      ...original,
      operationId: "operation:other",
    });
    await expect(
      journal.appendIntent({
        mutationId: "mutation:conflict:idempotency",
        identity: changedOperation,
        at: at(1),
      }),
    ).rejects.toBeInstanceOf(EffectJournalConflictError);

    await expect(
      journal.appendIntent({ mutationId: "mutation:conflict", identity: original, at: at(2) }),
    ).rejects.toBeInstanceOf(EffectJournalConflictError);
    expect(await store.read()).toHaveLength(1);
  });

  test("reconciles exact observations idempotently and rejects stale or mismatched authority", async () => {
    const { journal, store } = await journalAtState("pending", "reconcile");
    const operationIdentity = identity("reconcile");
    const input = {
      mutationId: "mutation:reconcile:confirmed",
      operationId: operationIdentity.operationId,
      requestDigest: operationIdentity.requestDigest,
      expectedRevision: 1,
      state: "confirmed" as const,
      at: at(2),
      evidence: evidence("confirmed", "reconcile"),
    };
    const first = await journal.reconcile(input);
    const replay = await journal.reconcile(input);
    const semanticReplay = await journal.reconcile({ ...input, mutationId: "mutation:other" });
    expect(first.appended).toBe(true);
    expect(replay.appended).toBe(false);
    expect(semanticReplay.appended).toBe(false);
    expect(await store.read()).toHaveLength(2);

    await expect(
      journal.reconcile({
        ...input,
        mutationId: "mutation:bad-digest",
        requestDigest: digestEffectValue("different"),
      }),
    ).rejects.toBeInstanceOf(EffectJournalConflictError);
    await expect(
      journal.reconcile({
        ...input,
        mutationId: "mutation:stale",
        state: "cancel_requested",
        evidence: evidence("cancel_requested", "stale"),
      }),
    ).rejects.toBeInstanceOf(EffectJournalRevisionConflictError);
  });

  test("acknowledges outbox delivery idempotently without mutating immutable events", async () => {
    const { journal, store } = await journalAtState("submitted", "outbox");
    const before = await journal.snapshot();
    expect(before.pendingOutboxEvents).toHaveLength(2);
    const event = before.pendingOutboxEvents[0]!;
    const input = {
      acknowledgementId: "ack:outbox:1",
      eventId: event.eventId,
      consumerId: "consumer:test",
      deliveredAt: at(10),
    };
    const first = await journal.acknowledgeOutbox(input);
    const replay = await journal.acknowledgeOutbox(input);
    const semanticReplay = await journal.acknowledgeOutbox({
      ...input,
      acknowledgementId: "ack:outbox:retry",
    });
    expect(first.appended).toBe(true);
    expect(replay.appended).toBe(false);
    expect(semanticReplay.appended).toBe(false);
    const after = await journal.snapshot();
    expect(after.outboxEvents).toEqual(before.outboxEvents);
    expect(after.pendingOutboxEvents.map(({ eventId }) => eventId)).not.toContain(event.eventId);
    expect(after.acknowledgements).toHaveLength(1);
    expect(await store.read()).toHaveLength(3);

    await expect(
      journal.acknowledgeOutbox({ ...input, deliveredAt: at(11) }),
    ).rejects.toBeInstanceOf(EffectJournalConflictError);
  });
});

describe("effect journal replay integrity", () => {
  test("reconstructs identical aggregate and pending outbox state after restart", async () => {
    const store = new InMemoryEffectJournalStore();
    const first = new EffectJournal(store);
    const operationIdentity = identity("restart");
    await first.appendIntent({
      mutationId: "mutation:restart:pending",
      identity: operationIdentity,
      at: at(0),
    });
    await first.reconcile({
      mutationId: "mutation:restart:ambiguous",
      operationId: operationIdentity.operationId,
      requestDigest: operationIdentity.requestDigest,
      expectedRevision: 1,
      state: "ambiguous",
      at: at(1),
      evidence: evidence("ambiguous", "restart"),
    });
    const before = await first.snapshot();
    const after = await new EffectJournal(store).snapshot();
    expect(after).toEqual(before);
    expect(after.operations[0]).toMatchObject({ state: "ambiguous", revision: 2 });
  });

  test("rejects canonical digest tampering and semantically contradictory replay", async () => {
    const { store } = await journalAtState("submitted", "tamper");
    const frames = await store.read();
    const first = frames[0];
    expect(first).toBeDefined();
    const badDigest = {
      ...first,
      frameDigest: digestEffectValue("tampered"),
    } as (typeof frames)[number];
    expect(() => new InMemoryEffectJournalStore([badDigest])).toThrow("digest mismatch");

    const second = frames[1];
    if (second?.schema !== "eigengrid.effect-journal-operation-commit.v1") {
      throw new Error("expected transition frame");
    }
    const { frameDigest: _frameDigest, ...unsignedSecond } = second;
    const contradictory = sealEffectJournalFrame({
      ...unsignedSecond,
      outboxEvent: { ...second.outboxEvent, previousState: "failed" as const },
    });
    await expect(
      new EffectJournal(new InMemoryEffectJournalStore([frames[0]!, contradictory])).snapshot(),
    ).rejects.toBeInstanceOf(EffectJournalIntegrityError);
  });

  test("canonical JSON normalizes Unicode and remains independent of insertion order", () => {
    expect(canonicalEffectJson({ "e\u0301": "e\u0301", b: 2 })).toBe(
      canonicalEffectJson({ b: 2, "\u00e9": "\u00e9" }),
    );
  });
});
