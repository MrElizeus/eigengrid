import { describe, expect, test } from "bun:test";
import Ajv2020 from "../../packages/colony-contracts/node_modules/ajv/dist/2020.js";
import {
  DurablePublicOperationJournal,
  MemoryPublicOperationJournal,
  MyrmexOperationBroker,
  MyrmexOperationReceiptSchema,
  MyrmexOperationRequestSchema,
  PublicDateTimeSchema,
  PublicProtocolVersion,
  PublicReceiptSchemaVersion,
  computeMyrmexReceiptDigest,
  computeMyrmexRequestDigest,
  createMyrmexOperationRequest,
  isStrictRfc3339DateTime,
  verifyMyrmexOperationRequest,
  verifyMyrmexOperationReceipt,
  type PublicCompatibility,
  type MyrmexOperationReceipt,
  type PublicOperationJournal,
  type PublicOperationJournalEntry,
} from "@eigengrid/protocol";
import { appendFile, readFile, readdir, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContendingProcesses } from "./helpers/process-contention";

const compatibility: PublicCompatibility = {
  eigengridVersion: "0.1.0",
  publicProtocol: PublicProtocolVersion,
  missionProtocol: "eigengrid.scientific/v1",
  colonySchema: "eigengrid.colony-contracts/v1",
  skillSchema: "eigengrid.scientific-skill/v1",
  evidenceSchema: "eigengrid.evidence/v1",
  profileVersion: "myrmex-profile/v1",
  codexSubstrateRange: "rust-v0.151.x",
  featureFlags: ["incident-bundle"],
};

function request(overrides: Record<string, unknown> = {}) {
  return createMyrmexOperationRequest({
    requestId: "req-1",
    idempotencyKey: "idem-1",
    installationId: "myrmex-test",
    runId: "run-1",
    principalId: "myrmex-profile",
    operation: "inspect_mission",
    compatibility,
    subject: { type: "mission", id: "mission-1", revision: 1, digest: `sha256:${"a".repeat(64)}` },
    payload: {},
    authorityEvidence: [],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  });
}

function inspectMissionPolicy() {
  return {
    allowedOperations: new Set(["inspect_mission"]),
    readOnlyOperations: new Set(["inspect_mission"]),
  };
}

function journalEntry(
  value: ReturnType<typeof request>,
  state: MyrmexOperationReceipt["state"] = "pending",
  receiptCompatibility: PublicCompatibility = value.compatibility,
): PublicOperationJournalEntry {
  const base: Omit<MyrmexOperationReceipt, "receiptDigest"> = {
    schema: PublicReceiptSchemaVersion,
    requestId: value.requestId,
    operationId: `operation-${value.idempotencyKey}`,
    idempotencyKey: value.idempotencyKey,
    state,
    subject: value.subject,
    correlationId: value.runId,
    causationId: value.requestId,
    compatibility: receiptCompatibility,
    confirmedAt: new Date().toISOString(),
    result: state === "confirmed" ? { status: "observed" } : null,
    failure: state === "confirmed" ? null : { code: `STATE_${state.toUpperCase()}` },
  };
  return {
    key: `${value.installationId}:${value.idempotencyKey}`,
    requestDigest: value.requestDigest,
    request: value,
    receipt: {
      ...base,
      receiptDigest: computeMyrmexReceiptDigest(base),
    },
  };
}

