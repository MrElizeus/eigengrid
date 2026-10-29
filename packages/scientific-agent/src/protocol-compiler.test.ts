import { describe, expect, test } from "bun:test";
import { digestCanonical } from "@eigengrid/scientific-schema";
import { compileScientificProtocol, computeScientificProtocolDigest } from "./protocol-compiler";
import {
  makeCompilationInput,
  makeCompilerPolicy,
  makeEnvironment,
  makePlan,
  makeProtocol,
  skillFragment,
} from "./test-fixtures";

describe("deterministic scientific protocol compiler", () => {
  test("compiles the same approved revision to the same side-effect-free DAG", () => {
    const input = makeCompilationInput();
    const before = structuredClone(input);
    const first = compileScientificProtocol(input);
    const second = compileScientificProtocol(structuredClone(input));

    expect(first).toEqual(second);
    expect(first.graphDigest).toBe(digestCanonical({ ...first, graphDigest: undefined }));
    expect(input).toEqual(before);
    expect(first.workUnits.map((unit) => unit.kind)).toEqual(["optimization", "validation"]);
    expect(first.workUnits[1].dependencies).toEqual([first.workUnits[0].id]);
  });

  test("returned output contracts cannot poison later compilations", () => {
    const input = makeCompilationInput();
    const first = compileScientificProtocol(input);
    const original = structuredClone(first);
    first.workUnits[0].outputContract.requiredEvidenceKinds.push("not-a-contract");
    expect(compileScientificProtocol(input)).toEqual(original);
  });

  test("preserves exact fragment attribution and explicit contracts and policies", () => {
    const result = compileScientificProtocol(makeCompilationInput());
    const optimization = result.workUnits[0];
    const validation = result.workUnits[1];

    expect(optimization.skillRefs).toEqual([skillFragment]);
    expect(optimization.reason).toContain("approved electronic model");
    expect(optimization.inputRefs).toContain("evidence-water-xyz");
    expect(optimization.outputContract.requiredEvidenceKinds).toEqual([
      "rendered_input",
      "operation_receipt",
      "artifact",
    ]);
    expect(optimization.executionPolicy).toEqual({
      capability: "scientific.optimization.request",
      riskClass: 2,
    });
    expect(optimization.retryPolicy).toEqual({
      maximumAttempts: 1,
      ambiguityRequiresReconciliation: true,
    });
    expect(validation.retryPolicy.maximumAttempts).toBe(2);
    expect(result.dependencies).toEqual([
      { workUnitId: validation.id, dependsOnWorkUnitId: optimization.id },
    ]);
  });

  test("uses only exact evidence IDs as work-unit inputs, never decision or assumption entity IDs", () => {
    const protocol = makeProtocol({ assumptions: ["assumption-solvent"] });
    const plan = makePlan({
      protocol,
      assumptions: [
        {
          id: "assumption-solvent",
          statement: "The fixture uses a gas-phase model",
          status: "accepted",
          riskClass: 2,
          evidenceRefs: ["evidence-assumption"],
        },
      ],
    });
    const input = makeCompilationInput({ plan });
    input.decisions = input.decisions.map((decision) => ({
      ...decision,
      evidenceRefs: [`evidence-${decision.category}`],
    }));
    const result = compileScientificProtocol(input);
    const expectedEvidence = [
      "evidence-assumption",
      "evidence-basis",
      "evidence-charge",
      "evidence-method",
      "evidence-multiplicity",
      "evidence-physical_model",
      "evidence-water-xyz",
    ].sort();
    expect(
      result.workUnits.every(
        (unit) => [...unit.inputRefs].sort().join() === expectedEvidence.join(),
      ),
    ).toBe(true);
    expect(result.workUnits.flatMap((unit) => unit.inputRefs)).not.toContain("decision-charge");
    expect(result.workUnits.flatMap((unit) => unit.inputRefs)).not.toContain("assumption-solvent");
  });

  test("fails closed for non-approved and stale plan revisions", () => {
    expect(() =>
      compileScientificProtocol(
        makeCompilationInput({ plan: makePlan({ status: "under_review" }) }),
      ),
    ).toThrow(expect.objectContaining({ code: "PLAN_NOT_APPROVED" }));
    expect(() =>
      compileScientificProtocol(makeCompilationInput({ approvedPlanRevision: 2 })),
    ).toThrow(
      expect.objectContaining({
        code: "PLAN_REVISION_MISMATCH",
      }),
    );
  });

  test("rejects zero, multiple, or mismatched executable approval roles", () => {
    for (const requiredApprovals of [
      [],
      ["scientific_reviewer", "safety_reviewer"],
      ["operator"],
    ]) {
      expect(() =>
        compileScientificProtocol(makeCompilationInput({ plan: makePlan({ requiredApprovals }) })),
      ).toThrow(expect.objectContaining({ code: "APPROVAL_POLICY_MISMATCH" }));
    }
  });

  test("rejects missing inputs and unresolved material decisions", () => {
    expect(() =>
      compileScientificProtocol(
        makeCompilationInput({ plan: makePlan({ missingInputs: ["molecular charge"] }) }),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "MISSING_SCIENTIFIC_INPUT",
      }),
    );

    const missingCharge = makeCompilationInput();
    missingCharge.decisions = missingCharge.decisions.filter((item) => item.category !== "charge");
    expect(() => compileScientificProtocol(missingCharge)).toThrow(
      expect.objectContaining({
        code: "UNRESOLVED_MATERIAL_DECISION",
      }),
    );
  });

  test("detects tampered protocols and fragment attribution", () => {
    const tampered = makeProtocol();
    tampered.method = "silently-modified-method";
    expect(computeScientificProtocolDigest(tampered)).not.toBe(tampered.protocolDigest);
    expect(() =>
      compileScientificProtocol(makeCompilationInput({ plan: makePlan({ protocol: tampered }) })),
    ).toThrow(
      expect.objectContaining({
        code: "PROTOCOL_DIGEST_MISMATCH",
      }),
    );

    const foreignReference = {
      ...skillFragment,
      fragmentDigest: "0".repeat(64),
    };
    const foreignProtocol = makeProtocol({
      engineAgnosticSteps: [
        { ...makeProtocol().engineAgnosticSteps[0], sourceFragments: [foreignReference] },
      ],
    });
    expect(() =>
      compileScientificProtocol(
        makeCompilationInput({ plan: makePlan({ protocol: foreignProtocol }) }),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "SKILL_ATTRIBUTION_MISMATCH",
      }),
    );
  });

  test("rejects incompatible maturity, engines, and missing typed capabilities", () => {
    const immature = makeEnvironment();
    immature.skillCompatibility[0].knowledgeMaturity = "draft";
    expect(() =>
      compileScientificProtocol(makeCompilationInput({ environment: immature })),
    ).toThrow(
      expect.objectContaining({
        code: "INSUFFICIENT_SKILL_MATURITY",
      }),
    );

    const wrongEngine = makeEnvironment({
      selectedEngine: { id: "unknown-engine", version: "9", adapterVersion: "1.0.0" },
    });
    expect(() =>
      compileScientificProtocol(makeCompilationInput({ environment: wrongEngine })),
    ).toThrow(expect.objectContaining({ code: "ENGINE_NOT_ALLOWED" }));

    const noOptimization = makeEnvironment();
    noOptimization.capabilities = noOptimization.capabilities.filter(
      (capability) => capability !== "scientific.optimization.request",
    );
    expect(() =>
      compileScientificProtocol(makeCompilationInput({ environment: noOptimization })),
    ).toThrow(
      expect.objectContaining({
        code: "CAPABILITY_UNAVAILABLE",
      }),
    );
  });

  test("rejects cyclic dependency directives deterministically", () => {
    const policy = makeCompilerPolicy({
      dependencyMap: {
        "step-optimize": ["step-validate"],
        "step-validate": ["step-optimize"],
      },
    });
    expect(() => compileScientificProtocol(makeCompilationInput({ policy }))).toThrow(
      expect.objectContaining({ code: "CYCLIC_DEPENDENCY" }),
    );
  });

  test("requires separately approved material decisions when policy says so", () => {
    const policy = makeCompilerPolicy({ materialDecisionApproval: "separate" });
    expect(() => compileScientificProtocol(makeCompilationInput({ policy }))).toThrow(
      expect.objectContaining({
        code: "UNAPPROVED_MATERIAL_DECISION",
      }),
    );

    const input = makeCompilationInput({ policy });
    input.approvedDecisionIds = ["decision-charge", "decision-multiplicity"];
    expect(compileScientificProtocol(input).workUnits).toHaveLength(2);
  });
});

