import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContendingProcesses } from "../../../tests/ts/helpers/process-contention";
import {
  DurablePublicOperationJournal,
  MyrmexOperationBroker,
  computeMyrmexReceiptDigest,
  createMyrmexOperationRequest,
  publicDigest,
  verifyMyrmexOperationRequest,
  type MyrmexOperationRequest,
  type PublicCompatibility,
  type PublicOperationResult,
  type PublicSubject,
} from "@eigengrid/protocol";
import { createIncidentBundle } from "@eigengrid/backup";

import {
  MYRMEX_PROFILE_FEATURES,
  MYRMEX_PROFILE_OPERATIONS,
  MYRMEX_PROFILE_VERSION,
  MemoryMyrmexProfileLedger,
  DurableMyrmexProfileLedger,
  MyrmexProfile,
  MyrmexProfileAuthorizationError,
  MyrmexProfileCompatibilityError,
  MyrmexProfileIdempotencyError,
  createMyrmexProfileOperationExecutor,
  runApprovedUpgradeFlow,
  type ApprovedMyrmexProfileCallOptions,
  type MyrmexAuthorityEvidence,
  type MyrmexProfileLedger,
  type MyrmexPublicV1Broker,
  type UpgradeTarget,
} from "./index";

const FIXED_NOW = new Date("2026-08-30T12:00:00.000Z");

const compatibility: PublicCompatibility = Object.freeze({
  eigengridVersion: "0.1.0-alpha.1",
  publicProtocol: "eigengrid.public.v1",
  missionProtocol: "eigengrid.mission.v1",
  colonySchema: "eigengrid.colony.v1",
  skillSchema: "eigengrid.skill.v1",
  evidenceSchema: "eigengrid.evidence.v1",
  databaseSchemaInformational: 18,
  profileVersion: MYRMEX_PROFILE_VERSION,
  codexSubstrateRange: "0.151.0",
  featureFlags: Object.values(MYRMEX_PROFILE_FEATURES),
});

const mission: PublicSubject = Object.freeze({
  type: "mission",
  id: "mission-42",
  revision: 3,
  digest: publicDigest({ missionId: "mission-42", revision: 3 }),
});

const release: PublicSubject = Object.freeze({
  type: "release",
  id: "release-0.2.0",
  revision: "candidate-1",
  digest: publicDigest({ release: "0.2.0", candidate: 1 }),
});

const authority: MyrmexAuthorityEvidence = Object.freeze({
  kind: "eigengrid.owner-approval.v1",
  id: "approval-7",
  digest: publicDigest({ approvalId: "approval-7", decision: "approve" }),
});

const READ_ONLY_OPERATIONS = new Set<string>([
  MYRMEX_PROFILE_OPERATIONS.compatibilityStatus,
  MYRMEX_PROFILE_OPERATIONS.missionStatus,
  MYRMEX_PROFILE_OPERATIONS.jobStatus,
  MYRMEX_PROFILE_OPERATIONS.approvalStatus,
  MYRMEX_PROFILE_OPERATIONS.evidenceExport,
  MYRMEX_PROFILE_OPERATIONS.incidentBundle,
]);

function publicPolicy(operations: readonly string[]) {
  return {
    allowedOperations: new Set(operations),
    readOnlyOperations: new Set(
      operations.filter((operation) => READ_ONLY_OPERATIONS.has(operation)),
    ),
    validateAuthority: ({ request }: { request: MyrmexOperationRequest }) => ({
      authorized: request.authorityEvidence.some(
        (evidence) =>
          evidence.kind === authority.kind &&
          evidence.id === authority.id &&
          evidence.digest === authority.digest,
      ),
      code: "OWNER_APPROVAL_NOT_CURRENT",
    }),
  };
}

const upgradeTarget: UpgradeTarget = Object.freeze({
  targetVersion: "0.2.0",
  sourceCommit: "a".repeat(40),
  artifactDigest: publicDigest("artifact"),
  sbomDigest: publicDigest("sbom"),
  signatureDigest: publicDigest("signature"),
  restorePointId: "restore-upgrade-0.2.0",
});

interface HarnessOptions {
  readonly clientCompatibility?: PublicCompatibility;
  readonly brokerCompatibility?: PublicCompatibility;
  readonly result?: (operation: string) => PublicOperationResult;
  readonly ledger?: MyrmexProfileLedger;
  readonly brokerOverride?: MyrmexPublicV1Broker;
  readonly requestId?: () => string;
}

