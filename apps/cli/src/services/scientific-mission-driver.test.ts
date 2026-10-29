import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EvidenceReferenceSchema,
  ExternalOperationSchema,
  MissionBudgetSchema,
  WorkUnitSchema,
  digestCanonical,
  type ExternalOperation,
  type EvidenceReference,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import type {
  MissionProvenance,
  ReconcileWorkUnitEffectResult,
  ScientificEffectPersistence,
} from "@eigengrid/mission-runtime";
import type { ScientificStore } from "@eigengrid/mission-runtime";
import type {
  ExecutionService,
  LocalExecutionRequest,
  ReconcileLocalOutcome,
} from "./execution-coordinator";
import {
  CanonicalScientificExecutionDriver,
  type ScientificExecutionBindingResolver,
} from "./scientific-mission-driver";

const T0 = "2026-08-06T00:00:00.000Z";
const T1 = "2026-08-06T00:01:00.000Z";
const T2 = "2026-08-06T00:02:00.000Z";
const T3 = "2026-08-06T00:03:00.000Z";
const D = (character: string): string => character.repeat(64);
const digestBytes = (value: string): string => createHash("sha256").update(value).digest("hex");

const fragment = {
  skillId: "methods.fixture",
  version: "1.0.0",
  contentDigest: D("a"),
  fragmentId: "fixture.execute",
  fragmentDigest: D("b"),
  relativePath: "protocols/fixture.yaml",
  selector: "$",
};

function claimedWorkUnit(): WorkUnit {
  return WorkUnitSchema.parse({
    id: "work-ambiguous",
    missionId: "mission-ambiguous",
    planId: "plan-ambiguous",
    planVersion: 1,
    kind: "optimization",
    state: "claimed",
    reason: "Execute the deterministic ambiguity fixture",
    dependencies: [],
    inputRefs: ["evidence-structure"],
    outputContract: {
      requiredEvidenceKinds: ["artifact"],
      requiredObservationKinds: ["normal_termination"],
    },
    skillRefs: [fragment],
    protocolFragment: {
      id: "fragment-ambiguous",
      kind: "optimization",
      reason: "Execute the deterministic ambiguity fixture",
      parameters: {},
      sourceFragments: [fragment],
      riskClass: 1,
    },
    retryPolicy: { maximumAttempts: 1, ambiguityRequiresReconciliation: true },
    approvalPolicy: { required: true, minimumRole: "scientific_reviewer" },
    executionPolicy: { capability: "fixture.execute", riskClass: 1 },
    revision: 3,
    claimOwner: "head-stable",
    claimExpiresAt: T3,
    jobId: null,
    attemptId: null,
    createdAt: T0,
    updatedAt: T1,
  });
}

class FakeScientificStore {
  operation: ExternalOperation | null = null;
  workUnit = claimedWorkUnit();
  reservations = 0;
  settlements: string[] = [];
  evidence: EvidenceReference[] = [];

  async getExternalOperation(): Promise<ExternalOperation | null> {
    return this.operation;
  }

  async getMissionBudget() {
    return MissionBudgetSchema.parse({
      id: "budget-ambiguous",
      missionId: this.workUnit.missionId,
      revision: 1 + this.reservations + this.settlements.length,
      limits: { externalOperations: 3, modelTokens: 0, wallTimeSeconds: 0, cost: 0 },
      consumed: { externalOperations: 0, modelTokens: 0, wallTimeSeconds: 0, cost: 0 },
      reservations: [],
    });
  }

  async reserveBudget(_input: { reservation: unknown }) {
    this.reservations += 1;
    return this.getMissionBudget();
  }

  async settleBudgetReservation(input: { state: string }) {
    this.settlements.push(input.state);
    return this.getMissionBudget();
  }

  async createOperationIntent(input: ExternalOperation): Promise<ExternalOperation> {
    this.operation = input;
    return input;
  }

