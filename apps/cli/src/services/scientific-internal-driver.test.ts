import { describe, expect, test } from "bun:test";
import {
  EvidenceReferenceSchema,
  ScientificAssessmentSchema,
  ScientificObservationSchema,
  ValidationResultSchema,
  WorkUnitSchema,
  MdExecutionBindingParametersSchemaVersion,
  digestCanonical,
  type EvidenceReference,
  type ExternalOperation,
  type ScientificAssessment,
  type ScientificMission,
  type ScientificObservation,
  type ValidationResult,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import type {
  MissionProvenance,
  ScientificInternalWorkUnitPersistence,
  ScientificMissionWorkDriver,
  ScientificStore,
} from "@eigengrid/mission-runtime";
import { ScientificMissionDriverRouter } from "./scientific-internal-driver";

const T0 = "2026-08-06T00:00:00.000Z";
const T1 = "2026-08-06T00:01:00.000Z";
const D = (character: string): string => character.repeat(64);

const fragment = {
  skillId: "validation.fixture",
  version: "1.0.0",
  contentDigest: D("a"),
  fragmentId: "fixture.validate",
  fragmentDigest: D("b"),
  relativePath: "validation/fixture.yaml",
  selector: "$",
};

function internalWorkUnit(kind: "validation" | "assessment"): WorkUnit {
  return WorkUnitSchema.parse({
    id: `work-${kind}`,
    missionId: "mission-internal",
    planId: "plan-internal",
    planVersion: 1,
    kind,
    state: "claimed",
    reason: `Execute exact ${kind}`,
    dependencies: kind === "validation" ? ["work-external"] : ["work-validation"],
    inputRefs: [],
    outputContract: {
      requiredEvidenceKinds: ["parser_output", "skill_fragment"],
      requiredObservationKinds: ["normal_termination"],
    },
    skillRefs: [fragment],
    protocolFragment: {
      id: `fragment-${kind}`,
      kind,
      reason: `Execute exact ${kind}`,
      parameters: {},
      sourceFragments: [fragment],
      riskClass: 0,
    },
    retryPolicy: { maximumAttempts: 1, ambiguityRequiresReconciliation: true },
    approvalPolicy: { required: false },
    executionPolicy: { capability: `fixture.${kind}`, riskClass: 0 },
    revision: 2,
    claimOwner: "head-internal",
    claimExpiresAt: T1,
    jobId: null,
    attemptId: null,
    createdAt: T0,
    updatedAt: T0,
  });
}

function systemPreparationWorkUnit(): WorkUnit {
  const base = internalWorkUnit("validation");
  return WorkUnitSchema.parse({
    ...base,
    id: "work-system-preparation",
    kind: "scientific_capability",
    inputRefs: ["evidence-receptor"],
    outputContract: {
      requiredEvidenceKinds: ["topology", "coordinates", "atom_map"],
      requiredObservationKinds: ["artifact_integrity", "topology_integrity"],
    },
    protocolFragment: {
      schemaVersion: "eigengrid.scientific-capability-fragment/v1",
      id: "fragment-system-preparation",
      kind: "scientific_capability",
      capability: {
        id: "biomolecular.build-system",
        version: "1.0.0",
        contractDigest: D("f"),
      },
      reason: "Build one exact approved Amber system",
      parameters: { manifestId: "manifest-system", manifestRevision: 1, manifestDigest: D("e") },
      sourceFragments: [fragment],
      riskClass: 3,
    },
    executionPolicy: { capability: "biomolecular.build-system", riskClass: 3 },
  });
}

function parserEvidence(): EvidenceReference {
  return EvidenceReferenceSchema.parse({
    id: "evidence-parser-output",
    missionId: "mission-internal",
    workUnitId: "work-external",
    kind: "parser_output",
    uri: "eigengrid-parser-result://result-internal?parserVersion=parser-bridge%2F1",
    contentDigest: D("c"),
    immutable: true,
    sourceId: "result-internal",
    createdAt: T0,
  });
}

function skillEvidence(): EvidenceReference {
  return EvidenceReferenceSchema.parse({
    id: `evidence-skill-${digestCanonical({
      missionId: "mission-internal",
      fragment,
    }).slice(0, 24)}`,
    missionId: "mission-internal",
    kind: "skill_fragment",
    uri: "eigengrid-skill://validation.fixture@1.0.0/validation/fixture.yaml#$",
    contentDigest: fragment.fragmentDigest,
    immutable: true,
    sourceId: "skill-resolution-internal",
    createdAt: T0,
  });
}

function parserObservation(parserVersion?: string): ScientificObservation {
  return ScientificObservationSchema.parse({
    id: "observation-normal-termination",
    missionId: "mission-internal",
    workUnitId: "work-external",
    type: "normal_termination",
    payload: {
      value: true,
      parser: "fixture-parser",
      ...(parserVersion === undefined ? {} : { parserVersion }),
    },
    source: { kind: "parser", id: "result-internal" },
    evidenceRefs: ["evidence-parser-output"],
    qualityFlags: ["parser_backed"],
    observedAt: T0,
  });
}

function validationResult(): ValidationResult {
  return ValidationResultSchema.parse({
    id: "validation-normal-termination",
    missionId: "mission-internal",
    workUnitId: "work-validation",
    criterionId: "criterion-normal",
    status: "passed",
    summary: "Normal termination is true",
    observationRefs: ["observation-normal-termination"],
    evidenceRefs: ["evidence-parser-output", skillEvidence().id],
    validatorVersion: "1.0.0",
    createdAt: T0,
  });
}

class InternalStore {
  mission = {
    id: "mission-internal",
    state: "validating",
    revision: 3,
    objective: {
      system: {
        evidenceId: "evidence-structure",
        contentDigest: D("d"),
        format: "xyz",
        atomCount: 1,
        charge: 0,
        multiplicity: 1,
      },
    },
    acceptanceCriteria: [
      {
        id: "criterion-normal",
        kind: "normal_termination",
        description: "Execution terminates normally",
        required: true,
      },
    ],
  } as unknown as ScientificMission;
  assessments: ScientificAssessment[] = [];
  createdValidations: ValidationResult[] = [];

  constructor(
    public workUnit: WorkUnit,
    public evidence: EvidenceReference[],
    public observations: ScientificObservation[],
    public validations: ValidationResult[],
  ) {}

  async getMission(): Promise<ScientificMission> {
    return this.mission;
  }

  async transitionMission(input: { to: ScientificMission["state"]; at: string }) {
    this.mission = { ...this.mission, state: input.to, updatedAt: input.at };
    return this.mission;
  }

  async getWorkUnit(): Promise<WorkUnit> {
    return this.workUnit;
  }

  async getMissionProvenance(): Promise<MissionProvenance> {
    return {
      mission: this.mission,
      plans: [
        {
          id: "plan-internal",
          version: 1,
          limitations: ["Bounded fixture plan"],
          protocol: {
            schemaVersion: "1.0.0",
            compilerVersion: "1.0.0",
            acceptanceCriteria: ["criterion-normal"],
          },
          skillResolution: { selectedFragments: [fragment] },
        },
      ],
      decisions: [],
      evidence: [...this.evidence],
      observations: [...this.observations],
      validations: [...this.validations, ...this.createdValidations],
      assessments: [...this.assessments],
    } as unknown as MissionProvenance;
  }

  async createValidationResult(input: ValidationResult): Promise<ValidationResult> {
    const result = ValidationResultSchema.parse(input);
    this.createdValidations.push(result);
    return result;
  }

  async createAssessment(input: ScientificAssessment): Promise<ScientificAssessment> {
    const assessment = ScientificAssessmentSchema.parse(input);
    const existing = this.assessments.find((candidate) => candidate.id === assessment.id);
    if (existing) return existing;
    this.assessments.push(assessment);
    return assessment;
  }
}

class InternalPersistence implements ScientificInternalWorkUnitPersistence {
  outcomes: Array<"succeeded" | "failed"> = [];

  constructor(private readonly store: InternalStore) {}

  async settleInternalWorkUnit(input: { outcome: "succeeded" | "failed"; at: string }) {
    this.outcomes.push(input.outcome);
    this.store.workUnit = WorkUnitSchema.parse({
      ...this.store.workUnit,
      state: input.outcome === "succeeded" ? "succeeded" : "failed",
      revision: this.store.workUnit.revision + 1,
      claimOwner: null,
      claimExpiresAt: null,
      updatedAt: input.at,
    });
    return {
      workUnit: this.store.workUnit,
      transitionedThrough: [this.store.workUnit.state],
      alreadySettled: false,
    };
  }
}

const externalDriver = {
  async executeClaimedWorkUnit() {
    throw new Error("external execution is not used");
  },
  async reconcileOperation() {
    throw new Error("external reconciliation is not used");
  },
} as unknown as ScientificMissionWorkDriver;

function routerFor(store: InternalStore): {
  router: ScientificMissionDriverRouter;
  persistence: InternalPersistence;
} {
  const persistence = new InternalPersistence(store);
  return {
    router: new ScientificMissionDriverRouter({
      store: store as unknown as ScientificStore,
      persistence,
      externalDriver,
    }),
    persistence,
  };
}

async function execute(store: InternalStore, router: ScientificMissionDriverRouter) {
  return router.executeClaimedWorkUnit(store.workUnit, {
    ownerId: "head-internal",
    claimOwner: "head-internal",
    now: T1,
  });
}

describe("ScientificMissionDriverRouter provenance contracts", () => {
  test("keeps system preparation on its dedicated gateway and fails closed without it", async () => {
    const store = new InternalStore(systemPreparationWorkUnit(), [], [], []);
    let externalCalls = 0;
    const router = new ScientificMissionDriverRouter({
      store: store as unknown as ScientificStore,
      persistence: new InternalPersistence(store),
      externalDriver: {
        async executeClaimedWorkUnit() {
          externalCalls += 1;
          throw new Error("system preparation must not fall through to generic execution");
        },
        async reconcileOperation() {
          externalCalls += 1;
          throw new Error("system preparation must not fall through to generic reconciliation");
        },
      },
    });

    await expect(execute(store, router)).resolves.toMatchObject({
      status: "waiting",
      detail: expect.stringContaining("gateway is not configured"),
    });
    expect(externalCalls).toBe(0);
    expect(store.workUnit.state).toBe("claimed");
  });

  test("delegates system-build execution and recovery only to the dedicated driver", async () => {
    const store = new InternalStore(systemPreparationWorkUnit(), [], [], []);
    const calls: string[] = [];
    const router = new ScientificMissionDriverRouter({
      store: store as unknown as ScientificStore,
      persistence: new InternalPersistence(store),
      externalDriver: {
        async executeClaimedWorkUnit() {
          throw new Error("system preparation must not use the generic driver");
        },
        async reconcileOperation() {
          throw new Error("system preparation must not use generic recovery");
        },
      },
      systemPreparationDriver: {
        async executeClaimedWorkUnit(workUnit: WorkUnit) {
          calls.push(`execute:${workUnit.id}`);
          return { status: "waiting", workUnitId: workUnit.id, detail: "typed site gateway" };
        },
        async reconcileOperation(operation: ExternalOperation) {
          calls.push(`reconcile:${operation.id}`);
          return { status: "waiting", operationId: operation.id, detail: "typed site observer" };
        },
      } as unknown as ScientificMissionWorkDriver,
    });

    await expect(execute(store, router)).resolves.toMatchObject({ status: "waiting" });
    await expect(
      router.reconcileOperation(
        {
          id: "operation-system-preparation",
          missionId: store.mission.id,
          workUnitId: store.workUnit.id,
          kind: "system_preparation",
        } as never,
        { ownerId: "head-internal", now: T1 },
      ),
    ).resolves.toMatchObject({ status: "waiting", operationId: "operation-system-preparation" });
    expect(calls).toEqual([
      "execute:work-system-preparation",
      "reconcile:operation-system-preparation",
    ]);
  });

  test("routes only the versioned Amber MD capability to the external canonical driver", async () => {
    const base = internalWorkUnit("validation");
    const mdWorkUnit = {
      ...base,
      id: "work-md-router",
      kind: "scientific_capability",
      protocolFragment: {
        schemaVersion: "eigengrid.scientific-capability-fragment/v1",
        id: "fragment-md-router",
        kind: "scientific_capability",
        capability: {
          id: "amber.production-md",
          version: "1.0.0",
          contractDigest: D("e"),
        },
        reason: "Route the exact MD capability",
        parameters: { schemaVersion: MdExecutionBindingParametersSchemaVersion },
        sourceFragments: [fragment],
        riskClass: 3,
      },
      executionPolicy: { capability: "amber.production-md", riskClass: 3 },
    } as unknown as WorkUnit;
    const store = new InternalStore(mdWorkUnit, [], [], []);
    let externalCalls = 0;
    const router = new ScientificMissionDriverRouter({
      store: store as unknown as ScientificStore,
      persistence: new InternalPersistence(store),
      externalDriver: {
        async executeClaimedWorkUnit(workUnit) {
          externalCalls += 1;
          return { status: "waiting", workUnitId: workUnit.id, detail: "MD gateway is closed" };
        },
        async reconcileOperation() {
          throw new Error("not used");
        },
      },
    });

    await expect(execute(store, router)).resolves.toMatchObject({ status: "waiting" });
    expect(externalCalls).toBe(1);

    const untypedCapability = {
      ...mdWorkUnit,
      id: "work-untyped-capability",
      protocolFragment: {
        ...mdWorkUnit.protocolFragment,
        parameters: { schemaVersion: "unrecognized-contract" },
      },
    } as WorkUnit;
    store.workUnit = untypedCapability;
    const rejected = await execute(store, router);
    expect(rejected).toMatchObject({ status: "failed", retryable: false });
    expect(externalCalls).toBe(1);
  });

  test("fails validation closed when selected skill evidence is missing", async () => {
    const store = new InternalStore(
      internalWorkUnit("validation"),
      [parserEvidence()],
      [parserObservation("parser-bridge/1")],
      [],
    );
    const { router, persistence } = routerFor(store);

    const result = await execute(store, router);

    expect(result).toMatchObject({ status: "failed", retryable: false });
    expect(result.detail).toContain("evidence: skill_fragment");
    expect(store.createdValidations).toHaveLength(0);
    expect(persistence.outcomes).toEqual(["failed"]);
  });

  test("fails assessment closed for unversioned parser observations", async () => {
    const store = new InternalStore(
      internalWorkUnit("assessment"),
      [parserEvidence(), skillEvidence()],
      [parserObservation()],
      [validationResult()],
    );
    const { router, persistence } = routerFor(store);

    const result = await execute(store, router);

    expect(result).toMatchObject({ status: "failed", retryable: false });
    expect(result.detail).toContain("without parserVersion");
    expect(store.assessments).toHaveLength(0);
    expect(store.mission.state).toBe("validating");
    expect(persistence.outcomes).toEqual(["failed"]);
  });

  test("fails assessment closed when a required observation is absent", async () => {
    const store = new InternalStore(
      internalWorkUnit("assessment"),
      [parserEvidence(), skillEvidence()],
      [],
      [validationResult()],
    );
    const { router, persistence } = routerFor(store);

    const result = await execute(store, router);

    expect(result).toMatchObject({ status: "failed", retryable: false });
    expect(result.detail).toContain("observations: normal_termination");
    expect(store.assessments).toHaveLength(0);
    expect(store.mission.state).toBe("validating");
    expect(persistence.outcomes).toEqual(["failed"]);
  });

  test("fails assessment closed when a required criterion has no validation result", async () => {
    const store = new InternalStore(
      internalWorkUnit("assessment"),
      [parserEvidence(), skillEvidence()],
      [parserObservation("parser-bridge/1")],
      [validationResult()],
    );
    store.mission = {
      ...store.mission,
      acceptanceCriteria: [
        ...store.mission.acceptanceCriteria,
        {
          id: "criterion-required-missing",
          kind: "electronic_convergence",
          description: "Electronic convergence must have a durable validation result",
          required: true,
        },
      ],
    } as ScientificMission;
    const { router, persistence } = routerFor(store);

    const result = await execute(store, router);

    expect(result).toMatchObject({ status: "failed", retryable: false });
    expect(result.detail).toContain("criterion-required-missing");
    expect(store.assessments).toHaveLength(0);
    expect(persistence.outcomes).toEqual(["failed"]);
  });

  test("binds cited parserVersion into assessment identity", async () => {
    const firstStore = new InternalStore(
      internalWorkUnit("assessment"),
      [parserEvidence(), skillEvidence()],
      [parserObservation("parser-bridge/1")],
      [validationResult()],
    );
    const secondStore = new InternalStore(
      internalWorkUnit("assessment"),
      [parserEvidence(), skillEvidence()],
      [parserObservation("parser-bridge/2")],
      [validationResult()],
    );

    expect(await execute(firstStore, routerFor(firstStore).router)).toMatchObject({
      status: "completed",
    });
    expect(await execute(secondStore, routerFor(secondStore).router)).toMatchObject({
      status: "completed",
    });

    expect(firstStore.assessments[0]?.parserVersion).toBe("parser-bridge/1");
    expect(secondStore.assessments[0]?.parserVersion).toBe("parser-bridge/2");
    expect(firstStore.assessments[0]?.id).not.toBe(secondStore.assessments[0]?.id);
  });
});
