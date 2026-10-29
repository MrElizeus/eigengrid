import { describe, expect, test } from "bun:test";
import {
  ApprovalRequestSchema,
  AtomMapPublicationRequestSchema,
  AtomMapPublicationRequestSchemaVersion,
  BiomolecularSystemBuildRequestSchema,
  BiomolecularSystemBuildRequestSchemaVersion,
  BiomolecularSystemBuildRequestSchemaVersionV1,
  ExternalOperationSchema,
  ForceFieldStackPublicationRequestSchema,
  ForceFieldStackPublicationRequestSchemaVersion,
  WorkUnitSchema,
  digestCanonical,
  type EvidenceReference,
} from "@eigengrid/scientific-schema";
import type { MissionProvenance } from "@eigengrid/mission-runtime";
import type { MissionCandidate } from "./mission-application";
import { approvalBelongsToMissionCandidate } from "./mission-application";
import {
  createBiomolecularSystemBuildRequest,
  systemPreparationEffectIdentity,
} from "./system-preparation-binding";

const at = "2026-09-30T11:50:00.000Z";
const digest = (letter: string) => letter.repeat(64);
const owner = { id: "candidate-owner", kind: "human" as const, role: "scientific_reviewer" };
const capabilityFor = (kind: "build" | "stack" | "atom_map") => ({
  id:
    kind === "build"
      ? "biomolecular.build-system"
      : kind === "stack"
        ? "amber.force-field-stack"
        : "amber.topology-coordinate-validation",
  version: "1.0.0",
  contractDigest: digest("1"),
});
const forceFieldStack = { id: "ligand-force-field-stack", revision: 1, digest: digest("2") };
const decisionRefs = [
  {
    id: "ligand-microstate-decision",
    revision: 1,
    kind: "protonation" as const,
    decisionDigest: digest("3"),
    approvalRef: "approval-ligand-microstate",
  },
];

