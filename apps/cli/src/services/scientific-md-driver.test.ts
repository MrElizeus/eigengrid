import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContentAddressedArtifactStore,
  type MissionProvenance,
  type ReconcileWorkUnitEffectResult,
  type ScientificDatabase,
  type ScientificEffectPersistence,
  type ScientificStore,
} from "@eigengrid/mission-runtime";
import {
  ExternalOperationSchema,
  MissionBudgetSchema,
  WorkUnitSchema,
  canonicalJson,
  digestCanonical,
  type ExternalOperation,
  type ScientificDecision,
  type EvidenceReference,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import {
  createAmberMdStageOperationRequest,
  renderCanonicalAmberStage,
} from "@eigengrid/amber-adapter";
import {
  createSlurmSubmissionBinding,
  slurmSubmissionJobName,
  slurmSubmissionMarker,
} from "@eigengrid/slurm";
import { publishAmberStageBundle, type VerifiedAmberStageBundle } from "./amber-stage-bundle";
import { syntheticAmberBundleFixture } from "./amber-stage-bundle.fixture";
import type { HeadMdAmberDeliverySession } from "./head-md-site-authority";
import { parseAmberSlurmDelivery } from "./amber-slurm-delivery";
import { CanonicalScientificExecutionDriver } from "./scientific-mission-driver";

const T0 = "2026-09-20T00:00:00.000Z";
const T1 = "2026-09-20T00:01:00.000Z";
const T2 = "2026-09-20T00:01:30.000Z";
const D = (character: string): string => character.repeat(64);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function evidenceKindForRole(role: string): string {
  switch (role) {
    case "energy_series":
    case "normalized_metrics":
      return "normalized_metrics";
    case "analysis_plan":
    case "analysis_result":
      return "analysis_result";
    case "parent_restart":
      return "restart";
    default:
      return role;
  }
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "eigengrid-md-driver-"));
  temporaryDirectories.push(root);
  const objects = new ContentAddressedArtifactStore(join(root, "objects"));
  await objects.init();
  const generated = await syntheticAmberBundleFixture(objects);
  const rendered = renderCanonicalAmberStage(
    generated.seed.stage,
    generated.seed.mapping,
    generated.seed.executionBinding,
    generated.seed.atomMap,
  );
  const outputContract = {
    requiredEvidenceKinds: generated.seed.request.outputs.bindings
      .filter((binding) => binding.required)
      .map((binding) => evidenceKindForRole(binding.canonicalRole))
      .sort(),
    requiredObservationKinds: [],
  };
  const request = createAmberMdStageOperationRequest(rendered, generated.seed.mapping.environment, {
    workUnitId: "work-md-driver-1",
    bindingDigest: generated.seed.mapping.canonicalWorkUnit.bindingDigest,
    outputContractDigest: digestCanonical(outputContract),
  });
  const workUnit = WorkUnitSchema.parse({
    id: request.workUnitId,
    missionId: "mission-md-driver-1",
    planId: generated.seed.executionBinding.plan.id,
    planVersion: generated.seed.executionBinding.plan.version,
    kind: "scientific_capability",
    state: "claimed",
    reason: "Run the exact MD driver fixture",
    dependencies: [],
    inputRefs: [],
    outputContract,
    skillRefs: [
      {
        skillId: "amber.production-md",
        version: "1.0.0",
        contentDigest: D("1"),
        fragmentId: "amber-md-driver",
        fragmentDigest: D("2"),
        relativePath: "protocols/amber.md",
        selector: "fixture",
      },
    ],
    protocolFragment: {
      schemaVersion: "eigengrid.scientific-capability-fragment/v1",
      id: "fragment-md-driver-1",
      kind: "scientific_capability",
      capability: {
        id: "amber.production-md",
        version: "1.0.0",
        contractDigest: D("3"),
      },
      reason: "Run the exact MD driver fixture",
      parameters: generated.seed.executionBinding,
      sourceFragments: [
        {
          skillId: "amber.production-md",
          version: "1.0.0",
          contentDigest: D("1"),
          fragmentId: "amber-md-driver",
          fragmentDigest: D("2"),
          relativePath: "protocols/amber.md",
          selector: "fixture",
        },
      ],
      riskClass: 3,
    },
    retryPolicy: { maximumAttempts: 1, ambiguityRequiresReconciliation: true },
    approvalPolicy: { required: true, minimumRole: "scientific_reviewer" },
    executionPolicy: { capability: "amber.production-md", riskClass: 3 },
    revision: 1,
    claimOwner: "head-md-driver-1",
    claimExpiresAt: "2026-09-20T00:05:00.000Z",
    jobId: null,
    attemptId: null,
    createdAt: T0,
    updatedAt: T0,
  });
  const bundle = await publishAmberStageBundle(objects, { ...generated.seed, request });
  return { bundle, request, workUnit };
}

