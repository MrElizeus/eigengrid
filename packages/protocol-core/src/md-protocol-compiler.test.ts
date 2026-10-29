import { describe, expect, test } from "bun:test";
import {
  computeMdReplicaSetDigest,
  computeMdReplicaSeedPolicyDigest,
  computeMdStageAssessmentDigest,
  computeMdStageResultDigest,
  computeMdWorkflowProtocolDigest,
  digestCanonical,
} from "@eigengrid/scientific-schema";
import {
  MdProtocolCompilationError,
  compileMdNextStage,
  compileMdProductionSegment,
  compileMdWorkflowProtocol,
  computeMdEnvironmentDigest,
  type MdProtocolCompilationErrorCode,
} from "./md-protocol-compiler";

import {
  approval,
  makeInput,
  makeNextStageInput,
  makeProductionInput,
  withLegacyDraftSystem,
} from "./md-fixtures";
const timestamp = "2026-08-23T12:00:00.000Z";
const digest = (value: string): string => value.repeat(64);

function expectCompilerError(action: () => unknown, code: MdProtocolCompilationErrorCode): void {
  try {
    action();
    throw new Error("Expected compilation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(MdProtocolCompilationError);
    expect((error as MdProtocolCompilationError).code).toBe(code);
  }
}

describe("MD protocol compiler", () => {
  test("technical policy handoff preserves exact historical decisions and current execution approval", () => {
    const input = { ...makeInput() };
    const sourcePolicy = digest("9");
    input.decisionApprovals = input.decisionApprovals.map((item) =>
      approval({
        id: item.id,
        subjectType: item.subjectType,
        subjectId: item.subjectId,
        subjectVersion: item.subjectVersion,
        subjectRevision: item.subjectRevision,
        payloadDigest: item.payloadDigest,
        policyDigest: sourcePolicy,
      }),
    );
    const protocolBase = {
      ...input.protocol,
      purpose: "technical_pilot" as const,
      preparationPolicyDigest: sourcePolicy,
      stages: input.protocol.stages.filter((stage) => stage.kind !== "production"),
    };
    input.protocol = {
      ...protocolBase,
      protocolDigest: computeMdWorkflowProtocolDigest(protocolBase),
    };
    input.stageSkillBindings = input.stageSkillBindings.filter((binding) =>
      input.protocol.stages.some((stage) => stage.id === binding.stageId),
    );
    const ratify = () => {
      input.protocol.protocolDigest = computeMdWorkflowProtocolDigest(input.protocol);
      input.protocolApproval = approval({
        id: input.protocol.approvedByRef!,
        subjectType: "md_protocol",
        subjectId: input.protocol.id,
        subjectVersion: input.protocol.revision,
        subjectRevision: input.protocol.revision,
        payloadDigest: input.protocol.protocolDigest,
        policyDigest: input.policy.policyDigest,
      });
    };
    ratify();
    expect(compileMdWorkflowProtocol(input).workUnits).toHaveLength(1);
    input.protocol.preparationPolicyDigest = digest("8");
    expect(() => compileMdWorkflowProtocol(input)).toThrow(); // unreviewed change
    ratify();
    expect(() => compileMdWorkflowProtocol(input)).toThrow(); // wrong source policy
    input.protocol.preparationPolicyDigest = sourcePolicy;
    ratify();
    input.planApproval.policyDigest = sourcePolicy;
    expect(() => compileMdWorkflowProtocol(input)).toThrow(); // cannot inherit execution policy
  });
  test("compiles an exact approved technical continuation without declaring production", () => {
    const input = { ...makeNextStageInput() };
    const protocolBase = {
      ...input.protocol,
      purpose: "technical_pilot" as const,
      stages: input.protocol.stages.slice(0, 2),
    };
    input.protocol = {
      ...protocolBase,
      protocolDigest: computeMdWorkflowProtocolDigest(protocolBase),
    };
    input.protocolApproval = approval({
      id: input.protocol.approvedByRef!,
      subjectType: "md_protocol",
      subjectId: input.protocol.id,
      subjectVersion: input.protocol.revision,
      subjectRevision: input.protocol.revision,
      payloadDigest: input.protocol.protocolDigest,
      policyDigest: input.policy.policyDigest,
    });
    input.stageSkillBindings = input.stageSkillBindings.slice(0, 2);
    input.parentStageResult = {
      ...input.parentStageResult,
      protocolDigest: input.protocol.protocolDigest,
    };
    input.parentStageResult.resultDigest = computeMdStageResultDigest(input.parentStageResult);
    input.parentStageAssessment = {
      ...input.parentStageAssessment,
      stageResultDigest: input.parentStageResult.resultDigest,
    };
    input.parentStageAssessment.assessmentDigest = computeMdStageAssessmentDigest(
      input.parentStageAssessment,
    );
    const compiled = compileMdWorkflowProtocol(input);
    expect(compiled.deferredProductionStages).toHaveLength(0);
    expect(compiled.deferredStages[0]!.kind).toBe("equilibration");
    expect(compileMdNextStage(input).workUnit.dependencies).toEqual([
      input.parentStageResult.workUnitId,
    ]);
  });

  test("reviewed technical engine admission cannot follow a different binary or environment", () => {
    const input = { ...makeInput() };
    const admission = {
      schemaVersion: "eigengrid.md-force-field-engine-admission/v1" as const,
      missionId: input.protocol.missionId,
      scope: "provisional_technical_pilot" as const,
      system: input.protocol.system,
      forceFieldStack: input.protocol.forceFieldStack,
      parameterDigests: [digest("a")],
      targetEngine: input.protocol.targetEngine,
      engine: input.environment.engine,
      sourceEvidence: [
        {
          evidenceRef: "engine-observation",
          contentDigest: digest("b"),
          kind: "environment" as const,
        },
        {
          evidenceRef: "renderer-evidence",
          contentDigest: digest("c"),
          kind: "source_snapshot" as const,
        },
      ],
      rationale: "Synthetic compiler fixture",
      limitations: ["Not execution or qualification evidence"],
      createdAt: timestamp,
    };
    const protocolBase = {
      ...input.protocol,
      purpose: "technical_pilot" as const,
      stages: input.protocol.stages.slice(0, 1),
      forceFieldEngineAdmission: {
        evidenceRef: "engine-admission",
        contentDigest: digestCanonical(admission),
        admission,
      },
    };
    input.protocol = {
      ...protocolBase,
      protocolDigest: computeMdWorkflowProtocolDigest(protocolBase),
    };
    input.protocolApproval = approval({
      id: input.protocol.approvedByRef!,
      subjectType: "md_protocol",
      subjectId: input.protocol.id,
      subjectVersion: input.protocol.revision,
      subjectRevision: input.protocol.revision,
      payloadDigest: input.protocol.protocolDigest,
      policyDigest: input.policy.policyDigest,
    });
    input.stageSkillBindings = input.stageSkillBindings.slice(0, 1);
    expect(compileMdWorkflowProtocol(input).workUnits).toHaveLength(1);
    for (const engine of [
      { ...admission.engine, buildDigest: digest("1") },
      { ...admission.engine, environmentDigest: digest("2") },
    ]) {
      const changed = structuredClone(input);
      const next = { ...admission, engine };
      changed.protocol.forceFieldEngineAdmission = {
        evidenceRef: "engine-admission",
        contentDigest: digestCanonical(next),
        admission: next,
      };
      changed.protocol.protocolDigest = computeMdWorkflowProtocolDigest(changed.protocol);
      changed.protocolApproval = approval({
        id: changed.protocol.approvedByRef!,
        subjectType: "md_protocol",
        subjectId: changed.protocol.id,
        subjectVersion: changed.protocol.revision,
        subjectRevision: changed.protocol.revision,
        payloadDigest: changed.protocol.protocolDigest,
        policyDigest: changed.policy.policyDigest,
      });
      expectCompilerError(() => compileMdWorkflowProtocol(changed), "ENGINE_INCOMPATIBLE");
    }
  });

  test("rejects draft manifest v1 at every WorkUnit compilation entry point", () => {
    expectCompilerError(
      () => compileMdWorkflowProtocol(withLegacyDraftSystem(makeInput())),
      "INVALID_INPUT",
    );
    expectCompilerError(
      () => compileMdNextStage(withLegacyDraftSystem(makeNextStageInput())),
      "INVALID_INPUT",
    );
    expectCompilerError(
      () => compileMdProductionSegment(withLegacyDraftSystem(makeProductionInput())),
      "INVALID_INPUT",
    );
  });

  test("compiles pre-production stages and defers production until an approved replica set", () => {
    const input = makeInput();
    const first = compileMdWorkflowProtocol(input);
    const second = compileMdWorkflowProtocol(structuredClone(input));

    expect(first).toEqual(second);
    expect(first.workUnits).toHaveLength(1);
    const workUnit = first.workUnits[0]!;
    expect(workUnit.kind).toBe("scientific_capability");
    expect(workUnit.executionPolicy.capability).toBe("amber.membrane-equilibration");
    expect(workUnit.approvalPolicy).toEqual({
      required: true,
      minimumRole: "scientific_reviewer",
    });
    expect(workUnit.protocolFragment.kind).toBe("scientific_capability");
    expect(workUnit.protocolFragment.parameters.schemaVersion).toBe(
      "eigengrid.md-execution-binding/v2",
    );
    expect(workUnit.protocolFragment.parameters.decisions).toEqual(input.decisionRefs);
    expect(workUnit.outputContract.requiredEvidenceKinds).toEqual(["mdinfo", "mdout", "restart"]);
    expect(first.deferredProductionStages).toHaveLength(1);
    expect(first.deferredProductionStages[0]).toMatchObject({
      stageId: "stage-production-1",
      capability: { id: "amber.production-md" },
    });
    expect(JSON.stringify(first)).not.toMatch(/(?:shell|argv|executable|sbatch|ssh)/iu);
  });

  test("compiles one deterministic WorkUnit per approved replica segment", () => {
    const input = makeProductionInput();
    const first = compileMdProductionSegment(input);
    const second = compileMdProductionSegment(structuredClone(input));

    expect(first).toEqual(second);
    expect(first.workUnit.executionPolicy.capability).toBe("amber.production-md");
    expect(first.workUnit.dependencies).toEqual([input.parentStageResult.workUnitId]);
    expect(first.dependency).toEqual({
      workUnitId: first.workUnit.id,
      dependsOnWorkUnitId: input.parentStageResult.workUnitId,
    });
    expect(first.workUnit.protocolFragment.parameters.replicaSegment).toEqual({
      replicaSetId: input.replicaSet.id,
      replicaSetRevision: input.replicaSet.revision,
      replicaSetDigest: computeMdReplicaSetDigest(input.replicaSet),
      replicaId: "replica-1",
      replicaIndex: 1,
      replicaSeed: 771_001,
      segmentIndex: 0,
      segmentSeed: 771_001,
    });
    expect(first.workUnit.protocolFragment.parameters.parentRestart).toEqual(
      input.replicaSet.replicas[0]!.initialRestart,
    );
  });

  test("binds a distinct approved continuation seed and rejects unapproved extension or seed edits", () => {
    const input = makeProductionInput();
    const first = compileMdProductionSegment(input);
    const stage = input.protocol.stages[1]!;
    const resultBase = {
      ...input.parentStageResult,
      id: "fixture-result-segment-0",
      workUnitId: first.workUnit.id,
      stageId: stage.id,
      stageRevision: stage.revision,
      stageDigest: stage.stageDigest,
      stageKind: "production" as const,
      replicaSetId: input.replicaSet.id,
      replicaSetRevision: input.replicaSet.revision,
      replicaSetDigest: computeMdReplicaSetDigest(input.replicaSet),
      replicaId: input.replicaId,
      segmentIndex: 0,
      parentRestartDigest: input.replicaSet.replicas[0]!.initialRestart.contentDigest,
      artifacts: [
        ...input.parentStageResult.artifacts,
        {
          artifactId: "fixture-trajectory-0",
          evidenceRef: "fixture-trajectory-evidence-0",
          role: "trajectory" as const,
          contentDigest: digest("8"),
          mediaType: "application/x-netcdf",
        },
      ],
    };
    const result = { ...resultBase, resultDigest: computeMdStageResultDigest(resultBase) };
    const assessmentBase = {
      ...input.parentStageAssessment,
      id: "fixture-assessment-segment-0",
      stageResultId: result.id,
      stageResultDigest: result.resultDigest,
    };
    const assessment = {
      ...assessmentBase,
      assessmentDigest: computeMdStageAssessmentDigest(assessmentBase),
    };
    const continuationInput = {
      ...input,
      segmentIndex: 1,
      parentStageResult: result,
      parentStageAssessment: assessment,
    };
    const continuation = compileMdProductionSegment(continuationInput);
    expect(continuation.workUnit.id).not.toBe(first.workUnit.id);
    expect(continuation.workUnit.protocolFragment.parameters.replicaSegment).toMatchObject({
      replicaSeed: 771_001,
      segmentIndex: 1,
      segmentSeed: 771_002,
    });
    expect(compileMdProductionSegment(structuredClone(continuationInput))).toEqual(continuation);
    expectCompilerError(
      () => compileMdProductionSegment({ ...continuationInput, segmentIndex: 2 }),
      "REPLICA_SET_MISMATCH",
    );
    const altered = makeProductionInput();
    altered.replicaSet.replicas[0]!.segmentSeeds![1] = 771_003;
    altered.replicaSet.seedPolicyDigest = computeMdReplicaSeedPolicyDigest(
      altered.replicaSet.replicas,
    );
    expectCompilerError(() => compileMdProductionSegment(altered), "APPROVAL_MISMATCH");
  });

  test("materializes a downstream stage only from its exact accepted parent result", () => {
    const input = makeNextStageInput();
    const initial = compileMdWorkflowProtocol(input);
    const first = compileMdNextStage(input);
    const second = compileMdNextStage(structuredClone(input));

    expect(first).toEqual(second);
    expect(initial.workUnits).toHaveLength(1);
    expect(initial.deferredStages).toHaveLength(2);
    expect(first.workUnit.dependencies).toEqual([input.parentStageResult.workUnitId]);
    expect(first.workUnit.protocolFragment.parameters.parentRestart).toEqual(
      input.parentStageResult.artifacts.find((artifact) => artifact.role === "restart"),
    );
    expect(first.parentResultDigest).toBe(input.parentStageResult.resultDigest);
    expect(first.parentAssessmentDigest).toBe(input.parentStageAssessment.assessmentDigest);

    const changedAssessmentBase = {
      ...input.parentStageAssessment,
      evaluations: input.parentStageAssessment.evaluations.map((evaluation) => ({
        ...evaluation,
        criterionDigest: digest("0"),
      })),
      assessmentDigest: digest("0"),
    };
    const changedAssessment = {
      ...changedAssessmentBase,
      assessmentDigest: computeMdStageAssessmentDigest(changedAssessmentBase),
    };
    expectCompilerError(
      () => compileMdNextStage({ ...input, parentStageAssessment: changedAssessment }),
      "STAGE_GATE_MISMATCH",
    );
  });

  test("rejects stale replica approval and an unbound parent restart", () => {
    const stale = makeProductionInput();
    stale.replicaSetApproval.payloadDigest = digest("0");
    expectCompilerError(() => compileMdProductionSegment(stale), "APPROVAL_MISMATCH");

    const mismatch = makeProductionInput();
    const changedResultBase = {
      ...mismatch.parentStageResult,
      artifacts: mismatch.parentStageResult.artifacts.map((artifact) =>
        artifact.role === "restart" ? { ...artifact, contentDigest: digest("0") } : artifact,
      ),
      resultDigest: digest("0"),
    };
    const changedResult = {
      ...changedResultBase,
      resultDigest: computeMdStageResultDigest(changedResultBase),
    };
    expectCompilerError(
      () => compileMdProductionSegment({ ...mismatch, parentStageResult: changedResult }),
      "STAGE_GATE_MISMATCH",
    );
  });

  test("rejects a material protocol mutation even when lifecycle approval still says approved", () => {
    const input = makeInput();
    input.protocol.assumptions.push("unreviewed mutation");
    expectCompilerError(() => compileMdWorkflowProtocol(input), "DIGEST_MISMATCH");
  });

  test("rejects stale subject revision, digest, response, and protocol approval identity", () => {
    const stale = makeInput();
    stale.protocolApproval.subjectRevision += 1;
    expectCompilerError(() => compileMdWorkflowProtocol(stale), "APPROVAL_MISMATCH");

    const responseMismatch = makeInput();
    responseMismatch.systemApproval.response!.payloadDigest = digest("0");
    expectCompilerError(() => compileMdWorkflowProtocol(responseMismatch), "APPROVAL_MISMATCH");

    const wrongApproval = makeInput();
    wrongApproval.protocolApproval.id = "approval-protocol-other";
    wrongApproval.protocolApproval.response!.approvalRequestId = "approval-protocol-other";
    expectCompilerError(() => compileMdWorkflowProtocol(wrongApproval), "APPROVAL_MISMATCH");
  });

  test("rejects missing durable decision approval and non-identical decision references", () => {
    const missing = makeInput();
    expectCompilerError(
      () => compileMdWorkflowProtocol({ ...missing, decisionApprovals: [] }),
      "DECISION_MISMATCH",
    );

    const changed = makeInput();
    expectCompilerError(
      () =>
        compileMdWorkflowProtocol({
          ...changed,
          decisionRefs: [{ ...changed.decisionRefs[0]!, decisionDigest: digest("0") }],
        }),
      "DECISION_MISMATCH",
    );

    const extra = makeInput();
    const extraDecision = {
      id: "decision-not-in-system",
      revision: 1,
      kind: "other" as const,
      decisionDigest: digest("8"),
      approvalRef: "approval-extra-decision",
    };
    const extraApprovals = [
      ...extra.decisionApprovals,
      approval({
        id: extraDecision.approvalRef,
        subjectType: "decision",
        subjectId: extraDecision.id,
        subjectVersion: extraDecision.revision,
        subjectRevision: extraDecision.revision,
        payloadDigest: extraDecision.decisionDigest,
        policyDigest: extra.policy.policyDigest,
      }),
    ];
    expectCompilerError(
      () =>
        compileMdWorkflowProtocol({
          ...extra,
          decisionRefs: [...extra.decisionRefs, extraDecision],
          decisionApprovals: extraApprovals,
        }),
      "DECISION_MISMATCH",
    );
  });

  test("fails closed when exact capability or skill-fragment attribution is unavailable", () => {
    const capability = makeInput();
    const changedEnvironment = {
      ...capability.environment,
      capabilities: [{ ...capability.environment.capabilities[0]!, contractDigest: digest("0") }],
    };
    changedEnvironment.environmentDigest = computeMdEnvironmentDigest(changedEnvironment);
    expectCompilerError(
      () => compileMdWorkflowProtocol({ ...capability, environment: changedEnvironment }),
      "CAPABILITY_UNAVAILABLE",
    );

    const skill = makeInput();
    skill.stageSkillBindings[0]!.fragments[0]!.contentDigest = digest("0");
    expectCompilerError(() => compileMdWorkflowProtocol(skill), "SKILL_BINDING_MISMATCH");
  });

  test("rejects unverified engine compatibility and policy/environment digest drift", () => {
    const engine = makeInput();
    engine.environment.targetCompatibility.versionRange = ">=25";
    engine.environment.environmentDigest = computeMdEnvironmentDigest(engine.environment);
    expectCompilerError(() => compileMdWorkflowProtocol(engine), "ENGINE_INCOMPATIBLE");

    const policy = makeInput();
    policy.policy.retryPolicy.maximumAttempts = 3;
    expectCompilerError(() => compileMdWorkflowProtocol(policy), "POLICY_DIGEST_MISMATCH");

    const approvalPolicy = makeInput();
    approvalPolicy.protocolApproval.policyDigest = digest("0");
    approvalPolicy.protocolApproval.response!.policyDigest = digest("0");
    expectCompilerError(() => compileMdWorkflowProtocol(approvalPolicy), "APPROVAL_MISMATCH");

    const environment = makeInput();
    environment.environment.observedAt = "2026-08-23T13:00:00.000Z";
    expectCompilerError(
      () => compileMdWorkflowProtocol(environment),
      "ENVIRONMENT_DIGEST_MISMATCH",
    );
  });
});