function fixture(kind: "build" | "stack" | "atom_map") {
  const missionId = "mission-ligand";
  const planId = "plan-ligand";
  const workUnitId = `work-${kind}`;
  const operationId = kind === "build" ? "operation-build-system" : `operation-${kind}-publication`;
  const capability = capabilityFor(kind);
  const inputEvidenceId = `input-${kind}`;
  const inputContentDigest = kind === "atom_map" ? digest("4") : digest("5");
  const evidence = {
    id: inputEvidenceId,
    missionId,
    kind: "source_snapshot" as const,
    contentDigest: inputContentDigest,
    uri: `cas://sha256/${inputContentDigest}`,
    immutable: true,
    createdAt: at,
    mediaType: kind === "atom_map" ? "application/vnd.eigengrid.atom-map+json" : "chemical/x-pdb",
  } satisfies EvidenceReference;
  const outputContract = {
    requiredEvidenceKinds: ["topology", "coordinates", "atom_map"],
    requiredObservationKinds: ["artifact_integrity", "topology_integrity"],
  };
  const parameters = { systemManifestId: "fixture-system", forceFieldStackId: forceFieldStack.id };
  const workUnit = WorkUnitSchema.parse({
    id: workUnitId,
    missionId,
    planId,
    planVersion: 3,
    kind: "scientific_capability",
    state: "claimed",
    reason: "Build and publish an exact prepared-system package",
    dependencies: [],
    inputRefs: [inputEvidenceId],
    outputContract,
    skillRefs: [
      {
        skillId: "amber.production-preparation",
        version: "1.0.0",
        contentDigest: digest("6"),
        fragmentId: "preparation",
        fragmentDigest: digest("7"),
        relativePath: "protocols/preparation.md",
        selector: "build",
      },
    ],
    protocolFragment: {
      schemaVersion: "eigengrid.scientific-capability-fragment/v1",
      id: `fragment-${kind}`,
      kind: "scientific_capability",
      capability,
      reason: "Exact typed preparation request",
      parameters,
      sourceFragments: [
        {
          skillId: "amber.production-preparation",
          version: "1.0.0",
          contentDigest: digest("6"),
          fragmentId: "preparation",
          fragmentDigest: digest("7"),
          relativePath: "protocols/preparation.md",
          selector: "build",
        },
      ],
      riskClass: 3,
    },
    retryPolicy: { maximumAttempts: 1, ambiguityRequiresReconciliation: true },
    approvalPolicy: { required: true, minimumRole: "scientific_reviewer" },
    executionPolicy: { capability: capability.id, riskClass: 3 },
    revision: 2,
    claimOwner: "eigengrid-head",
    claimExpiresAt: "2026-09-30T12:00:00.000Z",
    jobId: null,
    attemptId: null,
    createdAt: at,
    updatedAt: at,
  });
  const outputEvidence = (id: string, mediaType: string) => ({ evidenceRef: id, mediaType });
  const base = {
    workUnitId,
    capability,
    parametersDigest: digestCanonical(parameters),
    outputContractDigest: digestCanonical(outputContract),
    missionId,
    planId,
    planVersion: 3,
    intendedJobId: `job-${kind}`,
    intendedAttemptId: `attempt-${kind}`,
    inputEvidenceId,
    inputContentDigest,
  };
  const request =
    kind === "build"
      ? BiomolecularSystemBuildRequestSchema.parse({
          schemaVersion: BiomolecularSystemBuildRequestSchemaVersion,
          ...base,
          systemManifest: { id: "fixture-system", revision: 1 },
          sourceEvidence: [{ id: inputEvidenceId, contentDigest: inputContentDigest }],
          decisionRefs,
          forceFieldStack,
          outputArtifacts: {
            topology: outputEvidence("topology-output", "application/vnd.amber.prmtop"),
            coordinates: outputEvidence("coordinate-output", "application/vnd.amber.rst7"),
            atomMap: outputEvidence("atom-map-output", "application/vnd.eigengrid.atom-map+json"),
          },
        })
      : kind === "stack"
        ? ForceFieldStackPublicationRequestSchema.parse({
            schemaVersion: ForceFieldStackPublicationRequestSchemaVersion,
            ...base,
            stack: forceFieldStack,
            sourceEvidence: [{ id: inputEvidenceId, contentDigest: inputContentDigest }],
            outputArtifact: outputEvidence(
              "force-field-stack-output",
              "application/vnd.eigengrid.force-field-stack+json",
            ),
          })
        : AtomMapPublicationRequestSchema.parse({
            schemaVersion: AtomMapPublicationRequestSchemaVersion,
            ...base,
            atomMap: { id: "ligand-atom-map", revision: 1, digest: inputContentDigest },
            systemManifest: {
              id: "fixture-system",
              revision: 1,
              digest: digest("8"),
            },
            sourceArtifact: outputEvidence(
              inputEvidenceId,
              "application/vnd.eigengrid.atom-map+json",
            ),
          });
  const operation = ExternalOperationSchema.parse({
    id: operationId,
    missionId,
    workUnitId,
    idempotencyKey: `system-preparation/${missionId}/${workUnitId}`,
    kind: "system_preparation",
    state: "confirmed",
    request,
    requestDigest: digestCanonical(request),
    policyDigest: digest("9"),
    externalIdentity: { jobId: `job-${kind}`, attemptId: `attempt-${kind}` },
    receiptId: `receipt-${kind}`,
    revision: 3,
    createdAt: at,
    updatedAt: at,
  });
  const approval = ApprovalRequestSchema.parse({
    id: `approval-${kind}`,
    missionId,
    subjectType: "operation",
    subjectId: operation.id,
    subjectVersion: 1,
    subjectRevision: 1,
    state: "approved",
    requestedFromRole: "scientific_reviewer",
    payloadDigest: operation.requestDigest,
    policyDigest: operation.policyDigest,
    editableFields: [],
    requestedBy: owner,
    requestedAt: at,
    response: {
      id: `response-${kind}`,
      approvalRequestId: `approval-${kind}`,
      decision: "approved",
      actor: owner,
      role: owner.role,
      reason: "Review exact operation request",
      subjectVersion: 1,
      subjectRevision: 1,
      payloadDigest: operation.requestDigest,
      policyDigest: operation.policyDigest,
      decidedAt: at,
    },
  });
  const system = {
    id: "fixture-system",
    revision: 1,
    manifestDigest: digest("8"),
    atomMapDigest: kind === "atom_map" ? inputContentDigest : digest("a"),
    forceFieldStack,
    decisionRefs,
    provenance: { operationId: "operation-build-system" },
  };
  const candidate = {
    plan: {
      id: planId,
      missionId,
      version: 3,
      status: "approved",
      requiredApprovals: ["scientific_reviewer"],
    },
    md: { system, decisionRefs },
  } as unknown as MissionCandidate;
  const provenance = {
    operations: [operation],
    workUnits: [workUnit],
    evidence: [evidence],
  } as MissionProvenance;
  return { candidate, provenance, approval, operation, workUnit };
}