class MdDriverStore {
  operation: ExternalOperation | undefined;
  reservations = 0;
  settlements: string[] = [];
  decisions: ScientificDecision[] = [];
  evidence: EvidenceReference[] = [];

  constructor(
    readonly workUnit: WorkUnit,
    readonly association = true,
  ) {}

  async getWorkUnit() {
    return this.workUnit;
  }

  async createEvidence(value: EvidenceReference) {
    if (!this.evidence.some((item) => item.id === value.id)) this.evidence.push(value);
    return value;
  }

  async createDecision(value: ScientificDecision) {
    if (!this.decisions.some((item) => item.id === value.id)) this.decisions.push(value);
    return value;
  }

  async getExternalOperation(): Promise<ExternalOperation | null> {
    return this.operation ?? null;
  }

  async getMissionBudget() {
    return MissionBudgetSchema.parse({
      id: "budget-md-driver-1",
      missionId: this.workUnit.missionId,
      revision: 1 + this.reservations + this.settlements.length,
      limits: { externalOperations: 3, modelTokens: 0, wallTimeSeconds: 0, cost: 0 },
      consumed: { externalOperations: 0, modelTokens: 0, wallTimeSeconds: 0, cost: 0 },
      reservations: [],
    });
  }

  async reserveBudget() {
    this.reservations += 1;
    return this.getMissionBudget();
  }

  async settleBudgetReservation(input: { state: string }) {
    this.settlements.push(input.state);
    return this.getMissionBudget();
  }

  async createOperationIntent(input: ExternalOperation): Promise<ExternalOperation> {
    if (this.operation) return this.operation;
    this.operation = input;
    return input;
  }

  async transitionExternalOperation(input: {
    to: ExternalOperation["state"];
    at: string;
    externalIdentity?: Record<string, unknown>;
  }): Promise<ExternalOperation> {
    if (!this.operation) throw new Error("operation missing");
    this.operation = ExternalOperationSchema.parse({
      ...this.operation,
      state: input.to,
      revision: this.operation.revision + 1,
      externalIdentity: input.externalIdentity ?? this.operation.externalIdentity,
      updatedAt: input.at,
    });
    return this.operation;
  }

  async getMissionProjectAssociation() {
    return this.association
      ? ({
          missionId: this.workUnit.missionId,
          ownerUserId: "scientist-md-1",
          projectId: "project-md-1",
        } as const)
      : null;
  }

  async getMissionProvenance(): Promise<MissionProvenance> {
    return {
      mission: {
        id: this.workUnit.missionId,
        requestedBy: { id: "scientist-md-1", kind: "human", role: "scientific_reviewer" },
      } as MissionProvenance["mission"],
      budget: (await this.getMissionBudget()) as MissionProvenance["budget"],
      budgetReservations: [],
      skillResolutions: [],
      plans: [],
      workUnits: [this.workUnit],
      workUnitClaims: [],
      checkpoints: [],
      decisions: this.decisions,
      approvals: [],
      operations: this.operation ? [this.operation] : [],
      receipts: [],
      evidence: this.evidence,
      observations: [],
      validations: [],
      modelInvocationIntents: [],
      modelInvocations: [],
      planningClaims: [],
      criticFindings: [],
      assessments: [],
      transitions: [],
      missingReferences: [],
      complete: false,
    };
  }
}

