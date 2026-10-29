import { describe, expect, test } from "bun:test";
import {
  MdAssessmentSchemaVersion,
  MdStageResultSchemaVersion,
  computeMdStageSpecDigest,
  computeMdWorkflowProtocolDigest,
  computeMdStageResultDigest,
  computeMdStageAssessmentDigest,
  type MdStageSpec,
  type MdStageResult,
  type MdStageAssessment,
} from "@eigengrid/scientific-schema";
import {
  compileMdWorkflowProtocol,
  compileMdNextStage,
  compileMdProductionSegment,
  computeMdEnvironmentDigest,
} from "./md-protocol-compiler";
import { makeInput, makeProductionInput } from "./md-fixtures";

function fullWorkflow() {
  const input = { ...makeInput() },
    template = input.protocol.stages[0]!;
  const labels = ["M1", "M2", "M3", "H1", "E1", "E2", "E3", "E4", "P"];
  input.protocol.stages = labels.map((name, index) => {
    const stage: MdStageSpec = structuredClone(template);
    stage.id = `fixture-${name}`;
    stage.name = name;
    stage.sequence = index + 1;
    stage.parentStageId = index === 0 ? null : `fixture-${labels[index - 1]}`;
    stage.requiredParentOutputRole = index === 0 ? null : "restart";
    stage.inputs = template.inputs.filter(
      (artifact) => index === 0 || artifact.role !== "coordinates",
    );
    if (index < 3) {
      stage.kind = "minimization";
      stage.ensemble = "none";
      stage.timeStepPs = null;
      stage.simulatedTimePs = null;
      stage.temperature = null;
      stage.thermostat = { kind: "none" };
      stage.randomSeed = null;
      stage.minimization = {
        algorithm: "steepest_descent_then_conjugate_gradient",
        steepestDescentCycles: 500,
        rmsGradientToleranceKcalMolAngstrom: 0.1,
        initialStepAngstrom: 0.01,
      };
    } else if (name === "H1") {
      stage.kind = "heating";
      stage.temperature = {
        points: [
          { step: 0, kelvin: 10 },
          { step: stage.steps, kelvin: 310 },
        ],
      };
    } else if (name === "P") {
      stage.kind = "production";
      stage.randomSeed = { policy: "replica_segment", segmentCount: 2 };
      stage.outputs.push({
        role: "trajectory",
        required: true,
        mediaType: "application/x-netcdf",
        cadenceSteps: 100,
      });
    } else {
      stage.kind = "equilibration";
    }
    stage.stageDigest = computeMdStageSpecDigest(stage);
    return stage;
  });
  input.protocol.capabilityRefs = Object.values(input.policy.capabilityByStageKind);
  input.environment.capabilities = Object.values(input.policy.capabilityByStageKind);
  input.environment.environmentDigest = computeMdEnvironmentDigest(input.environment);
  input.stageSkillBindings = input.protocol.stages.map((stage) => ({
    stageId: stage.id,
    fragments: input.stageSkillBindings[0]!.fragments,
  }));
  input.protocol.protocolDigest = computeMdWorkflowProtocolDigest(input.protocol);
  input.protocolApproval.payloadDigest = input.protocol.protocolDigest;
  input.protocolApproval.response!.payloadDigest = input.protocol.protocolDigest;
  return input;
}
function resultFor(
  input: ReturnType<typeof fullWorkflow>,
  stage: MdStageSpec,
  workUnitId: string,
  clock: number,
) {
  const result: MdStageResult = {
    schemaVersion: MdStageResultSchemaVersion,
    id: `result-${stage.id}`,
    revision: 1,
    missionId: input.plan.missionId,
    workUnitId,
    operationId: `operation-${stage.id}`,
    operationReceiptId: `receipt-${stage.id}`,
    protocolId: input.protocol.id,
    protocolRevision: input.protocol.revision,
    protocolDigest: input.protocol.protocolDigest,
    stageId: stage.id,
    stageRevision: stage.revision,
    stageDigest: stage.stageDigest,
    stageKind: stage.kind,
    terminalReason: "completed",
    exitCode: 0,
    signal: null,
    startedAt: "2026-10-01T00:00:00Z",
    finishedAt: "2026-10-01T00:01:00Z",
    startStep: 0,
    endStep: stage.kind === "minimization" ? 12 : stage.steps,
    startTimePs: clock,
    endTimePs: clock + (stage.simulatedTimePs ?? 0),
    engine: input.environment.engine,
    artifacts: stage.outputs.map((output) => ({
      role: output.role,
      mediaType: output.mediaType,
      artifactId: `${stage.id}-${output.role}`,
      evidenceRef: `evidence-${stage.id}-${output.role}`,
      contentDigest: "c".repeat(64),
    })),
    warnings: [],
    errors: [],
    validationStatus: "passed",
    validationRefs: [`qc-${stage.id}`],
    resultDigest: "0".repeat(64),
  };
  result.resultDigest = computeMdStageResultDigest(result);
  const assessment: MdStageAssessment = {
    schemaVersion: MdAssessmentSchemaVersion,
    id: `assessment-${stage.id}`,
    revision: 1,
    missionId: input.plan.missionId,
    stageResultId: result.id,
    stageResultRevision: result.revision,
    stageResultDigest: result.resultDigest,
    status: "accepted",
    nextStageEligible: true,
    evaluations: stage.acceptanceCriteria.map((criterion) => ({
      criterionId: criterion.id,
      criterionDigest: criterion.criterionDigest,
      required: criterion.required,
      status: "passed",
      summary: "Synthetic fixture only",
      evidenceRefs: [`qc-${stage.id}`],
    })),
    limitations: ["Synthetic metadata, not AMBER execution or physical validation"],
    evidenceRefs: [`qc-${stage.id}`],
    assessor: { id: "reviewer", kind: "human", role: "scientific_reviewer" },
    createdAt: "2026-10-01T00:02:00Z",
    assessmentDigest: "0".repeat(64),
  };
  assessment.assessmentDigest = computeMdStageAssessmentDigest(assessment);
  return { result, assessment };
}

