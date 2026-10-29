import { describe, expect, test } from "bun:test";
import {
  MdStageSpecSchema,
  MdWorkflowProtocolSchema,
  MdStageResultSchema,
  computeMdStageResultDigest,
  computeMdStageAssessmentDigest,
  computeMdStageSpecDigest,
  computeMdWorkflowProtocolDigest,
  computeMdRestraintSelectionDigest,
} from "@eigengrid/scientific-schema";
import {
  compileMdWorkflowProtocol,
  compileMdNextStage,
  compileMdProductionSegment,
  MdCompilerPolicySchema,
  ApprovedMdPlanProjectionSchema,
  type MdProtocolCompilationInput,
} from "./md-protocol-compiler";
import { makeInput, makeNextStageInput, makeProductionInput } from "./md-fixtures";

function resealParent(input: ReturnType<typeof makeNextStageInput>): void {
  input.parentStageResult.resultDigest = computeMdStageResultDigest(input.parentStageResult);
  input.parentStageAssessment.stageResultDigest = input.parentStageResult.resultDigest;
  input.parentStageAssessment.assessmentDigest = computeMdStageAssessmentDigest(
    input.parentStageAssessment,
  );
}
function resealProtocol(input: MdProtocolCompilationInput): void {
  for (const stage of input.protocol.stages) stage.stageDigest = computeMdStageSpecDigest(stage);
  input.protocol.protocolDigest = computeMdWorkflowProtocolDigest(input.protocol);
  input.protocolApproval.payloadDigest = input.protocol.protocolDigest;
  input.protocolApproval.response!.payloadDigest = input.protocol.protocolDigest;
}