describe("eigengrid.public.v1", () => {
  test("creates and verifies canonical request digests", () => {
    const value = request();
    expect(verifyMyrmexOperationRequest(value)).toEqual({ ok: true, value });
    expect(computeMyrmexRequestDigest(value)).toBe(value.requestDigest);
  });

  test("keeps the normative Draft 2020-12 schema in runtime parity", async () => {
    const schema = (await Bun.file(
      new URL("../../packages/protocol/schemas/public-operation.schema.json", import.meta.url),
    ).json()) as Record<string, unknown>;
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    ajv.addFormat("date-time", {
      type: "string",
      validate: isStrictRfc3339DateTime,
    });
    expect(ajv.validateSchema(schema), ajv.errorsText()).toBe(true);
    const validate = ajv.compile(schema);
    const validRequest = request({
      idempotencyKey: "schema-parity",
      authorityEvidence: [
        {
          kind: "owner-approval",
          id: "approval-schema",
          digest: `sha256:${"b".repeat(64)}`,
          detail: { source: "head" },
        },
      ],
    });
    const validReceipt = journalEntry(validRequest, "confirmed").receipt;
    for (const value of [validRequest, validReceipt]) {
      expect(validate(value), ajv.errorsText(validate.errors)).toBe(true);
    }
    expect(MyrmexOperationRequestSchema.safeParse(validRequest).success).toBe(true);
    expect(MyrmexOperationReceiptSchema.safeParse(validReceipt).success).toBe(true);
    expect(validReceipt.result).toEqual({ status: "observed" });

    const validDateTimes = [
      "2024-02-29T23:59:59.123Z",
      "2026-01-01T00:00:00+23:59",
      "2026-01-01T00:00:00-00:00",
    ];
    for (const dateTime of validDateTimes) {
      expect(isStrictRfc3339DateTime(dateTime)).toBe(true);
      expect(PublicDateTimeSchema.safeParse(dateTime).success).toBe(true);
      expect(
        validate({ ...validRequest, expiresAt: dateTime }),
        ajv.errorsText(validate.errors),
      ).toBe(true);
      expect(
        validate({ ...validReceipt, confirmedAt: dateTime }),
        ajv.errorsText(validate.errors),
      ).toBe(true);
    }

    const invalidDateTimes = [
      "2026-02-29T00:00:00Z",
      "2026-04-31T00:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-01-01T00:00:00+24:00",
      "2026-01-01T00:00:00+00:60",
    ];
    for (const dateTime of invalidDateTimes) {
      expect(isStrictRfc3339DateTime(dateTime)).toBe(false);
      expect(PublicDateTimeSchema.safeParse(dateTime).success).toBe(false);
      const invalidRequest = { ...validRequest, expiresAt: dateTime };
      expect(MyrmexOperationRequestSchema.safeParse(invalidRequest).success).toBe(false);
      expect(validate(invalidRequest), ajv.errorsText(validate.errors)).toBe(false);
      const invalidReceipt = { ...validReceipt, confirmedAt: dateTime };
      expect(MyrmexOperationReceiptSchema.safeParse(invalidReceipt).success).toBe(false);
      expect(validate(invalidReceipt), ajv.errorsText(validate.errors)).toBe(false);
    }

    const emptyRequestFields = [
      "requestId",
      "idempotencyKey",
      "installationId",
      "runId",
      "principalId",
      "operation",
    ].map((field) => ({ ...validRequest, [field]: "" }));
    const emptyCompatibilityFields = [
      "eigengridVersion",
      "publicProtocol",
      "missionProtocol",
      "colonySchema",
      "skillSchema",
      "evidenceSchema",
      "profileVersion",
      "codexSubstrateRange",
    ].map((field) => ({
      ...validRequest,
      compatibility: { ...validRequest.compatibility, [field]: "" },
    }));
    const invalidRequests: unknown[] = [
      ...emptyRequestFields,
      ...emptyCompatibilityFields,
      { ...validRequest, idempotencyKey: "x".repeat(257) },
      { ...validRequest, operation: "x".repeat(161) },
      {
        ...validRequest,
        compatibility: { ...validRequest.compatibility, databaseSchemaInformational: 0 },
      },
      {
        ...validRequest,
        compatibility: { ...validRequest.compatibility, featureFlags: [""] },
      },
      {
        ...validRequest,
        compatibility: { ...validRequest.compatibility, unknownCompatibilityField: true },
      },
      { ...validRequest, subject: { ...validRequest.subject, type: "" } },
      { ...validRequest, subject: { ...validRequest.subject, id: "" } },
      { ...validRequest, subject: { ...validRequest.subject, revision: 0 } },
      { ...validRequest, subject: { ...validRequest.subject, revision: "" } },
      { ...validRequest, subject: { ...validRequest.subject, unknownSubjectField: true } },
      { ...validRequest, authorityEvidence: [{}] },
      { ...validRequest, authorityEvidence: [{ kind: "" }] },
      { ...validRequest, authorityEvidence: [{ kind: "approval", id: "" }] },
      { ...validRequest, authorityEvidence: [{ kind: "approval", unknownEvidenceField: true }] },
      { ...validRequest, authorityEvidence: [{ kind: "approval", detail: [] }] },
      { ...validRequest, payload: [] },
      { ...validRequest, expiresAt: "not-a-date" },
      { ...validRequest, unknownRequestField: true },
    ];
    for (const value of invalidRequests) {
      expect(MyrmexOperationRequestSchema.safeParse(value).success).toBe(false);
      expect(validate(value), ajv.errorsText(validate.errors)).toBe(false);
    }

    const emptyReceiptFields = [
      "requestId",
      "operationId",
      "idempotencyKey",
      "correlationId",
      "causationId",
    ].map((field) => ({ ...validReceipt, [field]: "" }));
    const invalidReceipts: unknown[] = [
      ...emptyReceiptFields,
      {
        ...validReceipt,
        compatibility: { ...validReceipt.compatibility, missionProtocol: "" },
      },
      { ...validReceipt, subject: { ...validReceipt.subject, revision: 0 } },
      { ...validReceipt, confirmedAt: "not-a-date" },
      { ...validReceipt, state: "unknown" },
      { ...validReceipt, result: null },
      { ...validReceipt, failure: { code: "IMPOSSIBLE_CONFIRMED_FAILURE" } },
      { ...validReceipt, result: [] },
      { ...validReceipt, unknownReceiptField: true },
      { ...validReceipt, state: "pending", result: { shouldBeNull: true }, failure: null },
      { ...validReceipt, state: "pending", result: null, failure: [] },
    ];
    for (const value of invalidReceipts) {
      expect(MyrmexOperationReceiptSchema.safeParse(value).success).toBe(false);
      expect(validate(value), ajv.errorsText(validate.errors)).toBe(false);
    }
  });

  test("fails closed on tampering, expiry, and incompatible profile", async () => {
    const value = request();
    const tampered = { ...value, payload: { mutation: true } };
    expect(verifyMyrmexOperationRequest(tampered).ok).toBe(false);

    const broker = new MyrmexOperationBroker({
      compatibility,
      policy: {
        ...inspectMissionPolicy(),
        allowedPrincipals: new Set(["myrmex-profile"]),
      },
      execute: async () => ({ state: "confirmed" as const, result: {} }),
    });
    const expired = request({
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      idempotencyKey: "expired",
    });
    expect((await broker.handle(expired)).state).toBe("denied");
    const incompatible = request({
      idempotencyKey: "incompatible",
      compatibility: { ...compatibility, profileVersion: "myrmex-profile/v2" },
    });
    expect((await broker.handle(incompatible)).state).toBe("denied");
  });

  test("durably journals observed compatibility on an incompatible denial", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eigengrid-public-compatibility-"));
    const journalPath = join(directory, "operations.jsonl");
    try {
      const journal = new DurablePublicOperationJournal(journalPath);
      const broker = new MyrmexOperationBroker({
        compatibility,
        journal,
        policy: inspectMissionPolicy(),
        execute: async () => ({ state: "confirmed", result: {} }),
      });
      const value = request({
        idempotencyKey: "durable-incompatible",
        compatibility: { ...compatibility, profileVersion: "myrmex-profile/v2" },
      });

      const denied = await broker.handle(value);
      expect(denied).toMatchObject({
        state: "denied",
        compatibility,
        result: null,
        failure: { code: "INCOMPATIBLE_PROFILE" },
      });
      expect((await journal.get("myrmex-test:durable-incompatible"))?.receipt).toEqual(denied);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("same idempotency key is exactly one logical effect", async () => {
    let calls = 0;
    const broker = new MyrmexOperationBroker({
      compatibility,
      policy: inspectMissionPolicy(),
      execute: async () => {
        calls += 1;
        return { state: "confirmed" as const, result: {} };
      },
    });
    const value = request();
    const first = await broker.handle(value);
    const second = await broker.handle(value);
    expect(second).toEqual(first);
    expect(first.result).toEqual({});
    expect(first.failure).toBeNull();
    expect(calls).toBe(1);
  });

  test("requires Head authority validation for mutations but permits explicit read-only calls", async () => {
    let mutationCalls = 0;
    const mutation = request({
      operation: "mutate_mission",
      idempotencyKey: "authority-mutation",
      authorityEvidence: [{ kind: "owner-approval", id: "approval-1" }],
    });
    const missingValidator = new MyrmexOperationBroker({
      compatibility,
      policy: {
        allowedOperations: new Set(["mutate_mission"]),
        readOnlyOperations: new Set(),
      },
      execute: async () => {
        mutationCalls += 1;
        return { state: "confirmed", result: {} };
      },
    });
    const denied = await missingValidator.handle(mutation);
    expect(denied).toMatchObject({
      state: "denied",
      failure: { code: "HEAD_AUTHORITY_VALIDATOR_REQUIRED" },
    });
    expect(mutationCalls).toBe(0);

    let validations = 0;
    const authorized = new MyrmexOperationBroker({
      compatibility,
      policy: {
        allowedOperations: new Set(["mutate_mission"]),
        readOnlyOperations: new Set(),
        validateAuthority: ({ request: candidate }) => {
          validations += 1;
          return {
            authorized: candidate.authorityEvidence.some(
              (evidence) => evidence.kind === "owner-approval" && evidence.id === "approval-1",
            ),
          };
        },
      },
      execute: async () => {
        mutationCalls += 1;
        return { state: "confirmed", result: { mutated: true } };
      },
    });
    expect(await authorized.handle(mutation)).toMatchObject({
      state: "confirmed",
      result: { mutated: true },
    });
    expect(validations).toBe(1);
    expect(mutationCalls).toBe(1);

    const readOnly = new MyrmexOperationBroker({
      compatibility,
      policy: inspectMissionPolicy(),
      execute: async () => ({ state: "confirmed", result: { visible: true } }),
    });
    expect(await readOnly.handle(request({ idempotencyKey: "explicit-read-only" }))).toMatchObject({
      state: "confirmed",
      result: { visible: true },
    });
  });

  test("advances ambiguity only through observation-only reconciliation", async () => {
    let effects = 0;
    let observations = 0;
    const broker = new MyrmexOperationBroker({
      compatibility,
      policy: inspectMissionPolicy(),
      execute: async () => {
        effects += 1;
        return { state: "ambiguous", detail: { externalOperationId: "external-7" } };
      },
      reconcile: async ({ receipt }) => {
        observations += 1;
        expect(receipt.state).toBe("ambiguous");
        return { state: "confirmed", result: { externalOperationId: "external-7" } };
      },
    });
    const value = request({ idempotencyKey: "controlled-ambiguity" });

    const ambiguous = await broker.handle(value);
    expect(ambiguous.state).toBe("ambiguous");
    expect(await broker.handle(value)).toEqual(ambiguous);
    expect(effects).toBe(1);
    expect(observations).toBe(0);

    const reconciled = await broker.reconcile(value);
    expect(reconciled).toMatchObject({
      operationId: ambiguous.operationId,
      state: "confirmed",
      result: { externalOperationId: "external-7" },
    });
    expect(effects).toBe(1);
    expect(observations).toBe(1);
    expect(await broker.handle(value)).toEqual(reconciled);
  });

  test("replays a durably reconciled ambiguous transition after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eigengrid-public-reconciliation-"));
    const journalPath = join(directory, "operations.jsonl");
    const value = request({ idempotencyKey: "durable-ambiguity" });
    let effects = 0;
    try {
      const first = new MyrmexOperationBroker({
        compatibility,
        journal: new DurablePublicOperationJournal(journalPath),
        policy: inspectMissionPolicy(),
        execute: async () => {
          effects += 1;
          return { state: "ambiguous", detail: { externalOperationId: "external-durable" } };
        },
      });
      const ambiguous = await first.handle(value);
      expect(ambiguous.state).toBe("ambiguous");

      const observer = new MyrmexOperationBroker({
        compatibility,
        journal: new DurablePublicOperationJournal(journalPath),
        policy: inspectMissionPolicy(),
        execute: async () => {
          effects += 1;
          return { state: "confirmed", result: { redispatched: true } };
        },
        reconcile: async () => ({
          state: "confirmed",
          result: { externalOperationId: "external-durable" },
        }),
      });
      expect(await observer.handle(value)).toEqual(ambiguous);
      const confirmed = await observer.reconcile(value);
      expect(confirmed).toMatchObject({
        operationId: ambiguous.operationId,
        state: "confirmed",
        result: { externalOperationId: "external-durable" },
      });
      expect(effects).toBe(1);

      const restarted = new MyrmexOperationBroker({
        compatibility,
        journal: new DurablePublicOperationJournal(journalPath),
        policy: inspectMissionPolicy(),
        execute: async () => {
          effects += 1;
          return { state: "confirmed", result: { redispatched: true } };
        },
      });
      expect(await restarted.handle(value)).toEqual(confirmed);
      expect(effects).toBe(1);
      expect(
        (await readFile(journalPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).receipt.state),
      ).toEqual(["pending", "ambiguous", "confirmed"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("recovers a stranded pending reservation only through reconciliation", async () => {
    const value = request({ idempotencyKey: "stranded-pending" });
    const journal = new MemoryPublicOperationJournal();
    await journal.reserve(journalEntry(value));
    let effects = 0;
    let observations = 0;
    const broker = new MyrmexOperationBroker({
      compatibility,
      journal,
      policy: inspectMissionPolicy(),
      execute: async () => {
        effects += 1;
        return { state: "confirmed", result: { redispatched: true } };
      },
      reconcile: async ({ receipt }) => {
        observations += 1;
        expect(receipt.state).toBe("pending");
        return { state: "confirmed", result: { recovered: true } };
      },
    });

    expect(await broker.handle(value)).toMatchObject({ state: "pending" });
    expect(effects).toBe(0);
    expect(observations).toBe(0);
    expect(await broker.reconcile(value)).toMatchObject({
      state: "confirmed",
      result: { recovered: true },
    });
    expect(effects).toBe(0);
    expect(observations).toBe(1);
  });

  test("deep-clones, freezes, and reverifies memory journal replays", async () => {
    const value = request({ idempotencyKey: "immutable-memory-journal", payload: { revision: 1 } });
    const callerEntry = journalEntry(value);
    const journal = new MemoryPublicOperationJournal();
    await journal.reserve(callerEntry);
    (callerEntry.request.payload as { revision: number }).revision = 2;

    const first = await journal.get(callerEntry.key);
    const second = await journal.get(callerEntry.key);
    expect(first?.request.payload).toEqual({ revision: 1 });
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.request)).toBe(true);
    expect(Object.isFrozen(first?.request.payload)).toBe(true);
    expect(() => {
      (first!.request.payload as { revision: number }).revision = 3;
    }).toThrow();
    expect((await journal.get(callerEntry.key))?.request.payload).toEqual({ revision: 1 });
  });

  test("binds compatibility for every non-denial journal receipt", async () => {
    const value = request({ idempotencyKey: "receipt-compatibility-binding" });
    const driftedCompatibility = { ...compatibility, eigengridVersion: "0.2.0" };
    const journal = new MemoryPublicOperationJournal();
    await expect(
      journal.put(journalEntry(value, "confirmed", driftedCompatibility)),
    ).rejects.toThrow("public journal receipt does not bind request");
    await expect(journal.put(journalEntry(value, "denied", driftedCompatibility))).resolves.toBe(
      undefined,
    );
  });

  test("does not acknowledge or replay an effect when receipt journaling fails", async () => {
    let calls = 0;
    let reserved: PublicOperationJournalEntry | undefined;
    const journal: PublicOperationJournal = {
      get: async () => reserved,
      reserve: async (entry) => {
        if (reserved) return { entry: reserved, acquired: false };
        reserved = entry;
        return { entry, acquired: true };
      },
      put: async () => {
        throw new Error("journal offline");
      },
      reconcile: async (entry) => {
        reserved = entry;
      },
    };
    const broker = new MyrmexOperationBroker({
      compatibility,
      journal,
      policy: inspectMissionPolicy(),
      execute: async () => {
        calls += 1;
        return { state: "confirmed" as const, result: {} };
      },
    });
    const value = request({ idempotencyKey: "journal-failure" });
    await expect(broker.handle(value)).rejects.toThrow("outcome is ambiguous");
    const replay = await broker.handle(value);
    expect(replay.state).toBe("ambiguous");
    expect(calls).toBe(1);
  });

  test("requires intent reservation before dispatching an effect", () => {
    const journalWithoutReservation = {
      get: async () => undefined,
      put: async () => undefined,
    } as unknown as PublicOperationJournal;
    expect(
      () =>
        new MyrmexOperationBroker({
          compatibility,
          journal: journalWithoutReservation,
          policy: inspectMissionPolicy(),
          execute: async () => ({ state: "confirmed", result: {} }),
        }),
    ).toThrow("reserve intent before effect dispatch");
  });

  test("prefers a reconciled durable terminal receipt over cached ambiguity", async () => {
    let current: PublicOperationJournalEntry | undefined;
    let terminal: PublicOperationJournalEntry | undefined;
    let rejectTerminalWrite = true;
    let calls = 0;
    const journal: PublicOperationJournal = {
      get: async () => current,
      reserve: async (entry) => {
        if (current) return { entry: current, acquired: false };
        current = entry;
        return { entry, acquired: true };
      },
      put: async (entry) => {
        terminal = entry;
        if (rejectTerminalWrite) throw new Error("simulated response loss");
        current = entry;
      },
      reconcile: async (entry) => {
        current = entry;
      },
    };
    const broker = new MyrmexOperationBroker({
      compatibility,
      journal,
      policy: inspectMissionPolicy(),
      execute: async () => {
        calls += 1;
        return { state: "confirmed", result: { status: "ready" } };
      },
    });
    const value = request({ idempotencyKey: "reconciled-after-loss" });
    await expect(broker.handle(value)).rejects.toThrow("outcome is ambiguous");
    if (!terminal) throw new Error("Expected the terminal receipt candidate");
    current = terminal;
    rejectTerminalWrite = false;

    const reconciled = await broker.handle(value);
    expect(reconciled.state).toBe("confirmed");
    expect(reconciled.result).toEqual({ status: "ready" });
    expect(calls).toBe(1);
  });

  test("concurrent duplicate requests share one in-flight application effect", async () => {
    let calls = 0;
    const broker = new MyrmexOperationBroker({
      compatibility,
      policy: inspectMissionPolicy(),
      execute: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { state: "confirmed" as const, result: {} };
      },
    });
    const value = request({ requestId: "req-concurrent" });
    const [first, second] = await Promise.all([broker.handle(value), broker.handle(value)]);
    expect(first).toEqual(second);
    expect(calls).toBe(1);
    expect(verifyMyrmexOperationReceipt(first)).toEqual({ ok: true, value: first });
  });

  test("durable journal preserves idempotency across broker restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eigengrid-public-journal-"));
    const journalPath = join(directory, "operations.jsonl");
    let calls = 0;
    const first = new MyrmexOperationBroker({
      compatibility,
      journal: new DurablePublicOperationJournal(journalPath),
      policy: inspectMissionPolicy(),
      execute: async () => {
        calls += 1;
        return { state: "confirmed" as const, result: {} };
      },
    });
    const value = request();
    const receipt = await first.handle(value);
    const second = new MyrmexOperationBroker({
      compatibility,
      journal: new DurablePublicOperationJournal(journalPath),
      policy: inspectMissionPolicy(),
      execute: async () => {
        calls += 1;
        return { state: "confirmed" as const, result: {} };
      },
    });
    expect(await second.handle(value)).toEqual(receipt);
    expect(calls).toBe(1);
  });

  test("durable journal appends each receipt transition exactly once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eigengrid-public-journal-lines-"));
    const journalPath = join(directory, "operations.jsonl");
    try {
      const broker = new MyrmexOperationBroker({
        compatibility,
        journal: new DurablePublicOperationJournal(journalPath),
        policy: inspectMissionPolicy(),
        execute: async () => ({ state: "confirmed" as const, result: {} }),
      });
      await broker.handle(request({ idempotencyKey: "single-append" }));
      const lines = (await readFile(journalPath, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines.map((line) => JSON.parse(line).receipt.state)).toEqual(["pending", "confirmed"]);
    } finally {
      await import("node:fs/promises").then(({ rm }) =>
        rm(directory, { recursive: true, force: true }),
      );
    }
  });

  test("durable reservation prevents a second process from redispatching a pending effect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eigengrid-public-journal-pending-"));
    const journalPath = join(directory, "operations.jsonl");
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const effectGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstCalls = 0;
    let secondCalls = 0;
    const value = request({ idempotencyKey: "pending-reservation" });
    const first = new MyrmexOperationBroker({
      compatibility,
      journal: new DurablePublicOperationJournal(journalPath),
      policy: inspectMissionPolicy(),
      execute: async () => {
        firstCalls += 1;
        entered();
        await effectGate;
        return { state: "confirmed" as const, result: {} };
      },
    });
    const firstResult = first.handle(value);
    await enteredPromise;

    const second = new MyrmexOperationBroker({
      compatibility,
      journal: new DurablePublicOperationJournal(journalPath),
      policy: inspectMissionPolicy(),
      execute: async () => {
        secondCalls += 1;
        return { state: "confirmed" as const, result: {} };
      },
    });
    const pending = await second.handle(value);
    expect(pending.state).toBe("pending");
    expect(secondCalls).toBe(0);

    release();
    const confirmed = await firstResult;
    expect(confirmed.state).toBe("confirmed");
    expect(firstCalls).toBe(1);
    expect(await second.handle(value)).toEqual(confirmed);

    await import("node:fs/promises").then(({ rm }) =>
      rm(directory, { recursive: true, force: true }),
    );
  });

  test("publishes complete lock ownership under repeated 20-process contention", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eigengrid-public-journal-process-lock-"));
    const value = request({ idempotencyKey: "twenty-process-reservation" });
    const serializedEntry = JSON.stringify(journalEntry(value));
    const childSource = `
      import { DurablePublicOperationJournal } from "@eigengrid/protocol";
      const journal = new DurablePublicOperationJournal(process.env.JOURNAL_PATH);
      process.stdout.write("ready\\n");
      await Bun.stdin.text();
      const result = await journal.reserve(JSON.parse(process.env.ENTRY_JSON));
      process.stdout.write(result.acquired ? "acquired" : "replayed");
    `;
    try {
      for (let round = 0; round < 3; round += 1) {
        const journalPath = join(directory, `operations-${round}.jsonl`);
        const outcomes = await runContendingProcesses(20, childSource, {
          ENTRY_JSON: serializedEntry,
          JOURNAL_PATH: journalPath,
        });
        expect(
          outcomes.filter(
            ({ stdout, stderr, exitCode }) =>
              (stdout !== "acquired" && stdout !== "replayed") || stderr !== "" || exitCode !== 0,
          ),
        ).toEqual([]);
        expect(outcomes.filter(({ stdout }) => stdout === "acquired")).toHaveLength(1);
        expect(outcomes.filter(({ stdout }) => stdout === "replayed")).toHaveLength(19);
        expect((await readFile(journalPath, "utf8")).trim().split("\n")).toHaveLength(1);
        expect(
          (await new DurablePublicOperationJournal(journalPath).get(journalEntry(value).key))
            ?.receipt.state,
        ).toBe("pending");
      }
      expect((await readdir(directory)).some((name) => name.includes(".lock"))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    // Three bounded 20s rounds, including imports/fsync; the production lock
    // already permits 10s of contention. The global 5s test default is invalid.
  }, 65_000);

  test("fails closed when the durable journal contains an invalid record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eigengrid-public-journal-corrupt-"));
    const journalPath = join(directory, "operations.jsonl");
    await appendFile(journalPath, "not-json\n");
    await expect(new DurablePublicOperationJournal(journalPath).get("idem-1")).rejects.toThrow(
      "invalid public journal JSON",
    );
  });

  test("keeps a corrupt durable journal failed across subsequent calls", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eigengrid-public-journal-sticky-"));
    const journalPath = join(directory, "operations.jsonl");
    try {
      await appendFile(journalPath, "not-json\n");
      const journal = new DurablePublicOperationJournal(journalPath);
      await expect(journal.get("installation-1:idem-1")).rejects.toThrow(
        "invalid public journal JSON",
      );
      await expect(journal.get("installation-1:idem-1")).rejects.toThrow(
        "invalid public journal JSON",
      );
    } finally {
      await import("node:fs/promises").then(({ rm }) =>
        rm(directory, { recursive: true, force: true }),
      );
    }
  });

  test("rejects a durable entry whose key is not bound to its request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eigengrid-public-journal-binding-"));
    const journalPath = join(directory, "operations.jsonl");
    try {
      const broker = new MyrmexOperationBroker({
        compatibility,
        policy: inspectMissionPolicy(),
        execute: async () => ({ state: "confirmed" as const, result: {} }),
      });
      const value = request({ idempotencyKey: "binding" });
      const receipt = await broker.handle(value);
      const journal = new DurablePublicOperationJournal(journalPath);
      await expect(
        journal.put({
          key: "attacker:binding",
          requestDigest: value.requestDigest,
          request: value,
          receipt,
        }),
      ).rejects.toThrow("public journal key does not bind request");
    } finally {
      await import("node:fs/promises").then(({ rm }) =>
        rm(directory, { recursive: true, force: true }),
      );
    }
  });

  test("unknown or unauthorized operation never reaches handler", async () => {
    let calls = 0;
    const broker = new MyrmexOperationBroker({
      compatibility,
      policy: inspectMissionPolicy(),
      execute: async () => {
        calls += 1;
        return { state: "confirmed" as const, result: {} };
      },
    });
    const denied = await broker.handle(
      request({ operation: "run_arbitrary_shell", idempotencyKey: "shell" }),
    );
    expect(denied.state).toBe("denied");
    expect(calls).toBe(0);
  });
});