class MdDriverEffects implements ScientificEffectPersistence {
  constructor(
    private readonly store: MdDriverStore,
    private readonly onBegin?: (operation: ExternalOperation) => void,
  ) {}

  async beginWorkUnitEffect(input: {
    operationId: string;
    jobId: string;
    attemptId: string;
    at: string;
  }) {
    if (!this.store.operation || this.store.operation.id !== input.operationId)
      throw new Error("operation intent missing");
    this.store.operation = ExternalOperationSchema.parse({
      ...this.store.operation,
      state: "effect_started",
      revision: 2,
      updatedAt: input.at,
    });
    this.onBegin?.(this.store.operation);
    return { operation: this.store.operation, workUnit: this.store.workUnit };
  }

  async reconcileWorkUnitEffect(): Promise<ReconcileWorkUnitEffectResult> {
    throw new Error("not used by the MD driver before P1-04");
  }
}

function preparedSubmit(
  operation: ExternalOperation,
  bundle: Awaited<ReturnType<typeof fixture>>["bundle"],
) {
  const request = operation.request;
  const requestDigest = operation.requestDigest;
  const binding = createSlurmSubmissionBinding({
    operationId: operation.id,
    requestDigest,
    admissionDigest: D("a"),
    scriptDigest: D("b"),
    siteProfileDigest: D("c"),
    uid: 2101,
    cluster: "fixture-cluster",
    notBefore: T1,
    expiresAt: T2,
    resources: {
      partition: "chem",
      node: "worker-01",
      account: "fixture-account",
      cpus: 1,
      memoryMiB: 256,
      walltimeSeconds: 60,
    },
  });
  const body = {
    schemaVersion: "eigengrid.amber-slurm-delivery/v1" as const,
    request,
    binding,
    bundle: bundle.reference,
  };
  const bodyBytes = Buffer.from(canonicalJson(body));
  const unsigned = {
    schemaVersion: "eigengrid.md-effect-delivery/v1" as const,
    operationId: operation.id,
    missionId: operation.missionId,
    workUnitId: operation.workUnitId,
    requestDigest,
    admissionDigest: D("a"),
    fencingGeneration: 1,
    principal: {
      subject: "scientist-md-1",
      projectId: "project-md-1",
      uid: 2101,
      gid: 2102,
      siteProfileDigest: D("c"),
    },
    transport: "slurm.amber-md/v1" as const,
    bindingDigest: binding.bindingDigest,
    bodyBase64: bodyBytes.toString("base64"),
    notBefore: T1,
    expiresAt: T2,
    bodyDigest: createHash("sha256").update(bodyBytes).digest("hex"),
    createdAt: T1,
  };
  const delivery = { ...unsigned, deliveryDigest: digestCanonical(unsigned) };
  const capability = {
    version: "eigengrid.submitter-capability/v1" as const,
    action: "submit" as const,
    requestId: "request-md-driver-1",
    subject: "scientist-md-1",
    projectId: "project-md-1",
    uid: 2101,
    gid: 2102,
    recoveryEpoch: "epoch-md-driver-1",
    membershipGeneration: 1,
    siteProfileDigest: D("c"),
    operationId: operation.id,
    requestDigest,
    admissionDigest: D("a"),
    bindingDigest: binding.bindingDigest,
    bodyDigest: unsigned.bodyDigest,
    fencingGeneration: 1,
    notBeforeMs: Date.parse(T1),
    expiresAtMs: Date.parse(T2),
  };
  return { action: "submit" as const, delivery, capability, wire: new Uint8Array([1, 2, 3]) };
}