describe("data-only compiler boundaries", () => {
  for (const [index, value] of [undefined, null, true, [], 1, "a", { callback() {} }].entries())
    test(`rejects malformed root ${index}`, () => {
      expect(() =>
        compileMdWorkflowProtocol(value as unknown as MdProtocolCompilationInput),
      ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    });
  test("does not invoke accessors while validating input", () => {
    const input = makeInput();
    let reads = 0;
    Object.defineProperty(input, "plan", {
      enumerable: true,
      get: () => {
        reads++;
        throw Error("getter");
      },
    });
    expect(() => compileMdWorkflowProtocol(input)).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(reads).toBe(0);
  });
  test("rejects cycles, symbols and prototype pollution payloads", () => {
    for (const extra of [
      JSON.parse('{"__proto__":{"polluted":true}}'),
      { [Symbol("hidden")]: "x" },
      new Date(),
    ]) {
      expect(() =>
        compileMdWorkflowProtocol({ ...makeInput(), extra } as MdProtocolCompilationInput),
      ).toThrow();
    }
    const input = makeInput() as MdProtocolCompilationInput & { cycle?: unknown };
    input.cycle = input;
    expect(() => compileMdWorkflowProtocol(input)).toThrow();
  });
  test("results cannot mutate the original approved input", () => {
    const input = makeInput();
    const original = structuredClone(input);
    const compiled = compileMdWorkflowProtocol(input);
    compiled.workUnits[0]!.retryPolicy.maximumAttempts = 99;
    compiled.deferredStages[0]!.sourceFragments[0]!.fragmentDigest = "f".repeat(64);
    expect(input).toEqual(original);
    expect(compileMdWorkflowProtocol(input)).toEqual(
      compileMdWorkflowProtocol(structuredClone(original)),
    );
  });
  test.each([NaN, Infinity, -Infinity])(
    "schema and compiler reject non-finite controls %p",
    (bad) => {
      const mutations = [
        (s: ReturnType<typeof makeInput>["protocol"]["stages"][number]) => {
          s.timeStepPs = bad;
        },
        (s: ReturnType<typeof makeInput>["protocol"]["stages"][number]) => {
          s.temperature!.points[0]!.kelvin = bad;
        },
        (s: ReturnType<typeof makeInput>["protocol"]["stages"][number]) => {
          s.nonbonded.cutoffAngstrom = bad;
        },
      ];
      for (const mutate of mutations) {
        const input = makeInput();
        mutate(input.protocol.stages[0]!);
        expect(MdStageSpecSchema.safeParse(input.protocol.stages[0]).success).toBe(false);
        expect(() => compileMdWorkflowProtocol(input)).toThrow();
      }
    },
  );
  test("rejects unsafe step integers and overflowing time products", () => {
    const stage = makeInput().protocol.stages[0]!;
    stage.steps = Number.MAX_SAFE_INTEGER + 1;
    expect(MdStageSpecSchema.safeParse(stage).success).toBe(false);
    stage.steps = 1000;
    stage.timeStepPs = 1e308;
    expect(MdStageSpecSchema.safeParse(stage).success).toBe(false);
  });
  test("policy retries and exact plan revisions reject unsafe integers", () => {
    const input = makeInput();
    expect(
      MdCompilerPolicySchema.safeParse({
        ...input.policy,
        retryPolicy: { ...input.policy.retryPolicy, maximumAttempts: Number.MAX_SAFE_INTEGER + 1 },
      }).success,
    ).toBe(false);
    for (const field of ["version", "revision"] as const)
      expect(
        ApprovedMdPlanProjectionSchema.safeParse({
          ...input.plan,
          [field]: Number.MAX_SAFE_INTEGER + 1,
        }).success,
      ).toBe(false);
  });
  test("rejects duplicate criteria and raw stage command fields", () => {
    const stage = makeInput().protocol.stages[0]!;
    expect(MdStageSpecSchema.safeParse({ ...stage, shell: "sbatch anything" }).success).toBe(false);
    stage.acceptanceCriteria.push(structuredClone(stage.acceptanceCriteria[0]!));
    expect(MdStageSpecSchema.safeParse(stage).success).toBe(false);
  });
});

describe("exact parent continuation gates", () => {
  const mutations: [string, (input: ReturnType<typeof makeNextStageInput>) => void][] = [
    [
      "engine build",
      (i) => {
        i.parentStageResult.engine = { ...i.parentStageResult.engine, buildDigest: "b".repeat(64) };
      },
    ],
    [
      "engine environment",
      (i) => {
        i.parentStageResult.engine = {
          ...i.parentStageResult.engine,
          environmentDigest: "b".repeat(64),
        };
      },
    ],
    [
      "engine identity",
      (i) => {
        i.parentStageResult.engine = { ...i.parentStageResult.engine, engine: "gromacs" };
      },
    ],
    [
      "short step interval",
      (i) => {
        i.parentStageResult.endStep--;
      },
    ],
    [
      "short physical interval",
      (i) => {
        i.parentStageResult.endTimePs -= 0.5;
      },
    ],
    [
      "empty validation",
      (i) => {
        i.parentStageResult.validationRefs = [];
      },
    ],
    [
      "error despite PASS",
      (i) => {
        i.parentStageResult.errors = [
          { code: "X", message: "error", severity: "error", sourceEvidenceRefs: ["fixture-error"] },
        ];
      },
    ],
    [
      "wrong restart format",
      (i) => {
        i.parentStageResult.artifacts[0]!.mediaType = "text/not-a-restart";
      },
    ],
    [
      "foreign parent stage",
      (i) => {
        i.parentStageResult.stageId = "other-parent";
      },
    ],
  ];
  test.each(mutations)("rejects rehashed %s, even with accepted assessment", (_name, mutate) => {
    const input = makeNextStageInput();
    mutate(input);
    resealParent(input);
    expect(() => compileMdNextStage(input)).toThrow(
      expect.objectContaining({ code: "STAGE_GATE_MISMATCH" }),
    );
  });
  test("requires all stage-declared artifacts, not only the generic three", () => {
    const input = makeNextStageInput();
    input.protocol.stages[0]!.outputs.push({
      role: "energy_series",
      required: true,
      mediaType: "text/plain",
    });
    resealProtocol(input);
    input.parentStageResult.protocolDigest = input.protocol.protocolDigest;
    input.parentStageResult.stageDigest = input.protocol.stages[0]!.stageDigest;
    resealParent(input);
    expect(() => compileMdNextStage(input)).toThrow(
      expect.objectContaining({ code: "STAGE_GATE_MISMATCH" }),
    );
  });
  test("allows elapsed clock offsets but never a short dynamics segment", () => {
    const input = makeNextStageInput();
    input.parentStageResult.startStep += 10_000;
    input.parentStageResult.endStep += 10_000;
    input.parentStageResult.startTimePs += 20;
    input.parentStageResult.endTimePs += 20;
    resealParent(input);
    expect(compileMdNextStage(input).dependency.dependsOnWorkUnitId).toBe(
      input.parentStageResult.workUnitId,
    );
    input.parentStageResult.endTimePs = 0;
    expect(MdStageResultSchema.safeParse(input.parentStageResult).success).toBe(false);
  });
  test("production shares the exact parent gates", () => {
    const input = makeProductionInput();
    input.parentStageResult.engine = { ...input.parentStageResult.engine, version: "99" };
    input.parentStageResult.resultDigest = computeMdStageResultDigest(input.parentStageResult);
    input.parentStageAssessment.stageResultDigest = input.parentStageResult.resultDigest;
    input.parentStageAssessment.assessmentDigest = computeMdStageAssessmentDigest(
      input.parentStageAssessment,
    );
    expect(() => compileMdProductionSegment(input)).toThrow(
      expect.objectContaining({ code: "STAGE_GATE_MISMATCH" }),
    );
  });
  test.each(["timestep", "pressure", "temperature", "seed", "restraint"])(
    "%s edit invalidates approval even after self-digest repair",
    (field) => {
      const input = makeInput(),
        stage = input.protocol.stages[0]!;
      if (field === "timestep") {
        stage.timeStepPs = 0.001;
        stage.simulatedTimePs = 1;
      }
      if (field === "temperature") stage.temperature!.points[0]!.kelvin = 310;
      if (field === "seed") stage.randomSeed = { policy: "fixed", seed: 77 };
      if (field === "pressure") {
        stage.ensemble = "npt";
        stage.barostat = {
          kind: "berendsen",
          coupling: "isotropic",
          targetPressureBar: 1,
          relaxationTimePs: 1,
        };
      }
      if (field === "restraint")
        stage.restraints = [
          {
            id: "r",
            kind: "positional",
            sourceDecisionId: input.decisionRefs[0]!.id,
            schedule: [{ step: 0, forceConstant: 1 }],
            selections: [
              {
                id: "s",
                atomCount: 1,
                atomIndices: [1],
                description: "fixture",
                definitionDigest: computeMdRestraintSelectionDigest(
                  stage.system.atomMapDigest,
                  [1],
                ),
              },
            ],
          },
        ];
      for (const item of input.protocol.stages) item.stageDigest = computeMdStageSpecDigest(item);
      input.protocol.protocolDigest = computeMdWorkflowProtocolDigest(input.protocol);
      expect(() => compileMdWorkflowProtocol(input)).toThrow(
        expect.objectContaining({ code: "APPROVAL_MISMATCH" }),
      );
    },
  );
});

describe("workflow structure", () => {
  test.each(["duplicate", "cycle", "missing", "sequence", "version", "units"])(
    "rejects %s",
    (kind) => {
      const input = makeInput();
      const stage = input.protocol.stages[1]!;
      if (kind === "duplicate") stage.id = input.protocol.stages[0]!.id;
      if (kind === "cycle") input.protocol.stages[0]!.parentStageId = stage.id;
      if (kind === "missing") stage.parentStageId = "absent";
      if (kind === "sequence") stage.sequence = 99;
      if (kind === "version")
        (input.protocol as unknown as { schemaVersion: string }).schemaVersion = "unknown/v99";
      if (kind === "units") Object.assign(stage, { timeStepFs: 2 });
      expect(MdWorkflowProtocolSchema.safeParse(input.protocol).success).toBe(false);
      expect(() => compileMdWorkflowProtocol(input)).toThrow();
    },
  );
});
