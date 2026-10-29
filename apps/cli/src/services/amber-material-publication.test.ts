import { describe, expect, test } from "bun:test";
import { digestCanonical, WorkUnitSchema } from "@eigengrid/scientific-schema";
import {
  amberMaterialCapability,
  materialOperationIdentity,
  assertMaterialPublicationRequest,
  AmberMaterialRequestSchema,
} from "./amber-material-publication";

// Unit-only symbolic inputs; none of these are execution/publication evidence.
const hash = (label: string) => digestCanonical({ unitTest: label });
const skill = {
  skillId: "publication.unit-test",
  version: "1.0.0",
  contentDigest: hash("skill"),
  fragmentId: "publication.unit-test.protocol",
  fragmentDigest: hash("fragment"),
  relativePath: "protocols/core.yaml",
  selector: "$",
};
function fixture() {
  const capability = amberMaterialCapability("amber.force-field-stack");
  const parameters = {
    schemaVersion: "eigengrid.biomolecular-material-publication-binding/v1",
    subjectKind: "force_field_stack",
    subject: { id: "stack-unit-only", revision: 1, digest: hash("stack") },
    sourceEvidenceRefs: ["source-unit-only"],
    artifactEvidenceRef: "output-unit-only",
  };
  const unit = WorkUnitSchema.parse({
    id: "work-unit-only",
    missionId: "mission-unit-only",
    planId: "plan-unit-only",
    planVersion: 1,
    kind: "scientific_capability",
    state: "created",
    reason: "Unit-only publication contract",
    dependencies: [],
    inputRefs: ["source-unit-only"],
    outputContract: {
      requiredEvidenceKinds: ["force_field_stack"],
      requiredObservationKinds: ["artifact_integrity"],
    },
    skillRefs: [skill],
    protocolFragment: {
      schemaVersion: "eigengrid.scientific-capability-fragment/v1",
      id: "fragment-unit-only",
      kind: "scientific_capability",
      capability,
      reason: "Unit-only publication contract",
      parameters,
      sourceFragments: [skill],
      riskClass: 3,
    },
    retryPolicy: { maximumAttempts: 1, ambiguityRequiresReconciliation: true },
    approvalPolicy: { required: true, minimumRole: "scientific_reviewer" },
    executionPolicy: { capability: capability.id, riskClass: 3 },
    revision: 1,
    claimOwner: null,
    claimExpiresAt: null,
    jobId: null,
    attemptId: null,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
  });
  const identity = materialOperationIdentity(unit);
  const request = {
    schemaVersion: "eigengrid.force-field-stack-publication-request/v2" as const,
    missionId: unit.missionId,
    planId: unit.planId,
    planVersion: 1,
    workUnitId: unit.id,
    capability,
    intendedJobId: identity.jobId,
    intendedAttemptId: identity.attemptId,
    inputEvidenceId: "source-unit-only",
    inputContentDigest: hash("source"),
    stack: parameters.subject,
    sourceEvidence: [{ id: "source-unit-only", contentDigest: hash("source") }],
    outputArtifact: {
      evidenceRef: "output-unit-only",
      mediaType: "application/vnd.eigengrid.force-field-stack+json",
    },
    parametersDigest: digestCanonical(parameters),
    outputContractDigest: digestCanonical(unit.outputContract),
  };
  return { unit, request, identity };
}

describe("closed Amber material publication contracts (unit-only)", () => {
  test("binds the implementation's actual schema digest and stable coordinator identity", () => {
    const { unit, request, identity } = fixture();
    expect(assertMaterialPublicationRequest(unit, request)).toEqual(request);
    expect(materialOperationIdentity(structuredClone(unit))).toEqual(identity);
    expect(amberMaterialCapability("amber.force-field-stack")).toEqual(request.capability);
    expect(amberMaterialCapability("amber.topology-coordinate-validation").contractDigest).not.toBe(
      request.capability.contractDigest,
    );
  });
  test("refuses unsupported capabilities and arbitrary contract identities", () => {
    expect(() => amberMaterialCapability("amber.production-md")).toThrow();
    const { unit } = fixture();
    if (unit.protocolFragment.kind !== "scientific_capability") throw new Error("fixture contract");
    unit.protocolFragment.capability.contractDigest = hash("unqualified-contract");
    expect(() => materialOperationIdentity(unit)).toThrow();
  });
  test("rejects cross-mission, stale revision and coordinator/output digest drift", () => {
    const { unit, request } = fixture();
    for (const patch of [
      { missionId: "another-mission" },
      { planId: "another-plan" },
      { planVersion: 2 },
      { workUnitId: "another-work-unit" },
      { intendedJobId: "another-job" },
      { intendedAttemptId: "another-attempt" },
      { parametersDigest: hash("changed-parameters") },
      { outputContractDigest: hash("changed-outputs") },
      { outputArtifact: { ...request.outputArtifact, evidenceRef: "another-output" } },
      { stack: { ...request.stack, digest: hash("changed-stack") } },
    ])
      expect(() => assertMaterialPublicationRequest(unit, { ...request, ...patch })).toThrow();
  });
  test("cannot smuggle raw commands, paths, argv or environment into v2 material intents", () => {
    const { unit, request } = fixture();
    for (const patch of [
      { argv: ["sander"] },
      { command: "sbatch stage.sh" },
      { shell: "bash" },
      { environment: { CUDA_VISIBLE_DEVICES: "0" } },
      { path: "/scratch/other-system" },
    ])
      expect(() => assertMaterialPublicationRequest(unit, { ...request, ...patch })).toThrow();
  });
  test("does not accept historical v1 requests to create new effects", () => {
    const { unit, request } = fixture();
    const {
      missionId: _,
      planId: __,
      planVersion: ___,
      intendedJobId: ____,
      intendedAttemptId: _____,
      inputEvidenceId: ______,
      inputContentDigest: _______,
      ...old
    } = request;
    expect(() =>
      assertMaterialPublicationRequest(unit, {
        ...old,
        schemaVersion: "eigengrid.force-field-stack-publication-request/v1",
      }),
    ).toThrow();
  });
  test("requires risk 3 and exact human material approval rather than a numerical capability", () => {
    const { unit, request } = fixture();
    for (const patch of [
      { executionPolicy: { ...unit.executionPolicy, riskClass: 2 } },
      { approvalPolicy: { required: false } },
      { kind: "optimization" },
    ])
      expect(() =>
        assertMaterialPublicationRequest(WorkUnitSchema.parse({ ...unit, ...patch }), request),
      ).toThrow();
  });
  test("the human CLI schema exposes only bounded preparation actions", () => {
    const base = {
      projectId: "project-unit-only",
      missionId: "mission-unit-only",
      planId: "plan-unit-only",
    };
    expect(
      AmberMaterialRequestSchema.safeParse({
        ...base,
        action: "execute",
        workUnitId: "work-unit-only",
      }).success,
    ).toBe(true);
    for (const action of ["sbatch", "run-md", "shell", "seed-receipt", "publish-without-approval"])
      expect(AmberMaterialRequestSchema.safeParse({ ...base, action }).success).toBe(false);
    expect(
      AmberMaterialRequestSchema.safeParse({
        ...base,
        action: "execute",
        workUnitId: "work-unit-only",
        actorId: "someone-else",
      }).success,
    ).toBe(false);
  });
});