function gateway(
  input: Awaited<ReturnType<typeof fixture>>,
  behavior: { action?: "submit" | "observe"; rpc?: "acknowledged" | "lost" } = {},
) {
  let bundleReads = 0;
  let prepareCalls = 0;
  let authorizeCalls = 0;
  let rpcCalls = 0;
  let capturedOperation: ExternalOperation | undefined;
  const session: HeadMdAmberDeliverySession = {
    async prepare() {
      prepareCalls += 1;
      if (!capturedOperation) throw new Error("test session requires the durable operation");
      const prepared = preparedSubmit(capturedOperation, input.bundle);
      if (behavior.action === "observe") return { ...prepared, action: "observe" as const };
      return prepared;
    },
    async observe() {
      throw new Error("P1-03 must not observe through RPC");
    },
    async authorizeObserveRpc() {
      throw new Error("Legacy test gateway does not expose observation RPC");
    },
    async authorizeSubmitRpc() {
      authorizeCalls += 1;
      if (!capturedOperation) throw new Error("test session requires the durable operation");
      const prepared = preparedSubmit(capturedOperation, input.bundle);
      return {
        socketPath: "/run/eigengrid/fixture.sock",
        wire: new Uint8Array([1, 2, 3]),
        delivery: prepared.delivery,
        capabilityRequestId: prepared.capability.requestId,
      };
    },
  };
  return {
    value: {
      database: {
        _provider: "postgres" as const,
        beginTransaction: async () => {
          throw new Error("not used");
        },
      },
      prepareBundle: async () => {
        bundleReads += 1;
        return input.bundle;
      },
      siteAuthority: {
        createAmberDeliverySession(
          _database: ScientificDatabase,
          _association: { subject: string; projectId: string },
          _bundle: VerifiedAmberStageBundle,
          _now?: () => Date,
        ) {
          return session;
        },
      },
      callSubmitter: async (_socketPath: string, _wire: Uint8Array) => {
        rpcCalls += 1;
        if (behavior.rpc === "lost") throw new Error("simulated lost submitter ACK");
        if (!capturedOperation) throw new Error("operation missing at RPC");
        return {
          status: "consumed" as const,
          operationId: capturedOperation.id,
          resubmitAllowed: false as const,
          receipt: {
            status: "acknowledged" as const,
            resubmitAllowed: false as const,
            jobId: "101",
            cluster: "fixture-cluster",
          },
          requiresReconciliation: true as const,
        };
      },
    },
    setOperation(operation: ExternalOperation) {
      capturedOperation = operation;
    },
    counts: () => ({ bundleReads, prepareCalls, authorizeCalls, rpcCalls }),
  };
}