  async transitionExternalOperation(input: {
    to: ExternalOperation["state"];
    at: string;
    externalIdentity?: Record<string, unknown>;
  }): Promise<ExternalOperation> {
    if (!this.operation) throw new Error("missing operation");
    this.operation = ExternalOperationSchema.parse({
      ...this.operation,
      state: input.to,
      revision: this.operation.revision + 1,
      externalIdentity: input.externalIdentity ?? this.operation.externalIdentity,
      updatedAt: input.at,
    });
    return this.operation;
  }

  async getMissionProvenance(): Promise<MissionProvenance> {
    return {
      mission: { id: this.workUnit.missionId } as MissionProvenance["mission"],
      budget: (await this.getMissionBudget()) as MissionProvenance["budget"],
      budgetReservations: [],
      skillResolutions: [],
      plans: [
        {
          id: this.workUnit.planId,
          version: this.workUnit.planVersion,
          revision: 1,
          planDigest: D("c"),
        } as MissionProvenance["plans"][number],
      ],
      workUnits: [this.workUnit],
      workUnitClaims: [],
      checkpoints: [],
      decisions: [],
      approvals: [
        {
          subjectType: "plan",
          subjectId: this.workUnit.planId,
          subjectVersion: this.workUnit.planVersion,
          subjectRevision: 1,
          payloadDigest: D("c"),
          policyDigest: D("d"),
          state: "approved",
          requestedAt: T0,
        } as MissionProvenance["approvals"][number],
      ],
      operations: this.operation ? [this.operation] : [],
      receipts: [],
      evidence: [...this.evidence],
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

  async getWorkUnit(): Promise<WorkUnit> {
    return this.workUnit;
  }

  async createEvidence(input: unknown): Promise<EvidenceReference> {
    const evidence = EvidenceReferenceSchema.parse(input);
    if (evidence.kind === "operation_receipt") {
      throw new Error("No receipt evidence is expected for an ambiguous operation");
    }
    const existing = this.evidence.find((candidate) => candidate.id === evidence.id);
    if (existing) {
      if (digestCanonical(existing) !== digestCanonical(evidence)) {
        throw new Error(`Conflicting evidence payload for ${evidence.id}`);
      }
      return existing;
    }
    this.evidence.push(evidence);
    return evidence;
  }
}

class FakeEffectPersistence implements ScientificEffectPersistence {
  constructor(private readonly store: FakeScientificStore) {}

  async beginWorkUnitEffect(input: {
    operationId: string;
    jobId: string;
    attemptId: string;
    at: string;
  }) {
    if (!this.store.operation || this.store.operation.id !== input.operationId) {
      throw new Error("missing operation intent");
    }
    this.store.operation = ExternalOperationSchema.parse({
      ...this.store.operation,
      state: "effect_started",
      revision: this.store.operation.revision + 1,
      updatedAt: input.at,
    });
    this.store.workUnit = WorkUnitSchema.parse({
      ...this.store.workUnit,
      state: "executing",
      revision: this.store.workUnit.revision + 1,
      jobId: input.jobId,
      attemptId: input.attemptId,
      updatedAt: input.at,
    });
    return { operation: this.store.operation, workUnit: this.store.workUnit };
  }

  async reconcileWorkUnitEffect(): Promise<ReconcileWorkUnitEffectResult> {
    throw new Error("No terminal receipt exists in this scenario");
  }
}

describe("CanonicalScientificExecutionDriver ambiguity boundary", () => {
  test("does not dispatch a second effect after launch ambiguity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "eigengrid-scientific-driver-"));
    const inputPath = join(directory, "input.xyz");
    const input = "1\nfixture\nH 0 0 0\n";
    writeFileSync(inputPath, input, "utf8");
    const store = new FakeScientificStore();
    let executeCalls = 0;
    let reconcileCalls = 0;
    let dispatchedRequest: LocalExecutionRequest | undefined;
    const execution: ExecutionService = {
      async executeLocal(request) {
        executeCalls += 1;
        dispatchedRequest = request;
        throw new Error("connection dropped after the coordinator accepted the request");
      },
      async reconcileLocal(jobId, attemptId): Promise<ReconcileLocalOutcome> {
        reconcileCalls += 1;
        return {
          status: "safely-unknown",
          jobId,
          attemptId,
          message: "No trustworthy completion or absence evidence is available",
        };
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
    };
    const bindingResolver: ScientificExecutionBindingResolver = {
      async resolve() {
        return {
          software: "fixture",
          recipeId: "ambiguous-launch",
          inputEvidenceId: "evidence-structure",
          inputPath,
          inputContentDigest: digestBytes(input),
          name: "ambiguous-launch",
        };
      },
    };
    const driver = new CanonicalScientificExecutionDriver({
      store: store as unknown as ScientificStore,
      execution,
      effectPersistence: new FakeEffectPersistence(store),
      currentPolicyDigestFor: () => D("d"),
      bindingResolver,
      now: () => new Date(T2),
    });
    try {
      const first = await driver.executeClaimedWorkUnit(claimedWorkUnit(), {
        ownerId: "head-stable",
        claimOwner: "head-stable",
        now: T2,
      });
      expect(first.status).toBe("waiting");
      expect(executeCalls).toBe(1);
      expect(store.operation?.state).toBe("ambiguous");
      expect(store.settlements).toEqual(["ambiguous"]);

      const operation = store.operation;
      if (!operation) throw new Error("Expected persisted ambiguous operation");
      const second = await driver.reconcileOperation(operation, {
        ownerId: "head-stable",
        now: T3,
      });
      expect(second.status).toBe("ambiguous");
      expect(executeCalls).toBe(1);
      expect(reconcileCalls).toBe(1);
      expect(store.operation?.state).toBe("ambiguous");
      expect(store.settlements).toEqual(["ambiguous", "ambiguous"]);

      expect(operation.requestDigest).toBe(digestCanonical(operation.request));
      expect(operation.policyDigest).toBe(D("d"));
      expect(operation.request).toMatchObject({ inputContentDigest: digestBytes(input) });
      expect(dispatchedRequest?.expectedInputDigest).toBe(digestBytes(input));
      expect(store.evidence).toHaveLength(1);
      expect(store.evidence[0]).toMatchObject({
        kind: "rendered_input",
        sourceId: "evidence-structure",
        contentDigest: digestBytes(input),
        immutable: true,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects mutated input bytes before crossing effect_started or dispatching", async () => {
    const directory = mkdtempSync(join(tmpdir(), "eigengrid-scientific-input-"));
    const inputPath = join(directory, "input.xyz");
    const approvedInput = "1\napproved\nH 0 0 0\n";
    writeFileSync(inputPath, "1\nmutated\nHe 0 0 0\n", "utf8");
    const store = new FakeScientificStore();
    let effects = 0;
    let dispatches = 0;
    const effectPersistence: ScientificEffectPersistence = {
      async beginWorkUnitEffect() {
        effects += 1;
        throw new Error("unexpected effect boundary");
      },
      async reconcileWorkUnitEffect() {
        throw new Error("unexpected reconciliation");
      },
    };
    const execution = {
      async executeLocal() {
        dispatches += 1;
        throw new Error("unexpected dispatch");
      },
    } as unknown as ExecutionService;
    const driver = new CanonicalScientificExecutionDriver({
      store: store as unknown as ScientificStore,
      execution,
      effectPersistence,
      currentPolicyDigestFor: () => D("d"),
      bindingResolver: {
        async resolve() {
          return {
            software: "fixture",
            recipeId: "mutated-input",
            inputEvidenceId: "evidence-structure",
            inputPath,
            inputContentDigest: digestBytes(approvedInput),
            name: "mutated-input",
          };
        },
      },
      now: () => new Date(T2),
    });
    try {
      const result = await driver.executeClaimedWorkUnit(claimedWorkUnit(), {
        ownerId: "head-stable",
        claimOwner: "head-stable",
        now: T2,
      });
      expect(result).toMatchObject({ status: "failed", retryable: false });
      expect(result.detail).toContain("do not match the approved content digest");
      expect(effects).toBe(0);
      expect(dispatches).toBe(0);
      expect(store.operation).toBeNull();
      expect(store.evidence).toHaveLength(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("treats rendered-input persistence failure after the effect boundary as ambiguous", async () => {
    const directory = mkdtempSync(join(tmpdir(), "eigengrid-scientific-evidence-"));
    const inputPath = join(directory, "input.xyz");
    const input = "1\napproved\nH 0 0 0\n";
    writeFileSync(inputPath, input, "utf8");
    const store = new FakeScientificStore();
    store.createEvidence = async () => {
      throw new Error("evidence persistence unavailable");
    };
    let dispatches = 0;
    const driver = new CanonicalScientificExecutionDriver({
      store: store as unknown as ScientificStore,
      execution: {
        async executeLocal() {
          dispatches += 1;
          throw new Error("unexpected dispatch");
        },
      } as unknown as ExecutionService,
      effectPersistence: new FakeEffectPersistence(store),
      currentPolicyDigestFor: () => D("d"),
      bindingResolver: {
        async resolve() {
          return {
            software: "fixture",
            recipeId: "evidence-failure",
            inputEvidenceId: "evidence-structure",
            inputPath,
            inputContentDigest: digestBytes(input),
            name: "evidence-failure",
          };
        },
      },
      now: () => new Date(T2),
    });
    try {
      const result = await driver.executeClaimedWorkUnit(claimedWorkUnit(), {
        ownerId: "head-stable",
        claimOwner: "head-stable",
        now: T2,
      });
      expect(result).toMatchObject({ status: "waiting" });
      expect(result.detail).toContain("will not be replayed");
      expect(dispatches).toBe(0);
      expect(store.operation?.state).toBe("ambiguous");
      expect(store.settlements).toEqual(["ambiguous"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects a preexisting intent for different execution content before effect or dispatch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "eigengrid-scientific-intent-"));
    const inputPath = join(directory, "input.xyz");
    const input = "1\napproved\nH 0 0 0\n";
    writeFileSync(inputPath, input, "utf8");
    const store = new FakeScientificStore();
    const staleRequest = {
      capability: "fixture.execute",
      missionId: "mission-ambiguous",
      planId: "plan-ambiguous",
      planVersion: 1,
      workUnitId: "work-ambiguous",
      inputEvidenceId: "other-evidence",
      inputContentDigest: D("f"),
      intendedJobId: "job-stale",
      intendedAttemptId: "attempt-stale",
    };
    store.operation = ExternalOperationSchema.parse({
      id: "operation-stale",
      missionId: "mission-ambiguous",
      workUnitId: "work-ambiguous",
      idempotencyKey: "stale-intent",
      kind: "local_execution",
      state: "intent",
      request: staleRequest,
      requestDigest: digestCanonical(staleRequest),
      policyDigest: D("d"),
      revision: 1,
      createdAt: T0,
      updatedAt: T0,
    });
    let effects = 0;
    let dispatches = 0;
    const driver = new CanonicalScientificExecutionDriver({
      store: store as unknown as ScientificStore,
      execution: {
        async executeLocal() {
          dispatches += 1;
          throw new Error("unexpected dispatch");
        },
      } as unknown as ExecutionService,
      effectPersistence: {
        async beginWorkUnitEffect() {
          effects += 1;
          throw new Error("unexpected effect boundary");
        },
        async reconcileWorkUnitEffect() {
          throw new Error("unexpected reconciliation");
        },
      },
      currentPolicyDigestFor: () => D("d"),
      bindingResolver: {
        async resolve() {
          return {
            software: "fixture",
            recipeId: "exact-intent",
            inputEvidenceId: "evidence-structure",
            inputPath,
            inputContentDigest: digestBytes(input),
            name: "exact-intent",
          };
        },
      },
      now: () => new Date(T2),
    });
    try {
      const result = await driver.executeClaimedWorkUnit(claimedWorkUnit(), {
        ownerId: "head-stable",
        claimOwner: "head-stable",
        now: T2,
      });
      expect(result).toMatchObject({ status: "failed", retryable: false });
      expect(result.detail).toContain("does not match the exact approved execution request");
      expect(effects).toBe(0);
      expect(dispatches).toBe(0);
      expect(store.operation.state).toBe("intent");
      expect(store.evidence).toHaveLength(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
