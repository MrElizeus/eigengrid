import { describe, expect, test } from "bun:test";
import {
  EvidenceReferenceSchema,
  ScientificObservationSchema,
  WorkUnitSchema,
  digestCanonical,
  type EvidenceReference,
  type ScientificObservation,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import type { MissionProvenance, ScientificStore } from "@eigengrid/mission-runtime";
import type { ExecutionService } from "./execution-coordinator";
import {
  CanonicalScientificPostprocessor,
  type ScientificExternalPostprocessingContext,
} from "./scientific-postprocessor";
import type {
  ScientificExecutionInspector,
  ScientificExecutionSnapshot,
} from "./scientific-execution-inspector";

const T0 = "2026-08-06T00:00:00.000Z";
const T1 = "2026-08-06T00:01:00.000Z";
const D = (character: string): string => character.repeat(64);

const fragment = {
  skillId: "methods.fixture",
  version: "1.0.0",
  contentDigest: D("a"),
  fragmentId: "fixture.execute",
  fragmentDigest: D("b"),
  relativePath: "protocols/fixture.yaml",
  selector: "$",
};

function observingWorkUnit(requiredEvidenceKinds: string[]): WorkUnit {
  return WorkUnitSchema.parse({
    id: "work-postprocess",
    missionId: "mission-postprocess",
    planId: "plan-postprocess",
    planVersion: 1,
    kind: "optimization",
    state: "observing",
    reason: "Postprocess exact fixture output",
    dependencies: [],
    inputRefs: ["evidence-structure"],
    outputContract: {
      requiredEvidenceKinds,
      requiredObservationKinds: ["normal_termination"],
    },
    skillRefs: [fragment],
    protocolFragment: {
      id: "fragment-postprocess",
      kind: "optimization",
      reason: "Postprocess exact fixture output",
      parameters: {},
      sourceFragments: [fragment],
      riskClass: 1,
    },
    retryPolicy: { maximumAttempts: 1, ambiguityRequiresReconciliation: true },
    approvalPolicy: { required: true, minimumRole: "scientific_reviewer" },
    executionPolicy: { capability: "fixture.execute", riskClass: 1 },
    revision: 5,
    claimOwner: "head-postprocess",
    claimExpiresAt: T1,
    jobId: "job-postprocess",
    attemptId: "attempt-postprocess",
    createdAt: T0,
    updatedAt: T0,
  });
}

function initialEvidence(workUnit: WorkUnit): EvidenceReference[] {
  return [
    EvidenceReferenceSchema.parse({
      id: "evidence-rendered-input",
      missionId: workUnit.missionId,
      workUnitId: workUnit.id,
      kind: "rendered_input",
      uri: "eigengrid-rendered-input://evidence-structure",
      contentDigest: D("c"),
      immutable: true,
      sourceId: "evidence-structure",
      createdAt: T0,
    }),
    EvidenceReferenceSchema.parse({
      id: "evidence-operation-receipt",
      missionId: workUnit.missionId,
      workUnitId: workUnit.id,
      kind: "operation_receipt",
      uri: "eigengrid-operation-receipt://receipt-postprocess",
      contentDigest: D("d"),
      immutable: true,
      sourceId: "operation-postprocess",
      createdAt: T0,
    }),
  ];
}

class PostprocessorStore {
  evidence: EvidenceReference[];
  observations: ScientificObservation[] = [];

  constructor(public workUnit: WorkUnit) {
    this.evidence = initialEvidence(workUnit);
  }

  async getWorkUnit(): Promise<WorkUnit> {
    return this.workUnit;
  }

  async createEvidence(input: EvidenceReference): Promise<EvidenceReference> {
    const reference = EvidenceReferenceSchema.parse(input);
    const existing = this.evidence.find((candidate) => candidate.id === reference.id);
    if (existing) {
      if (digestCanonical(existing) !== digestCanonical(reference)) {
        throw new Error(`Conflicting evidence payload for ${reference.id}`);
      }
      return existing;
    }
    this.evidence.push(reference);
    return reference;
  }

  async createObservation(input: ScientificObservation): Promise<ScientificObservation> {
    const observation = ScientificObservationSchema.parse(input);
    const existing = this.observations.find((candidate) => candidate.id === observation.id);
    if (existing) {
      if (digestCanonical(existing) !== digestCanonical(observation)) {
        throw new Error(`Conflicting observation payload for ${observation.id}`);
      }
      return existing;
    }
    this.observations.push(observation);
    return observation;
  }

  async getMissionProvenance(): Promise<MissionProvenance> {
    return {
      evidence: [...this.evidence],
      observations: [...this.observations],
    } as unknown as MissionProvenance;
  }

  async transitionWorkUnit(input: {
    expectedRevision: number;
    to: "succeeded" | "failed";
    at: string;
  }): Promise<WorkUnit> {
    if (input.expectedRevision !== this.workUnit.revision) throw new Error("revision conflict");
    this.workUnit = WorkUnitSchema.parse({
      ...this.workUnit,
      state: input.to,
      revision: this.workUnit.revision + 1,
      claimOwner: null,
      claimExpiresAt: null,
      updatedAt: input.at,
    });
    return this.workUnit;
  }
}

function snapshots(): {
  collected: ScientificExecutionSnapshot;
  parsed: ScientificExecutionSnapshot;
} {
  const createdAt = Date.parse(T0);
  const base = {
    job: {
      id: "job-postprocess",
      name: "postprocess",
      software: "fixture",
      inputPath: "/tmp/input.xyz",
      workdir: "/tmp",
      outputPath: "/tmp/output.out",
      nodeId: null,
      status: "parsed",
      ownerUserId: null,
      projectId: null,
      backend: "local",
      externalJobId: null,
      externalState: null,
      lastSyncAt: null,
      nativeDetail: null,
      nodeName: null,
      cpuThreads: 1,
      memoryMb: 256,
      scratchMb: 0,
      priority: "normal",
      jobFamily: null,
      createdAt,
      updatedAt: createdAt,
    },
    attempt: {
      id: "attempt-postprocess",
      jobId: "job-postprocess",
      runner: "local" as const,
      status: "completed" as const,
      command: "fixture",
      cwd: "/tmp",
      exitCode: 0,
      createdAt,
      updatedAt: createdAt,
    },
    artifacts: [
      {
        artifact: {
          id: "artifact-output",
          jobId: "job-postprocess",
          attemptId: "attempt-postprocess",
          kind: "output" as const,
          path: "/tmp/output.out",
          mimeType: "text/plain",
          sizeBytes: 42,
          createdAt,
        },
        canonicalPath: "/tmp/output.out",
        contentDigest: D("e"),
        actualSizeBytes: 42,
        integrity: { status: "verified" as const },
      },
    ],
  };
  return {
    collected: base,
    parsed: {
      ...base,
      result: {
        record: {
          id: "result-postprocess",
          jobId: "job-postprocess",
          attemptId: "attempt-postprocess",
          parser: "fixture-parser",
          status: "completed",
          energyHartree: -1,
          scfConverged: true,
          imaginaryFrequencies: 0,
          normalTermination: true,
          warnings: [],
          errors: [],
          raw: { raw: { geometryConverged: true } },
          createdAt,
        },
        contentDigest: D("f"),
      },
    },
  };
}

function postprocessorHarness(
  parserVersion: string,
  requiredEvidenceKinds: string[],
): {
  store: PostprocessorStore;
  postprocessor: CanonicalScientificPostprocessor;
  context: ScientificExternalPostprocessingContext;
} {
  const workUnit = observingWorkUnit(requiredEvidenceKinds);
  const store = new PostprocessorStore(workUnit);
  const { collected, parsed } = snapshots();
  let inspections = 0;
  const inspector: ScientificExecutionInspector = {
    async inspect() {
      inspections += 1;
      return inspections === 1 ? collected : parsed;
    },
  };
  const execution = {
    async collectLocal() {
      return {
        ok: true,
        jobId: "job-postprocess",
        attemptId: "attempt-postprocess",
        artifacts: ["/tmp/output.out"],
        message: "collected",
      } as const;
    },
    async parseJob() {
      return {
        ok: true,
        jobId: "job-postprocess",
        attemptId: "attempt-postprocess",
        resultId: "result-postprocess",
        parser: "fixture-parser",
        message: "parsed",
      } as const;
    },
  } as unknown as ExecutionService;
  return {
    store,
    postprocessor: new CanonicalScientificPostprocessor({
      store: store as unknown as ScientificStore,
      execution,
      inspector,
      parserVersion,
    }),
    context: { ownerId: "head-postprocess", now: T1 },
  };
}

describe("CanonicalScientificPostprocessor provenance contracts", () => {
  test("fails closed when a required evidence kind was not persisted", async () => {
    const harness = postprocessorHarness("parser-bridge/1", [
      "rendered_input",
      "operation_receipt",
      "artifact",
      "parser_output",
      "human_review",
    ]);

    const result = await harness.postprocessor.continueExternalWorkUnit(
      harness.store.workUnit,
      harness.context,
    );

    expect(result).toMatchObject({ status: "failed", retryable: false });
    expect(result.detail).toContain("evidence: human_review");
    expect(harness.store.workUnit.state).toBe("failed");
  });

  test("binds parserVersion into evidence and observation identity and remains idempotent", async () => {
    const required = ["rendered_input", "operation_receipt", "artifact", "parser_output"];
    const first = postprocessorHarness("parser-bridge/1", required);
    const second = postprocessorHarness("parser-bridge/2", required);

    expect(
      await first.postprocessor.continueExternalWorkUnit(first.store.workUnit, first.context),
    ).toMatchObject({ status: "completed" });
    expect(
      await second.postprocessor.continueExternalWorkUnit(second.store.workUnit, second.context),
    ).toMatchObject({ status: "completed" });

    const firstParserEvidence = first.store.evidence.find(
      (reference) => reference.kind === "parser_output",
    );
    const secondParserEvidence = second.store.evidence.find(
      (reference) => reference.kind === "parser_output",
    );
    const firstObservation = first.store.observations.find(
      (observation) => observation.type === "normal_termination",
    );
    const secondObservation = second.store.observations.find(
      (observation) => observation.type === "normal_termination",
    );
    expect(firstParserEvidence?.id).not.toBe(secondParserEvidence?.id);
    expect(firstParserEvidence?.contentDigest).not.toBe(secondParserEvidence?.contentDigest);
    expect(firstObservation?.id).not.toBe(secondObservation?.id);
    expect(firstObservation?.payload.parserVersion).toBe("parser-bridge/1");
    expect(secondObservation?.payload.parserVersion).toBe("parser-bridge/2");

    const stableCounts = {
      evidence: first.store.evidence.length,
      observations: first.store.observations.length,
    };
    expect(
      await first.postprocessor.continueExternalWorkUnit(first.store.workUnit, first.context),
    ).toMatchObject({ status: "completed" });
    expect(first.store.evidence).toHaveLength(stableCounts.evidence);
    expect(first.store.observations).toHaveLength(stableCounts.observations);
  });

  test("rejects an empty parserVersion before postprocessing", () => {
    expect(() => postprocessorHarness("", ["parser_output"])).toThrow("parserVersion");
  });
});