describe("CanonicalScientificExecutionDriver MD bridge", () => {
  test("uses the verified MD bundle and one protected submitter call, never local execution", async () => {
    const input = await fixture();
    const store = new MdDriverStore(input.workUnit);
    const g = gateway(input);
    const effects = new MdDriverEffects(store, (operation) => g.setOperation(operation));
    const driver = new CanonicalScientificExecutionDriver({
      store: store as unknown as ScientificStore,
      execution: {
        async executeLocal() {
          throw new Error("MD must not use executeLocal");
        },
        async reconcileLocal() {
          throw new Error("MD must not use reconcileLocal");
        },
        async dispatchExistingJob() {
          throw new Error("not used");
        },
        async collectLocal() {
          throw new Error("not used");
        },
        async parseJob() {
          throw new Error("not used");
        },
        async cancelLocal() {
          throw new Error("not used");
        },
      },
      effectPersistence: effects,
      currentPolicyDigestFor: () => D("d"),
      md: {
        ...g.value,
        prepareBundle: async (workUnit) => {
          expect(workUnit.id).toBe(input.workUnit.id);
          return g.value.prepareBundle();
        },
        siteAuthority: {
          createAmberDeliverySession(...args) {
            expect(args[1]).toEqual({ subject: "scientist-md-1", projectId: "project-md-1" });
            return g.value.siteAuthority.createAmberDeliverySession(...args);
          },
        },
        callSubmitter: async (...args) => {
          if (!store.operation) throw new Error("durable operation missing");
          g.setOperation(store.operation);
          return g.value.callSubmitter!(...args);
        },
      },
      now: () => new Date(T1),
    });

    const result = await driver.executeClaimedWorkUnit(input.workUnit, {
      ownerId: "head-md-driver-1",
      claimOwner: "head-md-driver-1",
      now: T1,
    });
    expect(result.status).toBe("progressed");
    expect(store.operation).toMatchObject({
      kind: "md_stage_execution",
      state: "acknowledged",
      requestDigest: digestCanonical(input.request),
      externalIdentity: {
        transportStatus: "consumed",
        slurmJobId: "101",
        slurmCluster: "fixture-cluster",
      },
    });
    expect(g.counts()).toEqual({ bundleReads: 1, prepareCalls: 1, authorizeCalls: 1, rpcCalls: 1 });
    expect(store.reservations).toBe(1);
    expect(store.settlements).toEqual([]);

    const replay = await driver.executeClaimedWorkUnit(input.workUnit, {
      ownerId: "head-md-driver-1",
      claimOwner: "head-md-driver-1",
      now: T1,
    });
    expect(replay.status).toBe("waiting");
    expect(g.counts()).toEqual({ bundleReads: 2, prepareCalls: 1, authorizeCalls: 1, rpcCalls: 1 });
    expect(
      (await driver.reconcileOperation(store.operation!, { ownerId: "head-md-driver-1", now: T1 }))
        .status,
    ).toBe("waiting");
  });

  test("does not submit again after a lost submitter acknowledgement", async () => {
    const input = await fixture();
    const store = new MdDriverStore(input.workUnit);
    const g = gateway(input, { rpc: "lost" });
    const driver = new CanonicalScientificExecutionDriver({
      store: store as unknown as ScientificStore,
      execution: {} as never,
      effectPersistence: new MdDriverEffects(store, (operation) => g.setOperation(operation)),
      currentPolicyDigestFor: () => D("d"),
      md: {
        ...g.value,
        callSubmitter: async (...args) => {
          if (!store.operation) throw new Error("durable operation missing");
          g.setOperation(store.operation);
          return g.value.callSubmitter!(...args);
        },
      },
      now: () => new Date(T1),
    });
    const first = await driver.executeClaimedWorkUnit(input.workUnit, {
      ownerId: "head-md-driver-1",
      claimOwner: "head-md-driver-1",
      now: T1,
    });
    expect(first.status).toBe("waiting");
    expect(store.operation?.state).toBe("ambiguous");
    expect(g.counts()).toEqual({ bundleReads: 1, prepareCalls: 1, authorizeCalls: 1, rpcCalls: 1 });
    const replay = await driver.executeClaimedWorkUnit(input.workUnit, {
      ownerId: "head-md-driver-1",
      claimOwner: "head-md-driver-1",
      now: T1,
    });
    expect(replay.status).toBe("waiting");
    expect(g.counts()).toEqual({ bundleReads: 2, prepareCalls: 1, authorizeCalls: 1, rpcCalls: 1 });
  });

  test("a concurrent preparation rejection preserves the already admitted effect", async () => {
    const input = await fixture();
    const claim = structuredClone(input.workUnit);
    const store = new MdDriverStore(input.workUnit);
    const g = gateway(input);
    let prepared = 0;
    let releaseBoth!: () => void;
    const both = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    let releaseAdmitted!: () => void;
    const admitted = new Promise<void>((resolve) => {
      releaseAdmitted = resolve;
    });
    const make = () =>
      new CanonicalScientificExecutionDriver({
        store: store as unknown as ScientificStore,
        execution: {} as never,
        effectPersistence: new MdDriverEffects(store, (operation) => {
          g.setOperation(operation);
          store.workUnit.state = "executing";
          store.workUnit.revision++;
          releaseAdmitted();
        }),
        currentPolicyDigestFor: () => D("d"),
        now: () => new Date(T1),
        md: {
          ...g.value,
          prepareBundle: async () => {
            if (++prepared === 1) {
              await both;
              return input.bundle;
            }
            releaseBoth();
            await admitted;
            throw new Error("MD preparation requires a pre-effect WorkUnit");
          },
        },
      });
    const results = await Promise.all([
      make().executeClaimedWorkUnit(claim, {
        ownerId: "head-md-driver-1",
        claimOwner: "head-md-driver-1",
        now: T1,
      }),
      make().executeClaimedWorkUnit(claim, {
        ownerId: "head-md-driver-1",
        claimOwner: "head-md-driver-1",
        now: T1,
      }),
    ]);
    expect(results.map((value) => value.status).sort()).toEqual(["progressed", "waiting"]);
    expect(store.operation?.state).toBe("acknowledged");
    expect(store.workUnit.state).toBe("executing");
    expect(g.counts().rpcCalls).toBe(1);
  });

  test("fails closed before admission when the immutable mission-project association is absent", async () => {
    const input = await fixture();
    const store = new MdDriverStore(input.workUnit, false);
    const g = gateway(input);
    const driver = new CanonicalScientificExecutionDriver({
      store: store as unknown as ScientificStore,
      execution: {} as never,
      effectPersistence: new MdDriverEffects(store),
      currentPolicyDigestFor: () => D("d"),
      md: g.value,
      now: () => new Date(T1),
    });
    const result = await driver.executeClaimedWorkUnit(input.workUnit, {
      ownerId: "head-md-driver-1",
      claimOwner: "head-md-driver-1",
      now: T1,
    });
    expect(result).toMatchObject({ status: "failed", retryable: false });
    expect(store.operation).toBeUndefined();
    expect(store.reservations).toBe(0);
    expect(g.counts()).toEqual({ bundleReads: 0, prepareCalls: 0, authorizeCalls: 0, rpcCalls: 0 });
  });
});