function confirmedResult(request: MyrmexOperationRequest): PublicOperationResult {
  if (request.operation === MYRMEX_PROFILE_OPERATIONS.compatibilityStatus) {
    return {
      state: "confirmed",
      result: {
        schema: "eigengrid.myrmex-compatibility-status-result.v1",
        compatibility: request.compatibility,
      },
    };
  }
  if (
    request.operation === MYRMEX_PROFILE_OPERATIONS.missionStatus ||
    request.operation === MYRMEX_PROFILE_OPERATIONS.jobStatus ||
    request.operation === MYRMEX_PROFILE_OPERATIONS.approvalStatus
  ) {
    return {
      state: "confirmed",
      result: {
        schema: "eigengrid.myrmex-status-result.v1",
        status: "ready",
        observedAt: FIXED_NOW.toISOString(),
      },
    };
  }
  if (request.operation === MYRMEX_PROFILE_OPERATIONS.incidentBundle) {
    return {
      state: "confirmed",
      result: {
        schema: "eigengrid.redacted-incident-bundle-result.v1",
        incidentId: String(request.payload.incidentId),
        artifactReference: "incident/incident-12.json",
        payloadDigest: publicDigest("incident-payload"),
        bundleDigest: publicDigest("incident-bundle"),
      },
    };
  }
  return { state: "confirmed", result: {} };
}

function createHarness(options: HarnessOptions = {}) {
  const requests: string[] = [];
  const envelopes: MyrmexOperationRequest[] = [];
  let effects = 0;
  const broker =
    options.brokerOverride ??
    new MyrmexOperationBroker({
      compatibility: options.brokerCompatibility ?? compatibility,
      policy: {
        ...publicPolicy(Object.values(MYRMEX_PROFILE_OPERATIONS)),
        allowedPrincipals: new Set(["myrmex-profile:installation-1"]),
      },
      now: () => FIXED_NOW,
      async execute({ request }) {
        effects += 1;
        requests.push(request.operation);
        envelopes.push(request);
        return options.result?.(request.operation) ?? confirmedResult(request);
      },
    });
  let requestSequence = 0;
  const ledger = options.ledger ?? new MemoryMyrmexProfileLedger();
  const profile = new MyrmexProfile({
    installationId: "installation-1",
    principalId: "myrmex-profile:installation-1",
    compatibility: options.clientCompatibility ?? compatibility,
    broker,
    ledger,
    now: () => FIXED_NOW,
    requestId: options.requestId ?? (() => `request-${++requestSequence}`),
  });
  return {
    broker,
    profile,
    requests,
    envelopes,
    effects: () => effects,
  };
}

function approvedOptions(idempotencyKey: string): ApprovedMyrmexProfileCallOptions {
  return {
    idempotencyKey,
    runId: "myrmex-run-1",
    authorityEvidence: [authority],
  };
}