describe("mission application prepared-system approval binding", () => {
  test.each(["build", "stack", "atom_map"] as const)(
    "reviews the exact v2 %s operation under its approved plan WorkUnit",
    (kind) => {
      const value = fixture(kind);
      expect(
        approvalBelongsToMissionCandidate(value.approval, value.candidate, value.provenance),
      ).toBe(true);
    },
  );

  test("reviews a typed system-build operation before an MD manifest has been published", () => {
    const value = fixture("build");
    const source = value.provenance.evidence[0]!;
    const stackEvidence = {
      id: "force-field-stack-input",
      missionId: source.missionId,
      kind: "force_field_stack" as const,
      contentDigest: forceFieldStack.digest,
      uri: `cas://sha256/${forceFieldStack.digest}`,
      immutable: true,
      createdAt: at,
    };
    const binding = {
      schemaVersion: "eigengrid.biomolecular-system-build-work-unit-binding/v1" as const,
      primaryInputEvidenceId: source.id,
      sourceEvidenceRefs: [source.id],
      forceFieldStackEvidenceRef: stackEvidence.id,
      decisionRefs,
      forceFieldStack,
      outputArtifacts: {
        topology: {
          evidenceRef: "topology-output",
          mediaType: "application/vnd.amber.prmtop" as const,
        },
        coordinates: {
          evidenceRef: "coordinate-output",
          mediaType: "application/vnd.amber.rst7" as const,
        },
        atomMap: {
          evidenceRef: "atom-map-output",
          mediaType: "application/vnd.eigengrid.atom-map+json" as const,
        },
      },
    };
    const parameters = {
      manifestId: "fixture-system",
      manifestRevision: 1,
      manifestDigest: digest("b"),
      systemBuild: binding,
    };
    const workUnit = WorkUnitSchema.parse({
      ...value.workUnit,
      inputRefs: [source.id, stackEvidence.id],
      jobId: null,
      attemptId: null,
      protocolFragment: {
        ...value.workUnit.protocolFragment,
        capability: capabilityFor("build"),
        parameters,
      },
    });
    const identity = systemPreparationEffectIdentity(workUnit);
    const request = createBiomolecularSystemBuildRequest({
      workUnit,
      evidence: [source, stackEvidence],
      decisions: decisionRefs.map((decision) => ({
        ...decision,
        missionId: source.missionId,
        status: "approved" as const,
      })),
    });
    const operation = ExternalOperationSchema.parse({
      ...value.operation,
      id: identity.operationId,
      idempotencyKey: identity.idempotencyKey,
      request,
      requestDigest: digestCanonical(request),
      externalIdentity: { jobId: identity.jobId, attemptId: identity.attemptId },
    });
    const approval = ApprovalRequestSchema.parse({
      ...value.approval,
      subjectId: operation.id,
      payloadDigest: operation.requestDigest,
      response: {
        ...value.approval.response!,
        payloadDigest: operation.requestDigest,
      },
    });
    const candidate = {
      plan: value.candidate.plan,
    } as unknown as MissionCandidate;
    const provenance = {
      ...value.provenance,
      operations: [operation],
      workUnits: [workUnit],
      evidence: [source, stackEvidence],
    } as MissionProvenance;

    expect(approvalBelongsToMissionCandidate(approval, candidate, provenance)).toBe(true);

    const changedBinding = {
      ...binding,
      outputArtifacts: {
        ...binding.outputArtifacts,
        topology: { ...binding.outputArtifacts.topology, evidenceRef: "other-topology" },
      },
    };
    const changedWorkUnit = WorkUnitSchema.parse({
      ...workUnit,
      protocolFragment: {
        ...workUnit.protocolFragment,
        parameters: { ...parameters, systemBuild: changedBinding },
      },
    });
    expect(
      approvalBelongsToMissionCandidate(approval, candidate, {
        ...provenance,
        workUnits: [changedWorkUnit],
      } as MissionProvenance),
    ).toBe(false);
  });

  test("does not bind an operation approval to another plan, WorkUnit, evidence, or v1 request", () => {
    const value = fixture("build");
    const request = { ...value.operation.request, planId: "plan-other" };
    const operation = ExternalOperationSchema.parse({
      ...value.operation,
      request,
      requestDigest: digestCanonical(request),
    });
    const approval = ApprovalRequestSchema.parse({
      ...value.approval,
      payloadDigest: operation.requestDigest,
      response: {
        ...value.approval.response!,
        payloadDigest: operation.requestDigest,
      },
    });
    const otherPlan = {
      ...value.provenance,
      operations: [operation],
    } as MissionProvenance;
    expect(approvalBelongsToMissionCandidate(approval, value.candidate, otherPlan)).toBe(false);

    const mismatchedWork = {
      ...value.provenance,
      workUnits: [{ ...value.workUnit, planId: "plan-other" }],
    } as MissionProvenance;
    expect(approvalBelongsToMissionCandidate(value.approval, value.candidate, mismatchedWork)).toBe(
      false,
    );

    const changedEvidence = {
      ...value.provenance,
      evidence: [{ ...value.provenance.evidence[0]!, immutable: false }],
    } as MissionProvenance;
    expect(
      approvalBelongsToMissionCandidate(value.approval, value.candidate, changedEvidence),
    ).toBe(false);

    const legacyRequest: Record<string, unknown> = {
      ...value.operation.request,
      schemaVersion: BiomolecularSystemBuildRequestSchemaVersionV1,
    };
    for (const key of [
      "missionId",
      "planId",
      "planVersion",
      "intendedJobId",
      "intendedAttemptId",
      "inputEvidenceId",
      "inputContentDigest",
    ])
      delete legacyRequest[key];
    const legacyOperation = ExternalOperationSchema.parse({
      ...value.operation,
      request: legacyRequest,
      requestDigest: digestCanonical(legacyRequest),
    });
    const legacyApproval = ApprovalRequestSchema.parse({
      ...value.approval,
      payloadDigest: legacyOperation.requestDigest,
      response: {
        ...value.approval.response!,
        payloadDigest: legacyOperation.requestDigest,
      },
    });
    expect(
      approvalBelongsToMissionCandidate(legacyApproval, value.candidate, {
        ...value.provenance,
        operations: [legacyOperation],
      } as MissionProvenance),
    ).toBe(false);
  });
});