function matchedRecoveryResponse(prepared: ReturnType<typeof preparedSubmit>, jobId = "101") {
  const binding = parseAmberSlurmDelivery(prepared.delivery).binding;
  const identity = {
    jobId,
    cluster: binding.cluster,
    uid: binding.uid,
    submittedAt: T1.replace(".000Z", "Z"),
  };
  return {
    status: "observation",
    operationId: prepared.delivery.operationId,
    resubmitAllowed: false,
    observation: {
      status: "matched",
      resubmitAllowed: false,
      reason: "Exact scheduler binding",
      markerEvidence: "accounting_comment",
      identity,
      observations: [
        {
          ...identity,
          source: "sacct",
          jobName: slurmSubmissionJobName(binding),
          marker: slurmSubmissionMarker(binding),
        },
      ],
    },
  };
}

async function recoveryFixture() {
  const input = await fixture();
  const store = new MdDriverStore(input.workUnit);
  const submit = gateway(input, { rpc: "lost" });
  const submitDriver = new CanonicalScientificExecutionDriver({
    store: store as unknown as ScientificStore,
    execution: {} as never,
    effectPersistence: new MdDriverEffects(store, (operation) => submit.setOperation(operation)),
    currentPolicyDigestFor: () => D("d"),
    md: submit.value,
    now: () => new Date(T1),
  });
  await submitDriver.executeClaimedWorkUnit(input.workUnit, {
    ownerId: "head-recovery",
    claimOwner: "head-md-driver-1",
    now: T1,
  });
  if (!store.operation) throw new Error("Missing lost-ACK operation");
  const frozen = preparedSubmit(store.operation, input.bundle);
  let calls = 0;
  let denied = false;
  let response: unknown = matchedRecoveryResponse(frozen);
  let transportFailure = false;
  let duringRpc: (() => void) | undefined;
  const driver = new CanonicalScientificExecutionDriver({
    store: store as unknown as ScientificStore,
    execution: {} as never,
    effectPersistence: new MdDriverEffects(store),
    currentPolicyDigestFor: () => D("d"),
    md: {
      ...submit.value,
      prepareBundle: async () => {
        throw new Error("Recovery must not access CAS");
      },
      siteAuthority: {
        createAmberDeliverySession: () => {
          throw new Error("Recovery must not prepare a delivery");
        },
        createAmberObservationSession: () => ({
          async observe() {
            if (denied) throw new Error("SECRET protected authority revoked");
            return {
              ...frozen,
              action: "observe" as const,
              capability: { ...frozen.capability, action: "observe" as const },
            };
          },
          async authorizeObserveRpc() {
            if (denied) throw new Error("SECRET protected authority revoked");
            return {
              socketPath: "/run/eigengrid/fixture.sock",
              wire: new Uint8Array([4]),
              delivery: frozen.delivery,
              capabilityRequestId: "recovery-1",
            };
          },
        }),
      },
      callSubmitter: async () => {
        calls++;
        duringRpc?.();
        if (transportFailure) throw new Error("SECRET backend detail");
        return response;
      },
    },
    now: () => new Date(T2),
  });
  return {
    store,
    frozen,
    submit,
    driver,
    calls: () => calls,
    deny: () => {
      denied = true;
    },
    failTransport: () => {
      transportFailure = true;
    },
    respond: (value: unknown) => {
      response = value;
    },
    duringRpc: (callback: () => void) => {
      duringRpc = callback;
    },
    reconcile: () =>
      driver.reconcileOperation(store.operation!, { ownerId: "head-recovery", now: T2 }),
  };
}