describe("optional Myrmex public-v1 profile", () => {
  test("uses typed read-only status, evidence, and redacted incident operations", async () => {
    const { profile, requests, effects } = createHarness();

    const status = await profile.readMissionStatus(mission, {
      idempotencyKey: "read-mission-42",
      runId: "myrmex-run-read",
    });
    const evidence = await profile.exportEvidence(
      mission,
      { format: "jsonld", includeRetracted: false },
      { idempotencyKey: "export-mission-42", runId: "myrmex-run-read" },
    );
    const incident = await profile.requestRedactedIncidentBundle(
      release,
      {
        incidentId: "incident-12",
        from: "2026-08-30T10:00:00.000Z",
        through: "2026-08-30T11:00:00.000Z",
        redactionPolicyDigest: publicDigest("redaction-policy-v1"),
        sections: ["health", "events", "operation_receipts"],
      },
      { idempotencyKey: "incident-12-bundle", runId: "myrmex-run-incident" },
    );

    expect(requests).toEqual([
      MYRMEX_PROFILE_OPERATIONS.missionStatus,
      MYRMEX_PROFILE_OPERATIONS.evidenceExport,
      MYRMEX_PROFILE_OPERATIONS.incidentBundle,
    ]);
    expect(status.result).toMatchObject({
      schema: "eigengrid.myrmex-status-result.v1",
      status: "ready",
    });
    expect(incident.result).toMatchObject({
      schema: "eigengrid.redacted-incident-bundle-result.v1",
      incidentId: "incident-12",
      artifactReference: "incident/incident-12.json",
    });
    expect(effects()).toBe(3);
    for (const receipt of [status, evidence, incident]) {
      expect(receipt.state).toBe("confirmed");
      expect(computeMyrmexReceiptDigest(receipt)).toBe(receipt.receiptDigest);
    }
  });

  test("binds the incident wrapper to an injected checksummed bundle handler", async () => {
    let emittedBundle: ReturnType<typeof createIncidentBundle> | undefined;
    const execute = createMyrmexProfileOperationExecutor({
      incidentBundle: ({ payload }) => {
        emittedBundle = createIncidentBundle({
          incidentId: payload.incidentId,
          generatedAt: FIXED_NOW.toISOString(),
          sourceRevision: String(release.revision),
          sections: {
            health: { ready: false },
            credentials: { apiKey: "secret-value-must-not-leave" },
          },
        });
        return {
          schema: "eigengrid.redacted-incident-bundle-result.v1",
          incidentId: emittedBundle.incidentId,
          artifactReference: `incidents/${emittedBundle.incidentId}.json`,
          payloadDigest: emittedBundle.payloadDigest,
          bundleDigest: emittedBundle.bundleDigest,
        };
      },
      fallback: async ({ request }) => confirmedResult(request),
    });
    const broker = new MyrmexOperationBroker({
      compatibility,
      policy: publicPolicy(Object.values(MYRMEX_PROFILE_OPERATIONS)),
      now: () => FIXED_NOW,
      execute,
    });
    const { profile } = createHarness({ brokerOverride: broker });

    const receipt = await profile.requestRedactedIncidentBundle(
      release,
      {
        incidentId: "incident-wired",
        from: "2026-08-30T10:00:00.000Z",
        through: "2026-08-30T11:00:00.000Z",
        redactionPolicyDigest: publicDigest("redaction-policy-v1"),
        sections: ["health"],
      },
      { idempotencyKey: "incident-wired", runId: "myrmex-run-incident" },
    );
    if (!emittedBundle) throw new Error("Expected the incident handler to emit a bundle");

    expect(receipt.result).toEqual({
      schema: "eigengrid.redacted-incident-bundle-result.v1",
      incidentId: "incident-wired",
      artifactReference: "incidents/incident-wired.json",
      payloadDigest: emittedBundle.payloadDigest,
      bundleDigest: emittedBundle.bundleDigest,
    });
    expect(JSON.stringify(emittedBundle)).not.toContain("secret-value-must-not-leave");
  });

  test("requires explicit authority evidence for every mission mutation", async () => {
    const { profile, effects } = createHarness();
    const withoutAuthority = {
      idempotencyKey: "start-without-authority",
      runId: "myrmex-run-1",
      authorityEvidence: [],
    } as unknown as ApprovedMyrmexProfileCallOptions;

    await expect(profile.startMission(mission, {}, withoutAuthority)).rejects.toBeInstanceOf(
      MyrmexProfileAuthorizationError,
    );
    expect(effects()).toBe(0);
  });

  test("sends approved mission and admin wrappers with exact authority evidence", async () => {
    const { profile, requests, envelopes } = createHarness();

    await profile.createMission(
      mission,
      {
        missionSchema: "eigengrid.mission.v1",
        missionDigest: mission.digest,
        objectiveDigest: publicDigest("objective-42"),
      },
      approvedOptions("mission-create-42"),
    );
    await profile.decideMissionApproval(
      mission,
      {
        approvalId: "approval-7",
        approvalDigest: authority.digest ?? publicDigest("approval-7"),
        decision: "approve",
      },
      approvedOptions("mission-approval-42"),
    );
    await profile.createBackup(
      release,
      {
        restorePointId: "restore-manual-1",
        purpose: "upgrade",
        targetArtifactDigest: publicDigest("target-artifact"),
      },
      approvedOptions("backup-manual-1"),
    );

    expect(requests).toEqual([
      MYRMEX_PROFILE_OPERATIONS.missionCreate,
      MYRMEX_PROFILE_OPERATIONS.missionApprovalDecide,
      MYRMEX_PROFILE_OPERATIONS.backupCreate,
    ]);
    expect(envelopes.every((request) => request.authorityEvidence.length === 1)).toBe(true);
    expect(envelopes.map((request) => request.authorityEvidence[0])).toEqual([
      authority,
      authority,
      authority,
    ]);
  });

  test("collapses concurrent duplicates and reuses receipts across profile restart", async () => {
    const ledger = new MemoryMyrmexProfileLedger();
    const first = createHarness({ ledger });
    const options = { idempotencyKey: "mission-status-stable", runId: "myrmex-run-read" };

    const [left, right] = await Promise.all([
      first.profile.readMissionStatus(mission, options),
      first.profile.readMissionStatus(mission, options),
    ]);
    expect(first.effects()).toBe(1);
    expect(right.operationId).toBe(left.operationId);
    expect(right.receiptDigest).toBe(left.receiptDigest);

    const restarted = createHarness({ ledger });
    const afterRestart = await restarted.profile.readMissionStatus(mission, options);
    expect(restarted.effects()).toBe(0);
    expect(afterRestart.operationId).toBe(left.operationId);
    expect(Object.isFrozen(afterRestart)).toBe(true);
    expect(Object.isFrozen(afterRestart.result)).toBe(true);

    await expect(
      restarted.profile.readJobStatus(
        { ...mission, type: "job" },
        { idempotencyKey: "mission-status-stable", runId: "myrmex-run-read" },
      ),
    ).rejects.toBeInstanceOf(MyrmexProfileIdempotencyError);
    expect(restarted.effects()).toBe(0);
  });

  test("persists the public request/receipt ledger with fsync and replays after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eigengrid-myrmex-ledger-"));
    const filePath = join(directory, "profile.jsonl");
    try {
      const ledger = new DurableMyrmexProfileLedger(filePath);
      const first = createHarness({ ledger });
      const options = { idempotencyKey: "durable-profile", runId: "myrmex-run-read" };
      const original = await first.profile.readMissionStatus(mission, options);
      expect(first.effects()).toBe(1);

      const reopened = createHarness({ ledger: new DurableMyrmexProfileLedger(filePath) });
      const replay = await reopened.profile.readMissionStatus(mission, options);
      expect(reopened.effects()).toBe(0);
      expect(replay.receiptDigest).toBe(original.receiptDigest);
      expect((await readFile(filePath, "utf8")).trim().length).toBeGreaterThan(0);
      await expect(
        reopened.profile.readMissionStatus(mission, {
          ...options,
          idempotencyKey: "durable-profile",
        }),
      ).resolves.toMatchObject({ receiptDigest: original.receiptDigest });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("serializes concurrent profile writers and refreshes the durable winner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eigengrid-myrmex-ledger-concurrent-"));
    const filePath = join(directory, "profile.jsonl");
    try {
      let effects = 0;
      const broker = new MyrmexOperationBroker({
        compatibility,
        policy: publicPolicy([MYRMEX_PROFILE_OPERATIONS.missionStatus]),
        now: () => FIXED_NOW,
        async execute({ request }) {
          effects += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return confirmedResult(request);
        },
      });
      const left = createHarness({
        brokerOverride: broker,
        ledger: new DurableMyrmexProfileLedger(filePath),
        requestId: () => "request-left",
      });
      const right = createHarness({
        brokerOverride: broker,
        ledger: new DurableMyrmexProfileLedger(filePath),
        requestId: () => "request-right",
      });
      const options = { idempotencyKey: "cross-process", runId: "myrmex-run-read" };

      await Promise.all([
        left.profile.readMissionStatus(mission, options),
        right.profile.readMissionStatus(mission, options),
      ]);
      const [leftTerminal, rightTerminal] = await Promise.all([
        left.profile.readMissionStatus(mission, options),
        right.profile.readMissionStatus(mission, options),
      ]);

      expect(leftTerminal.state).toBe("confirmed");
      expect(rightTerminal).toEqual(leftTerminal);
      expect(effects).toBe(1);
      const reopened = new DurableMyrmexProfileLedger(filePath);
      expect((await reopened.get("installation-1:cross-process"))?.receipt).toEqual(leftTerminal);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("lets a non-owner reserve at the Head before the profile request owner dispatches", async () => {
    const ledger = new MemoryMyrmexProfileLedger();
    let effects = 0;
    let releaseOwner!: () => void;
    let ownerEnteredHandle!: () => void;
    const ownerEntered = new Promise<void>((resolve) => {
      ownerEnteredHandle = resolve;
    });
    const ownerGate = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const head = new MyrmexOperationBroker({
      compatibility,
      policy: publicPolicy([MYRMEX_PROFILE_OPERATIONS.missionStatus]),
      now: () => FIXED_NOW,
      execute: async ({ request }) => {
        effects += 1;
        return confirmedResult(request);
      },
    });
    const delayedOwnerTransport: MyrmexPublicV1Broker = {
      async handle(request, signal) {
        ownerEnteredHandle();
        await ownerGate;
        return head.handle(request, signal);
      },
      reconcile: (request, signal) => head.reconcile(request, signal),
    };
    const owner = createHarness({
      ledger,
      brokerOverride: delayedOwnerTransport,
      requestId: () => "request-pre-broker-owner",
    });
    const contender = createHarness({
      ledger,
      brokerOverride: head,
      requestId: () => "request-pre-broker-contender",
    });
    const options = { idempotencyKey: "pre-broker-race", runId: "myrmex-run-read" };

    const ownerCall = owner.profile.readMissionStatus(mission, options);
    await ownerEntered;
    const contenderReceipt = await contender.profile.readMissionStatus(mission, options);
    releaseOwner();
    const ownerReceipt = await ownerCall;

    expect(contenderReceipt.state).toBe("confirmed");
    expect(ownerReceipt).toEqual(contenderReceipt);
    expect(effects).toBe(1);
    expect((await ledger.get("installation-1:pre-broker-race"))?.receipt).toEqual(contenderReceipt);
  });

  test("atomically publishes profile locks under repeated 20-process contention", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eigengrid-myrmex-process-lock-"));
    const request = createMyrmexOperationRequest({
      requestId: "request-profile-lock",
      idempotencyKey: "profile-lock",
      installationId: "installation-1",
      runId: "myrmex-run-lock",
      principalId: "myrmex-profile:installation-1",
      operation: MYRMEX_PROFILE_OPERATIONS.missionStatus,
      compatibility,
      subject: mission,
      payload: {},
      authorityEvidence: [],
      expiresAt: new Date(FIXED_NOW.getTime() + 60_000).toISOString(),
    });
    const entry = {
      key: "installation-1:profile-lock",
      intentDigest: publicDigest({
        protocol: compatibility.publicProtocol,
        installationId: "installation-1",
        principalId: "myrmex-profile:installation-1",
        runId: "myrmex-run-lock",
        operation: MYRMEX_PROFILE_OPERATIONS.missionStatus,
        compatibility,
        subject: mission,
        payload: {},
        authorityEvidence: [],
      }),
      request,
    };
    const childSource = `
      import { DurableMyrmexProfileLedger } from "@eigengrid/myrmex-profile";
      const ledger = new DurableMyrmexProfileLedger(process.env.LEDGER_PATH);
      process.stdout.write("ready\\n");
      await Bun.stdin.text();
      const created = await ledger.putRequest(JSON.parse(process.env.LEDGER_ENTRY));
      process.stdout.write(created ? "created" : "replayed");
    `;
    try {
      for (let round = 0; round < 2; round += 1) {
        const ledgerPath = join(directory, `profile-${round}.jsonl`);
        const outcomes = await runContendingProcesses(20, childSource, {
          LEDGER_ENTRY: JSON.stringify(entry),
          LEDGER_PATH: ledgerPath,
        });
        expect(
          outcomes.filter(
            ({ stdout, stderr, exitCode }) =>
              (stdout !== "created" && stdout !== "replayed") || stderr !== "" || exitCode !== 0,
          ),
        ).toEqual([]);
        expect(outcomes.filter(({ stdout }) => stdout === "created")).toHaveLength(1);
        expect(outcomes.filter(({ stdout }) => stdout === "replayed")).toHaveLength(19);
        expect((await readFile(ledgerPath, "utf8")).trim().split("\n")).toHaveLength(1);
      }
      expect((await readdir(directory)).some((name) => name.includes(".lock"))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 45_000); // Two bounded 20s rounds; same barrier/cleanup as the public journal.

  test("discovers a terminal public receipt after another process observed pending", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eigengrid-myrmex-pending-discovery-"));
    const journalPath = join(directory, "public.jsonl");
    try {
      const journal = new DurablePublicOperationJournal(journalPath);
      let release!: () => void;
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const effectGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let firstEffects = 0;
      let secondEffects = 0;
      const policy = {
        ...publicPolicy([MYRMEX_PROFILE_OPERATIONS.missionStatus]),
        allowedPrincipals: new Set(["myrmex-profile:installation-1"]),
      };
      const firstBroker = new MyrmexOperationBroker({
        compatibility,
        journal,
        policy,
        now: () => FIXED_NOW,
        async execute({ request }) {
          firstEffects += 1;
          entered();
          await effectGate;
          return confirmedResult(request);
        },
      });
      const secondBroker = new MyrmexOperationBroker({
        compatibility,
        journal,
        policy,
        now: () => FIXED_NOW,
        async execute({ request }) {
          secondEffects += 1;
          return confirmedResult(request);
        },
      });
      const fixedRequestId = () => "request-pending-discovery";
      const first = createHarness({
        brokerOverride: firstBroker,
        ledger: new MemoryMyrmexProfileLedger(),
        requestId: fixedRequestId,
      });
      const second = createHarness({
        brokerOverride: secondBroker,
        ledger: new MemoryMyrmexProfileLedger(),
        requestId: fixedRequestId,
      });
      const options = { idempotencyKey: "pending-discovery", runId: "myrmex-run-read" };

      const owningCall = first.profile.readMissionStatus(mission, options);
      await enteredPromise;
      expect((await second.profile.readMissionStatus(mission, options)).state).toBe("pending");
      release();
      const confirmed = await owningCall;
      const discovered = await second.profile.readMissionStatus(mission, options);

      expect(discovered).toEqual(confirmed);
      expect(firstEffects).toBe(1);
      expect(secondEffects).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails closed and remains failed after durable ledger corruption", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eigengrid-myrmex-ledger-corrupt-"));
    const filePath = join(directory, "profile.jsonl");
    try {
      await writeFile(filePath, '{"key":"installation-1:broken"}\n', { mode: 0o600 });
      const ledger = new DurableMyrmexProfileLedger(filePath);
      await expect(ledger.get("installation-1:broken")).rejects.toThrow();
      await expect(ledger.get("installation-1:broken")).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("recovers an exact receipt after an ambiguous transport without redispatching the effect", async () => {
    let effects = 0;
    let loseFirstResponse = true;
    const requestDigests: string[] = [];
    const underlying = new MyrmexOperationBroker({
      compatibility,
      policy: publicPolicy([MYRMEX_PROFILE_OPERATIONS.missionStatus]),
      now: () => FIXED_NOW,
      async execute({ request }) {
        effects += 1;
        requestDigests.push(request.requestDigest);
        return confirmedResult(request);
      },
    });
    const transport: MyrmexPublicV1Broker = {
      async handle(request, signal) {
        const verified = verifyMyrmexOperationRequest(request);
        if (!verified.ok) throw new Error(verified.error);
        const receipt = await underlying.handle(request, signal);
        if (loseFirstResponse) {
          loseFirstResponse = false;
          throw new Error("response lost after broker acknowledgement");
        }
        requestDigests.push(verified.value.requestDigest);
        return receipt;
      },
      async reconcile(request, signal) {
        const verified = verifyMyrmexOperationRequest(request);
        if (!verified.ok) throw new Error(verified.error);
        const receipt = await underlying.reconcile(request, signal);
        requestDigests.push(verified.value.requestDigest);
        return receipt;
      },
    };
    const { profile } = createHarness({ brokerOverride: transport });
    const options = { idempotencyKey: "ambiguous-read", runId: "myrmex-run-read" };

    await expect(profile.readMissionStatus(mission, options)).rejects.toThrow(
      "response lost after broker acknowledgement",
    );
    const receipt = await profile.readMissionStatus(mission, options);

    expect(receipt.state).toBe("confirmed");
    expect(effects).toBe(1);
    expect(new Set(requestDigests).size).toBe(1);
  });

  test("routes a stored pending receipt only through broker reconciliation", async () => {
    let effects = 0;
    let handleCalls = 0;
    let reconciliationCalls = 0;
    const underlying = new MyrmexOperationBroker({
      compatibility,
      policy: publicPolicy([MYRMEX_PROFILE_OPERATIONS.missionStatus]),
      now: () => FIXED_NOW,
      execute: async () => {
        effects += 1;
        return { state: "pending", detail: { externalOperationId: "mission-observation-1" } };
      },
      reconcile: async ({ request }) => confirmedResult(request),
    });
    const transport: MyrmexPublicV1Broker = {
      async handle(request, signal) {
        handleCalls += 1;
        return underlying.handle(request, signal);
      },
      async reconcile(request, signal) {
        reconciliationCalls += 1;
        return underlying.reconcile(request, signal);
      },
    };
    const { profile } = createHarness({ brokerOverride: transport });
    const options = { idempotencyKey: "stored-pending", runId: "myrmex-run-read" };

    expect(await profile.readMissionStatus(mission, options)).toMatchObject({ state: "pending" });
    expect(await profile.readMissionStatus(mission, options)).toMatchObject({
      state: "confirmed",
      result: { schema: "eigengrid.myrmex-status-result.v1", status: "ready" },
    });
    expect(effects).toBe(1);
    expect(handleCalls).toBe(1);
    expect(reconciliationCalls).toBe(1);
  });

  test("returns isolated, deeply frozen, reverified profile ledger replays", async () => {
    const ledger = new MemoryMyrmexProfileLedger();
    const first = createHarness({ ledger });
    const options = { idempotencyKey: "tamper-ledger", runId: "myrmex-run-read" };
    await first.profile.readMissionStatus(mission, options);

    const entry = await ledger.get("installation-1:tamper-ledger");
    expect(entry).toBeDefined();
    if (!entry) throw new Error("Expected stored profile request");
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.request)).toBe(true);
    expect(() => {
      (entry.request as { operation: string }).operation = MYRMEX_PROFILE_OPERATIONS.jobStatus;
    }).toThrow();
    const replayedEntry = await ledger.get("installation-1:tamper-ledger");
    expect(replayedEntry).not.toBe(entry);
    expect(replayedEntry?.request.operation).toBe(MYRMEX_PROFILE_OPERATIONS.missionStatus);

    const restarted = createHarness({ ledger });
    await expect(restarted.profile.readMissionStatus(mission, options)).resolves.toMatchObject({
      state: "confirmed",
    });
    expect(restarted.effects()).toBe(0);
  });

  test("fails closed on broker compatibility drift before execution and retains its denial receipt", async () => {
    const brokerCompatibility: PublicCompatibility = {
      ...compatibility,
      eigengridVersion: "0.2.0-incompatible",
    };
    const { profile, effects } = createHarness({ brokerCompatibility });

    try {
      await profile.readMissionStatus(mission, {
        idempotencyKey: "compatibility-drift",
        runId: "myrmex-run-read",
      });
      throw new Error("Expected compatibility mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(MyrmexProfileCompatibilityError);
      expect(error).toMatchObject({
        code: "RECEIPT_COMPATIBILITY_MISMATCH",
        receipt: { state: "denied", failure: { code: "INCOMPATIBLE_PROFILE" } },
      });
    }
    expect(effects()).toBe(0);
  });

  test("denies unavailable mutation features locally before reaching the broker", () => {
    const readOnlyCompatibility: PublicCompatibility = {
      ...compatibility,
      featureFlags: [MYRMEX_PROFILE_FEATURES.read],
    };
    const { profile, effects } = createHarness({
      clientCompatibility: readOnlyCompatibility,
      brokerCompatibility: readOnlyCompatibility,
    });

    expect(() => profile.startMission(mission, {}, approvedOptions("read-only-start"))).toThrow(
      expect.objectContaining({
        code: "MISSING_PROFILE_FEATURE",
        field: expect.stringContaining(MYRMEX_PROFILE_FEATURES.mission),
      }),
    );
    expect(effects()).toBe(0);
  });

  test("rejects unredacted or malformed incident requests before the broker", () => {
    const { profile, effects } = createHarness();
    const malformed = {
      incidentId: "incident-unsafe",
      from: "2026-08-30T11:00:00.000Z",
      through: "2026-08-30T10:00:00.000Z",
      redactionPolicyDigest: publicDigest("policy"),
      sections: ["events"],
      includeCredentials: true,
    };

    expect(() =>
      profile.requestRedactedIncidentBundle(release, malformed as never, {
        idempotencyKey: "unsafe-incident",
        runId: "myrmex-run-incident",
      }),
    ).toThrow();
    expect(effects()).toBe(0);
  });
});

describe("approved upgrade flow", () => {
  test("runs the exact gated sequence and makes duplicate flow replay effect-free", async () => {
    const { profile, requests, effects } = createHarness();
    const input = {
      flowId: "upgrade-0.2.0",
      runId: "myrmex-run-upgrade",
      subject: release,
      target: upgradeTarget,
      authorityEvidence: [authority] as const,
    };

    const first = await runApprovedUpgradeFlow(profile, input);
    const duplicate = await runApprovedUpgradeFlow(profile, input);

    expect(first.outcome).toBe("promoted");
    expect(first.receipts.map((entry) => entry.stage)).toEqual([
      "compatibility",
      "backup",
      "maintenance-enter",
      "apply",
      "verify",
      "promote",
      "maintenance-exit",
    ]);
    expect(requests).toEqual([
      MYRMEX_PROFILE_OPERATIONS.upgradeValidate,
      MYRMEX_PROFILE_OPERATIONS.backupCreate,
      MYRMEX_PROFILE_OPERATIONS.maintenanceSet,
      MYRMEX_PROFILE_OPERATIONS.upgradeApply,
      MYRMEX_PROFILE_OPERATIONS.upgradeVerify,
      MYRMEX_PROFILE_OPERATIONS.upgradePromote,
      MYRMEX_PROFILE_OPERATIONS.maintenanceSet,
    ]);
    expect(effects()).toBe(7);
    expect(duplicate.receipts.map((entry) => entry.receipt.receiptDigest)).toEqual(
      first.receipts.map((entry) => entry.receipt.receiptDigest),
    );
    expect(effects()).toBe(7);
  });

  test("rolls back only an explicit failure and never continues an ambiguous flow", async () => {
    const failed = createHarness({
      result: (operation) =>
        operation === MYRMEX_PROFILE_OPERATIONS.upgradeVerify
          ? { state: "failed", detail: { code: "POST_UPGRADE_CHECK_FAILED" } }
          : { state: "confirmed", result: {} },
    });
    const baseInput = {
      flowId: "upgrade-failure",
      runId: "myrmex-run-upgrade",
      subject: release,
      target: upgradeTarget,
      authorityEvidence: [authority] as const,
      rollbackOnFailure: true,
    };

    const rolledBack = await runApprovedUpgradeFlow(failed.profile, baseInput);
    expect(rolledBack.outcome).toBe("rolled_back");
    expect(rolledBack.receipts.map((entry) => entry.stage).slice(-2)).toEqual([
      "rollback",
      "maintenance-exit",
    ]);

    const ambiguous = createHarness({
      result: (operation) =>
        operation === MYRMEX_PROFILE_OPERATIONS.upgradeVerify
          ? { state: "ambiguous", detail: { code: "OUTCOME_UNKNOWN" } }
          : { state: "confirmed", result: {} },
    });
    const stopped = await runApprovedUpgradeFlow(ambiguous.profile, {
      ...baseInput,
      flowId: "upgrade-ambiguous",
    });
    expect(stopped.outcome).toBe("stopped");
    expect(stopped.receipts.at(-1)?.stage).toBe("verify");
    expect(ambiguous.requests).not.toContain(MYRMEX_PROFILE_OPERATIONS.upgradeRollback);
  });
});

describe("package metadata", () => {
  test("remains optional/private and carries an explicit release-SBOM placeholder", async () => {
    const manifest = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
      private?: boolean;
      dependencies?: Record<string, string>;
    };
    const sbom = (await Bun.file(new URL("../sbom.cdx.json", import.meta.url)).json()) as {
      bomFormat?: string;
      metadata?: { component?: { properties?: Array<{ name?: string; value?: string }> } };
    };

    expect(manifest.private).toBe(true);
    expect(manifest.dependencies).toEqual({
      "@eigengrid/protocol": "workspace:*",
      zod: "^3.24.0",
    });
    expect(sbom.bomFormat).toBe("CycloneDX");
    expect(sbom.metadata?.component?.properties).toContainEqual({
      name: "eigengrid:sbom-status",
      value: "source-placeholder; release pipeline must regenerate and attest",
    });
  });
});