describe("neutral compiler compatibility and data boundary", () => {
  test("uses the same implementation as the independent kernel", async () => {
    const kernel = await import("@eigengrid/protocol-core/protocol-compiler");
    expect(compileScientificProtocol).toBe(kernel.compileScientificProtocol);
    expect(kernel.compileScientificProtocol(makeCompilationInput())).toEqual(
      compileScientificProtocol(makeCompilationInput()),
    );
  });
  test.each(["shell", "argv", "command", "executable", "sql"])(
    "rejects raw %s in legacy parameters",
    (key) => {
      const input = makeCompilationInput();
      input.plan.protocol.engineAgnosticSteps[0]!.parameters[key] = "not-scientific-control";
      input.plan.protocol.protocolDigest = computeScientificProtocolDigest(input.plan.protocol);
      expect(() => compileScientificProtocol(input)).toThrow(
        expect.objectContaining({ code: "INVALID_COMPILER_INPUT" }),
      );
    },
  );
  test("does not leak extra executable fields from permissive historical schemas", () => {
    const input = makeCompilationInput();
    Object.assign(input.plan.protocol.engineAgnosticSteps[0]!, { shell: "not-allowed" });
    input.plan.protocol.protocolDigest = computeScientificProtocolDigest(input.plan.protocol);
    expect(() => compileScientificProtocol(input)).toThrow(
      expect.objectContaining({ code: "INVALID_COMPILER_INPUT" }),
    );
  });
  test("compiled metadata cannot mutate the caller's approved plan", () => {
    const input = makeCompilationInput(),
      before = structuredClone(input);
    const output = compileScientificProtocol(input);
    output.workUnits[0]!.protocolFragment.parameters.changed = true;
    expect(input).toEqual(before);
  });
});