describe("complete synthetic M1 -> E4 compiler chain", () => {
  test("emits exactly one gated child through all preparatory stages and defers P", () => {
    const input = fullWorkflow();
    const initial = compileMdWorkflowProtocol(input);
    expect(initial.workUnits).toHaveLength(1);
    expect(initial.deferredStages).toHaveLength(8);
    let parentWorkUnit = initial.workUnits[0]!,
      clock = 0;
    for (let i = 0; i < 7; i++) {
      const stage = input.protocol.stages[i]!,
        nextStage = input.protocol.stages[i + 1]!;
      const parent = resultFor(input, stage, parentWorkUnit.id, clock);
      const next = compileMdNextStage({
        ...input,
        nextStageId: nextStage.id,
        parentStageResult: parent.result,
        parentStageAssessment: parent.assessment,
      });
      expect(next.workUnit.dependencies).toEqual([parentWorkUnit.id]);
      expect(next.workUnit.protocolFragment.parameters.parentRestart).toEqual(
        parent.result.artifacts.find((artifact) => artifact.role === "restart"),
      );
      clock = parent.result.endTimePs;
      parentWorkUnit = next.workUnit;
    }
    const parent = resultFor(input, input.protocol.stages[7]!, parentWorkUnit.id, clock);
    expect(() =>
      compileMdNextStage({
        ...input,
        nextStageId: input.protocol.stages[8]!.id,
        parentStageResult: parent.result,
        parentStageAssessment: parent.assessment,
      }),
    ).toThrow();
  });
  test("allows early minimization convergence but rejects invented physical time", () => {
    const input = fullWorkflow(),
      first = compileMdWorkflowProtocol(input).workUnits[0]!;
    const { result, assessment } = resultFor(input, input.protocol.stages[0]!, first.id, 0);
    result.endTimePs = 1;
    result.resultDigest = computeMdStageResultDigest(result);
    assessment.stageResultDigest = result.resultDigest;
    assessment.assessmentDigest = computeMdStageAssessmentDigest(assessment);
    expect(() =>
      compileMdNextStage({
        ...input,
        nextStageId: input.protocol.stages[1]!.id,
        parentStageResult: result,
        parentStageAssessment: assessment,
      }),
    ).toThrow(expect.objectContaining({ code: "STAGE_GATE_MISMATCH" }));
  });
  test("preserves segment seeds and determinism separately from stage count", () => {
    const input = makeProductionInput();
    const first = compileMdProductionSegment(input);
    expect(first.workUnit.protocolFragment.parameters.replicaSegment).toMatchObject({
      segmentIndex: 0,
      segmentSeed: 771001,
    });
    expect(compileMdProductionSegment(structuredClone(input))).toEqual(first);
  });
  test.each(["0.0.0", "99.0.0", "2.0.2"])("does not silently admit producer %s", (version) => {
    const input = fullWorkflow();
    input.protocol.compilerVersion = version;
    input.protocol.protocolDigest = computeMdWorkflowProtocolDigest(input.protocol);
    input.protocolApproval.payloadDigest = input.protocol.protocolDigest;
    input.protocolApproval.response!.payloadDigest = input.protocol.protocolDigest;
    expect(() => compileMdWorkflowProtocol(input)).toThrow(
      expect.objectContaining({ code: "COMPILER_VERSION_UNSUPPORTED" }),
    );
  });
});