describe("MD delivery recovery", () => {
  test("recovers a lost ACK by observation without CAS, second submit, receipt or budget release", async () => {
    const f = await recoveryFixture();
    expect(f.store.operation?.state).toBe("ambiguous");
    expect(await f.reconcile()).toMatchObject({ status: "waiting" });
    expect(f.store.operation).toMatchObject({
      state: "acknowledged",
      externalIdentity: { slurmJobId: "101", transportStatus: "observed" },
    });
    expect(f.store.operation?.receiptId).toBeUndefined();
    expect(f.store.settlements).not.toContain("released");
    expect(f.submit.counts().rpcCalls).toBe(1);
    const first = f.store.decisions[0];
    expect(JSON.parse(first!.rationale).outcome).toBe("matched");
    expect(first!.requiresApproval).toBe(false);
    await f.reconcile();
    expect(f.store.decisions).toHaveLength(1);
    expect(f.calls()).toBe(2);
    expect(f.submit.counts().rpcCalls).toBe(1);
  });

  test.each(["rejected", "conflict", "indeterminate", "malformed", "transport"])(
    "preserves %s as a durable nonterminal diagnostic",
    async (status) => {
      const f = await recoveryFixture();
      if (status === "rejected") f.respond({ status: "rejected", resubmitAllowed: false });
      else if (status === "malformed")
        f.respond({ status: "confirmed", exitCode: 0, secret: "SECRET" });
      else if (status === "transport") f.failTransport();
      else
        f.respond({
          status: "observation",
          operationId: f.frozen.delivery.operationId,
          resubmitAllowed: false,
          observation: {
            status,
            resubmitAllowed: false,
            reason: "SECRET remote diagnostic",
            observations: [],
          },
        });
      expect((await f.reconcile()).status).toBe("waiting");
      expect(f.store.operation?.state).toBe("ambiguous");
      expect(f.store.operation?.receiptId).toBeUndefined();
      expect(f.store.settlements).not.toContain("released");
      expect(JSON.stringify(f.store.decisions)).not.toContain("SECRET");
      await f.reconcile();
      expect(f.store.decisions).toHaveLength(1);
      expect(f.submit.counts().rpcCalls).toBe(1);
    },
  );

  test("blocks a revoked protected authority before observation RPC and records the boundary", async () => {
    const f = await recoveryFixture();
    f.deny();
    await f.reconcile();
    expect(f.calls()).toBe(0);
    expect(JSON.parse(f.store.decisions[0]!.rationale).outcome).toBe(
      "authority_or_delivery_unavailable",
    );
    expect(f.store.operation?.state).toBe("ambiguous");
  });

  test("does not replace an acknowledged job with a different matched identity", async () => {
    const f = await recoveryFixture();
    await f.reconcile();
    f.respond(matchedRecoveryResponse(f.frozen, "102"));
    await f.reconcile();
    expect(f.store.operation).toMatchObject({
      state: "acknowledged",
      externalIdentity: { slurmJobId: "101" },
    });
    expect(JSON.parse(f.store.decisions.at(-1)!.rationale).outcome).toBe("identity_conflict");
    expect(f.submit.counts().rpcCalls).toBe(1);
  });

  test("a changed submission timestamp conflicts with the already observed scheduler identity", async () => {
    const f = await recoveryFixture();
    await f.reconcile();
    const changed = matchedRecoveryResponse(f.frozen);
    changed.observation.identity.submittedAt = "2026-09-20T00:01:01Z";
    changed.observation.observations[0]!.submittedAt = "2026-09-20T00:01:01Z";
    f.respond(changed);
    await f.reconcile();
    expect(JSON.parse(f.store.decisions.at(-1)!.rationale).outcome).toBe("identity_conflict");
    expect(f.store.operation?.externalIdentity?.slurmSubmittedAt).toBe("2026-09-20T00:01:00Z");
  });

  test("a stale observation cannot replace a newer durable identity", async () => {
    const f = await recoveryFixture();
    f.duringRpc(() => {
      f.store.operation = ExternalOperationSchema.parse({
        ...f.store.operation,
        state: "acknowledged",
        revision: f.store.operation!.revision + 1,
        externalIdentity: { slurmJobId: "777", slurmCluster: "fixture-cluster" },
      });
    });
    await f.reconcile();
    expect(f.store.operation).toMatchObject({
      state: "acknowledged",
      externalIdentity: { slurmJobId: "777" },
    });
    expect(JSON.parse(f.store.decisions.at(-1)!.rationale).outcome).toBe("state_changed");
  });

  test("shutdown after observation RPC prevents durable mutations", async () => {
    const f = await recoveryFixture();
    const controller = new AbortController();
    f.duringRpc(() => controller.abort());
    const before = structuredClone(f.store.operation);
    await f.driver.reconcileOperation(f.store.operation!, {
      ownerId: "head-recovery",
      now: T2,
      signal: controller.signal,
    });
    expect(f.store.operation).toEqual(before);
    expect(f.store.decisions).toHaveLength(0);
  });

  test("a revoked observer preserves previously acknowledged transport evidence", async () => {
    const f = await recoveryFixture();
    await f.reconcile();
    f.deny();
    await f.reconcile();
    expect(f.store.operation).toMatchObject({
      state: "acknowledged",
      externalIdentity: { slurmJobId: "101" },
    });
    expect(JSON.parse(f.store.decisions.at(-1)!.rationale).outcome).toBe(
      "authority_or_delivery_unavailable",
    );
  });

  test("does not claim persistence when the diagnostic store is unavailable", async () => {
    const f = await recoveryFixture();
    f.store.createDecision = async () => {
      throw new Error("DB unavailable");
    };
    expect(await f.reconcile()).toMatchObject({ status: "waiting" });
    expect((await f.reconcile()).detail).toContain("durable diagnostic/state update unavailable");
    expect(f.store.operation?.state).toBe("ambiguous");
    expect(f.store.decisions).toHaveLength(0);
  });
});
