import { describe, expect, test } from "bun:test";
import { digestCanonical } from "@eigengrid/scientific-schema";
import type { ToolContext, ToolResult } from "../../types";
import { MdToolCatalog, MdToolNames, type MdToolName } from "./catalog";
import { MdOperationReceiptSchema, type MdToolOutput } from "./contracts";
import {
  materializeMdToolBundle,
  validateMdToolServiceResult,
  type MdToolServices,
  type MdValidatedToolInvocation,
} from "./bundle";

const digest = (character: string): string => character.repeat(64);
const context = {} as ToolContext;

function envelope(payload: object) {
  return {
    schemaVersion: "eigengrid.md-tool-request/v2",
    requestId: "request-1",
    idempotencyKey: "mission-1:request-1",
    missionId: "mission-1",
    expectedMissionRevision: 7,
    expectedSubjectRevision: 3,
    actorRef: { id: "model-1", kind: "model", role: "operator" },
    evidenceRefs: [{ id: "evidence-1", contentDigest: digest("a") }],
    payload,
  };
}

const evidence = (id: string, character = "a") => ({ id, contentDigest: digest(character) });
const exact = (id: string, revision: number, character: string) => ({
  id,
  revision,
  contentDigest: digest(character),
});
const observed = (reference: { id: string; revision: number; contentDigest: string }) => ({
  subjectId: reference.id,
  revision: reference.revision,
  contentDigest: reference.contentDigest,
});
const decision = (
  id: string,
  revision: number,
  character: string,
  kind:
    | "construct"
    | "protonation"
    | "microstate"
    | "pose"
    | "force_field_stack"
    | "membrane_model"
    | "replica_set",
) => ({
  ...exact(id, revision, character),
  kind,
  approvalRequestId: `approval-${id}`,
  approvalRequestRevision: 1,
  approvalRequestDigest: digest(character),
});

function payloadFor(name: MdToolName): Record<string, unknown> {
  const subject = { subjectId: "subject-1", subjectRevision: 3, subjectDigest: digest("1") };
  const protocol = {
    protocolId: "protocol-1",
    protocolRevision: 3,
    protocolDigest: digest("2"),
  };
  const stage = {
    ...protocol,
    stageId: "stage-1",
    stageRevision: 3,
    stageDigest: digest("3"),
  };
  if (name === "md-list-capabilities" || name === "md-inspect-environment") return {};
  if (name === "md-fetch-pdb-entry") {
    return {
      pdbId: "1ABC",
      format: "mmcif",
      cachePolicy: "cache_only",
      expectedContentDigest: digest("a"),
    };
  }
  if (name === "md-fetch-pubchem-compound") {
    return {
      cid: 4,
      format: "sdf",
      cachePolicy: "cache_only",
      expectedContentDigest: digest("b"),
    };
  }
  if (name.startsWith("md-inspect-") || name === "md-enumerate-microstates") return subject;
  const proposalKind = {
    "md-propose-construct-policy": "construct",
    "md-propose-protonation-plan": "protonation",
    "md-propose-ligand-state": "microstate",
    "md-propose-pose-strategy": "pose",
    "md-propose-force-field-stack": "force_field_stack",
    "md-propose-membrane-model": "membrane_model",
  } as const;
  if (name in proposalKind) {
    return {
      ...subject,
      decisionKind: proposalKind[name as keyof typeof proposalKind],
      constraintRefs: [],
    };
  }
  if (
    name === "md-compile-amber-workflow" ||
    name === "md-estimate-resources" ||
    name === "md-critic-review-plan"
  ) {
    return {
      planId: "plan-1",
      planRevision: 3,
      planDigest: digest("4"),
      systemManifestId: "system-1",
      systemManifestRevision: 1,
      systemManifestDigest: digest("5"),
    };
  }
  if (name === "md-diff-protocol-revisions") {
    return {
      leftProtocolId: "protocol-1",
      leftProtocolRevision: 2,
      leftProtocolDigest: digest("6"),
      rightProtocolId: "protocol-1",
      rightProtocolRevision: 3,
      rightProtocolDigest: digest("7"),
    };
  }
  if (name === "md-import-evidence") {
    return {
      evidenceId: "evidence-new-1",
      evidenceRevision: 1,
      sourceKind: "operator_upload",
      sourceRecordId: "notebook-reference",
      mediaType: "application/json",
      expectedContentDigest: digest("8"),
      acquisitionRequestDigest: digest("9"),
    };
  }
  if (name === "md-create-system-manifest") {
    return {
      systemManifestId: "system-1",
      systemManifestRevision: 3,
      systemManifestDigest: digest("a"),
      sourceEvidenceRefs: [evidence("structure-1", "b")],
      decisionRefs: [decision("decision-1", 2, "c", "construct")],
      forceFieldStackId: "ff-1",
      forceFieldStackRevision: 1,
      forceFieldStackDigest: digest("d"),
      parameterManifestId: "parameters-1",
      parameterManifestRevision: 1,
      parameterManifestDigest: digest("e"),
    };
  }
  if (name === "md-approve-construct-policy" || name === "md-approve-ligand-state") {
    return {
      decisionKind: name === "md-approve-construct-policy" ? "construct" : "microstate",
      decisionId: "decision-1",
      decisionRevision: 3,
      decisionDigest: digest("e"),
      approvalRequestId: "approval-1",
      expectedApprovalRevision: 1,
      approvalRequestDigest: digest("f"),
    };
  }
  if (
    [
      "md-prepare-receptor",
      "md-prepare-ligand",
      "md-parameterize-ligand",
      "md-validate-ligand-parameters",
      "md-generate-pose-candidates",
      "md-select-pose",
    ].includes(name)
  ) {
    const componentContract = {
      "md-prepare-receptor": {
        operationKind: "prepare_receptor",
        componentKind: "protein",
        decisionRefs: [
          decision("construct-1", 1, "2", "construct"),
          decision("protonation-1", 1, "3", "protonation"),
        ],
      },
      "md-prepare-ligand": {
        operationKind: "prepare_ligand",
        componentKind: "ligand",
        decisionRefs: [decision("microstate-1", 1, "2", "microstate")],
      },
      "md-parameterize-ligand": {
        operationKind: "parameterize_ligand",
        componentKind: "ligand",
        decisionRefs: [
          decision("microstate-1", 1, "2", "microstate"),
          decision("force-field-1", 1, "3", "force_field_stack"),
        ],
      },
      "md-validate-ligand-parameters": {
        operationKind: "validate_ligand_parameters",
        componentKind: "ligand",
        decisionRefs: [
          decision("microstate-1", 1, "2", "microstate"),
          decision("force-field-1", 1, "3", "force_field_stack"),
        ],
      },
      "md-generate-pose-candidates": {
        operationKind: "generate_pose_candidates",
        componentKind: "ligand",
        decisionRefs: [decision("microstate-1", 1, "2", "microstate")],
      },
      "md-select-pose": {
        operationKind: "select_pose",
        componentKind: "ligand",
        decisionRefs: [decision("microstate-1", 1, "2", "microstate")],
      },
    } as const;
    const contract = componentContract[name as keyof typeof componentContract];
    const poseSpecific =
      name === "md-generate-pose-candidates"
        ? {
            pocketDefinitionRef: exact("pocket-definition-1", 1, "4"),
            poseStrategyRef: exact("pose-strategy-1", 1, "5"),
          }
        : name === "md-select-pose"
          ? {
              poseCandidateSetRef: exact("pose-candidate-set-1", 1, "4"),
              selectedPoseCandidateRef: exact("pose-candidate-1", 1, "5"),
              poseDecisionRef: decision("pose-decision-1", 1, "6", "pose"),
            }
          : {};
    return {
      operationKind: contract.operationKind,
      componentKind: contract.componentKind,
      systemManifestId: "system-1",
      systemManifestRevision: 3,
      systemManifestDigest: digest("f"),
      componentId: "component-1",
      componentRevision: 1,
      componentDigest: digest("1"),
      decisionRefs: contract.decisionRefs,
      inputArtifactRefs: [evidence("component-input", "1")],
      parameterManifestId: "parameters-1",
      parameterManifestRevision: 1,
      parameterManifestDigest: digest("3"),
      ...poseSpecific,
    };
  }
  if (
    name === "md-orient-membrane" ||
    name === "md-build-membrane-system" ||
    name === "md-solvate-ionize" ||
    name === "md-build-amber-topology" ||
    name === "md-validate-topology"
  ) {
    const systemContract = {
      "md-orient-membrane": {
        operationKind: "orient_membrane",
        decisionRefs: [decision("membrane-1", 1, "4", "membrane_model")],
      },
      "md-build-membrane-system": {
        operationKind: "build_membrane_system",
        decisionRefs: [
          decision("membrane-1", 1, "4", "membrane_model"),
          decision("force-field-1", 1, "5", "force_field_stack"),
        ],
      },
      "md-solvate-ionize": {
        operationKind: "solvate_ionize",
        decisionRefs: [
          decision("membrane-1", 1, "4", "membrane_model"),
          decision("force-field-1", 1, "5", "force_field_stack"),
        ],
      },
      "md-build-amber-topology": {
        operationKind: "build_amber_topology",
        decisionRefs: [decision("force-field-1", 1, "5", "force_field_stack")],
      },
      "md-validate-topology": {
        operationKind: "validate_topology",
        decisionRefs: [decision("force-field-1", 1, "5", "force_field_stack")],
      },
    } as const;
    const contract = systemContract[name as keyof typeof systemContract];
    return {
      operationKind: contract.operationKind,
      systemManifestId: "system-1",
      systemManifestRevision: 3,
      systemManifestDigest: digest("3"),
      decisionRefs: contract.decisionRefs,
      inputArtifactRefs: [evidence("system-input", "4")],
      parameterManifestId: "parameters-1",
      parameterManifestRevision: 1,
      parameterManifestDigest: digest("5"),
    };
  }
  if (name === "md-render-stage") {
    return {
      ...stage,
      workUnitId: "work-unit-1",
      workUnitRevision: 1,
      workUnitDigest: digest("5"),
      executionBindingDigest: digest("6"),
      outputContractDigest: digest("b"),
      environmentSnapshotId: "environment-1",
      environmentDigest: digest("7"),
      environmentBindingDigest: digest("d"),
      rendererContractDigest: digest("8"),
    };
  }
  if (name === "md-submit-stage") {
    const renderPayload = payloadFor("md-render-stage") as ReturnType<typeof payloadFor> & {
      workUnitId: string;
      executionBindingDigest: string;
      outputContractDigest: string;
      environmentSnapshotId: string;
      environmentDigest: string;
      environmentBindingDigest: string;
      rendererContractDigest: string;
      stageId: string;
      stageRevision: number;
      stageDigest: string;
    };
    const operationRequest = {
      schemaVersion: "eigengrid.md-stage-operation-request/v2" as const,
      workUnitId: renderPayload.workUnitId,
      bindingDigest: renderPayload.executionBindingDigest,
      outputContractDigest: renderPayload.outputContractDigest,
      stage: {
        id: renderPayload.stageId,
        revision: renderPayload.stageRevision,
        digest: renderPayload.stageDigest,
      },
      environment: {
        canonicalSnapshotId: renderPayload.environmentSnapshotId,
        canonicalSnapshotDigest: renderPayload.environmentDigest,
        engineEnvironmentDigest: digest("c"),
        bindingVersion: "1.0.0",
        bindingDigest: renderPayload.environmentBindingDigest,
        engine: {
          engine: "amber",
          executable: "sander",
          version: "24",
          buildDigest: digest("e"),
          environmentDigest: digest("c"),
          compatibilityVersion: "2.0.0",
        },
        binaryDigest: digest("e"),
      },
      render: {
        schemaVersion: "eigengrid.amber-canonical-stage-render/v2",
        renderedStageDigest: digest("f"),
        mapperVersion: "2.0.0",
        mapperDigest: renderPayload.rendererContractDigest,
        mdinDigest: digest("1"),
        commandRequestDigest: digest("2"),
      },
      outputs: {
        mappingVersion: "1.0.0",
        mappingDigest: digest("3"),
        bindings: [
          {
            engineRole: "stage.restart",
            canonicalRole: "restart" as const,
            mediaType: "application/vnd.amber.rst7",
            required: true as const,
          },
          {
            engineRole: "stage.trajectory",
            canonicalRole: "trajectory" as const,
            mediaType: "application/x-netcdf",
            required: true as const,
          },
          {
            engineRole: "stage.mdout",
            canonicalRole: "mdout" as const,
            mediaType: "text/plain",
            required: true as const,
          },
          {
            engineRole: "stage.mdinfo",
            canonicalRole: "mdinfo" as const,
            mediaType: "text/plain",
            required: true as const,
          },
        ],
      },
    };
    return {
      ...renderPayload,
      operationRequest,
      operationRequestDigest: digestCanonical(operationRequest),
    };
  }
  if (name === "md-stage-status") {
    return {
      ...stage,
      workUnitId: "work-unit-1",
      workUnitRevision: 1,
      workUnitDigest: digest("4"),
      operationId: "operation-1",
      expectedOperationRevision: 2,
      operationDigest: digest("5"),
      replicaSegment: null,
    };
  }
  if (
    name === "md-reconcile-stage" ||
    name === "md-cancel-stage" ||
    name === "md-resume-stage" ||
    name === "md-collect-stage" ||
    name === "md-stop-after-checkpoint"
  ) {
    return {
      ...stage,
      workUnitId: "work-unit-1",
      workUnitRevision: 1,
      workUnitDigest: digest("4"),
      operationId: "operation-1",
      expectedOperationRevision: 2,
      operationDigest: digest("5"),
    };
  }
  if (name === "md-verify-artifacts") {
    return {
      stageResultId: "result-1",
      stageResultRevision: 3,
      stageResultDigest: digest("b"),
      artifactRefs: [evidence("result-artifact", "c")],
    };
  }
  if (name === "md-create-replica-set") {
    return {
      ...protocol,
      replicaSetId: "replica-set-1",
      replicaSetRevision: 3,
      replicaSetDigest: digest("d"),
      systemManifestId: "system-1",
      systemManifestRevision: 2,
      systemManifestDigest: digest("e"),
      replicaCount: 2,
      seedPolicyDigest: digest("f"),
      decisionRef: decision("decision-replicas-1", 1, "a", "replica_set"),
      initialRestartRefs: [evidence("restart-1", "1"), evidence("restart-2", "2")],
    };
  }
  if (name === "md-extend-production") {
    return {
      replicaSetId: "replica-set-1",
      replicaSetRevision: 3,
      replicaSetDigest: digest("3"),
      extensionTimePs: 5_000,
      convergenceAssessmentId: "convergence-1",
      convergenceAssessmentRevision: 2,
      convergenceAssessmentDigest: digest("4"),
      extensionDecisionId: "extension-decision-1",
      extensionDecisionRevision: 1,
      extensionDecisionDigest: digest("5"),
      extensionDecisionKind: "production_extension",
      approvalRequestId: "approval-extension-1",
      approvalRequestRevision: 1,
      approvalRequestDigest: digest("6"),
    };
  }
  if (name === "md-parse-mdout") {
    return {
      stageResultId: "result-1",
      stageResultRevision: 3,
      stageResultDigest: digest("5"),
      mdoutRef: evidence("mdout-1", "6"),
      mdinfoRef: evidence("mdinfo-1", "7"),
      parserContractDigest: digest("8"),
    };
  }
  if (name === "md-assess-equilibration") {
    return {
      stageResultId: "result-1",
      stageResultRevision: 3,
      stageResultDigest: digest("9"),
      normalizedMetricsRefs: [evidence("metrics-1", "a")],
      acceptanceCriteriaDigest: digest("b"),
      assessorContractDigest: digest("c"),
    };
  }
  if (name === "md-assess-replica-convergence") {
    return {
      replicaSetId: "replica-set-1",
      replicaSetRevision: 3,
      replicaSetDigest: digest("d"),
      metricSeriesRefs: [evidence("metrics-1", "e"), evidence("metrics-2", "f")],
      analysisPlanId: "analysis-plan-1",
      analysisPlanRevision: 1,
      analysisPlanDigest: digest("1"),
    };
  }
  if (name === "md-diagnose-failure") {
    return {
      stageResultId: "result-1",
      stageResultRevision: 3,
      stageResultDigest: digest("2"),
      operationReceiptId: "receipt-1",
      diagnosticArtifactRefs: [evidence("mdout-failed", "3")],
      diagnosticContractDigest: digest("4"),
    };
  }
  if (name === "md-propose-remediation") {
    return {
      diagnosisId: "diagnosis-1",
      diagnosisRevision: 3,
      diagnosisDigest: digest("5"),
      stageId: "stage-1",
      stageRevision: 1,
      stageDigest: digest("6"),
      permittedChangeKinds: ["reduce_timestep"],
    };
  }
  if (name === "md-generate-assessment") {
    return {
      systemManifestId: "system-1",
      systemManifestRevision: 3,
      systemManifestDigest: digest("7"),
      ...protocol,
      stageAssessmentRefs: [evidence("stage-assessment-1", "8")],
      convergenceAssessmentRef: evidence("convergence-1", "9"),
      assessmentContractDigest: digest("a"),
    };
  }
  if (
    name === "md-run-cpptraj-plan" ||
    name === "md-trajectory-qc" ||
    name.startsWith("md-analyze-")
  ) {
    return {
      systemManifestId: "system-1",
      systemManifestRevision: 1,
      systemManifestDigest: digest("a"),
      atomMapRef: evidence("atom-map-1", "b"),
      topologyRef: evidence("topology-1", "c"),
      replicaSetId: "replica-set-1",
      replicaSetRevision: 2,
      replicaSetDigest: digest("d"),
      stageResultRefs: [exact("stage-result-1", 2, "e")],
      trajectorySegmentRefs: [
        {
          ...exact("segment-1", 1, "f"),
          replicaId: "replica-1",
          segmentIndex: 0,
        },
      ],
      trajectoryRefs: [evidence("trajectory-1", "1")],
      analysisPlanId: "analysis-plan-1",
      analysisPlanRevision: 3,
      analysisPlanDigest: digest("2"),
    };
  }
  if (name.startsWith("md-compare-") || name === "md-export-gromacs-parity-system") {
    return {
      leftSubjectId: "amber-system-1",
      leftRevision: 3,
      leftDigest: digest("e"),
      rightSubjectId: "gromacs-system-1",
      rightRevision: 3,
      rightDigest: digest("f"),
      atomMapDigest: digest("1"),
      toleranceManifestDigest: digest("2"),
    };
  }
  return { ...subject, traversal: "complete", bundleFormat: "manifest" };
}

class RecordingServices implements MdToolServices {
  readonly calls: MdValidatedToolInvocation[] = [];

  async invoke(invocation: MdValidatedToolInvocation): Promise<ToolResult<MdToolOutput>> {
    this.calls.push(invocation);
    const payload = invocation.input.payload as Record<string, unknown>;
    const observedVersions = [
      {
        subjectId: invocation.input.missionId,
        revision: invocation.input.expectedMissionRevision,
        contentDigest: digest("0"),
      },
    ];
    if (
      typeof payload.subjectId === "string" &&
      typeof payload.subjectRevision === "number" &&
      typeof payload.subjectDigest === "string"
    ) {
      observedVersions.push({
        subjectId: payload.subjectId,
        revision: payload.subjectRevision,
        contentDigest: payload.subjectDigest,
      });
    }
    if (invocation.outputKind === "proposal") {
      return {
        ok: true,
        data: {
          schemaVersion: "eigengrid.md-tool-proposal-result/v2",
          requestId: invocation.input.requestId,
          missionId: invocation.input.missionId,
          proposal: {
            id: "proposal-1",
            revision: 1,
            proposalDigest: digest("b"),
            status: "proposed",
            approvalRequired: true,
          },
          evidenceRefs: [...invocation.input.evidenceRefs],
          observedVersions,
          warnings: [],
        },
      };
    }
    if (invocation.outputKind === "read") {
      return {
        ok: true,
        data: {
          schemaVersion: "eigengrid.md-tool-read-result/v2",
          requestId: invocation.input.requestId,
          missionId: invocation.input.missionId,
          status: "completed",
          records: [],
          observedVersions,
          warnings: [],
        },
      };
    }
    return {
      ok: false,
      error: { code: "NOT_WIRED", message: "Effect service is intentionally not wired" },
    };
  }
}

describe("MD progressive tool bundles", () => {
  test("every catalogued tool declares descriptor-owned subject authority", () => {
    for (const descriptor of MdToolCatalog) {
      expect(typeof descriptor.subjectBindings).toBe("function");
      const payload = descriptor.payloadSchema.parse(payloadFor(descriptor.name));
      const subjects = descriptor.subjectBindings(payload);
      expect(Array.isArray(subjects), `${descriptor.name} must return subject bindings`).toBe(true);
      expect(
        subjects.every(
          (subject) =>
            subject.id.length > 0 &&
            Number.isSafeInteger(subject.revision) &&
            subject.revision > 0 &&
            subject.digest.length > 0,
        ),
        `${descriptor.name} must return exact subject identities`,
      ).toBe(true);
    }
  });

  test("catalogs every planned tool exactly once with no deny-listed raw capability", () => {
    expect(MdToolCatalog).toHaveLength(69);
    expect(new Set(MdToolNames).size).toBe(MdToolNames.length);
    expect(new Set(MdToolCatalog.map((tool) => tool.name)).size).toBe(MdToolCatalog.length);
    expect(MdToolNames).not.toContain("md-raw-command" as never);
    expect(MdToolNames).not.toContain("md-execute-shell" as never);
    expect(MdToolNames).not.toContain("md-read-arbitrary-file" as never);
  });

  test("validates a distinct positive and strict negative payload for every catalogued tool", () => {
    for (const descriptor of MdToolCatalog) {
      const payload = payloadFor(descriptor.name);
      const positive = descriptor.payloadSchema.safeParse(payload);
      expect(positive.success, `${descriptor.name} should accept its own payload`).toBe(true);
      expect(
        descriptor.payloadSchema.safeParse({ ...payload, rawCommand: "pmemd -O" }).success,
        `${descriptor.name} must reject unknown command fields`,
      ).toBe(false);
    }

    expect(
      MdToolCatalog.find((tool) => tool.name === "md-import-evidence")!.payloadSchema.safeParse(
        payloadFor("md-import-evidence"),
      ).success,
    ).toBe(true);
    expect(
      "systemManifestId" in payloadFor("md-import-evidence"),
      "evidence import must not require a pre-existing system",
    ).toBe(false);
    expect("replicaSetDigest" in payloadFor("md-create-replica-set")).toBe(true);
    expect("trajectoryRefs" in payloadFor("md-parse-mdout")).toBe(false);
    expect("analysisPlanId" in payloadFor("md-diagnose-failure")).toBe(false);
  });

  test("shares the canonical acquisition targets and makes cache_only content-addressed", () => {
    const pdbSchema = MdToolCatalog.find(
      (tool) => tool.name === "md-fetch-pdb-entry",
    )!.payloadSchema;
    const pubChemSchema = MdToolCatalog.find(
      (tool) => tool.name === "md-fetch-pubchem-compound",
    )!.payloadSchema;

    for (const pdbId of ["1ABC", "1ABC"]) {
      expect(
        pdbSchema.safeParse({
          pdbId,
          format: "mmcif",
          cachePolicy: "cache_only",
          expectedContentDigest: digest("1"),
        }).success,
      ).toBe(true);
    }
    for (const cid of [1, 9999]) {
      expect(
        pubChemSchema.safeParse({
          cid,
          format: "json",
          cachePolicy: "cache_only",
          expectedContentDigest: digest("2"),
        }).success,
      ).toBe(true);
    }
    expect(
      pdbSchema.safeParse({ pdbId: "1ABC", format: "pdb", cachePolicy: "refresh" }).success,
    ).toBe(true);
    expect(
      pubChemSchema.safeParse({ cid: 9999, format: "sdf", cachePolicy: "refresh" }).success,
    ).toBe(true);
    expect(
      pdbSchema.safeParse({ pdbId: "1ABC", format: "pdb", cachePolicy: "cache_only" }).success,
    ).toBe(false);
    expect(
      pubChemSchema.safeParse({ cid: 4, format: "sdf", cachePolicy: "cache_only" }).success,
    ).toBe(false);
    expect(pubChemSchema.safeParse({ cid: 4, format: "sdf", cachePolicy: "bypass" }).success).toBe(
      false,
    );
  });

  test("uses distinct preparation contracts with exact typed decisions", () => {
    const approveConstruct = MdToolCatalog.find(
      (tool) => tool.name === "md-approve-construct-policy",
    )!.payloadSchema;
    expect(approveConstruct.safeParse(payloadFor("md-approve-construct-policy")).success).toBe(
      true,
    );
    expect(
      approveConstruct.safeParse({
        ...payloadFor("md-approve-construct-policy"),
        decisionKind: "microstate",
      }).success,
    ).toBe(false);

    const parameterize = MdToolCatalog.find(
      (tool) => tool.name === "md-parameterize-ligand",
    )!.payloadSchema;
    const parameterizationPayload = payloadFor("md-parameterize-ligand");
    expect(parameterize.safeParse(parameterizationPayload).success).toBe(true);
    expect(
      parameterize.safeParse({
        ...parameterizationPayload,
        operationKind: "prepare_ligand",
      }).success,
    ).toBe(false);
    expect(
      parameterize.safeParse({
        ...parameterizationPayload,
        decisionRefs: [decision("microstate-1", 1, "2", "microstate")],
      }).success,
    ).toBe(false);
    expect(
      parameterize.safeParse({
        ...parameterizationPayload,
        decisionRefs: ["microstate-1", "force-field-1"],
      }).success,
    ).toBe(false);
    const firstDecision = (parameterizationPayload.decisionRefs as Record<string, unknown>[])[0]!;
    const { approvalRequestDigest: _approvalDigest, ...decisionWithoutApprovalDigest } =
      firstDecision;
    expect(
      parameterize.safeParse({
        ...parameterizationPayload,
        decisionRefs: [
          decisionWithoutApprovalDigest,
          ...(parameterizationPayload.decisionRefs as unknown[]).slice(1),
        ],
      }).success,
    ).toBe(false);

    const generatePoseCandidates = MdToolCatalog.find(
      (tool) => tool.name === "md-generate-pose-candidates",
    )!.payloadSchema;
    const generationPayload = payloadFor("md-generate-pose-candidates");
    expect(generatePoseCandidates.safeParse(generationPayload).success).toBe(true);
    expect(
      (generationPayload.decisionRefs as Record<string, unknown>[]).some(
        (reference) => reference.kind === "pose",
      ),
    ).toBe(false);
    const { poseStrategyRef: _poseStrategy, ...generationWithoutStrategy } = generationPayload;
    expect(generatePoseCandidates.safeParse(generationWithoutStrategy).success).toBe(false);

    const selectPose = MdToolCatalog.find((tool) => tool.name === "md-select-pose")!.payloadSchema;
    const selectionPayload = payloadFor("md-select-pose");
    expect(selectPose.safeParse(selectionPayload).success).toBe(true);
    const { poseCandidateSetRef: _candidateSet, ...selectionWithoutCandidateSet } =
      selectionPayload;
    expect(selectPose.safeParse(selectionWithoutCandidateSet).success).toBe(false);
    const poseDecisionRef = selectionPayload.poseDecisionRef as Record<string, unknown>;
    const { approvalRequestDigest: _poseApprovalDigest, ...unapprovedPoseDecision } =
      poseDecisionRef;
    expect(
      selectPose.safeParse({
        ...selectionPayload,
        poseDecisionRef: unapprovedPoseDecision,
      }).success,
    ).toBe(false);
  });

  test("requires unambiguous stage status, extension, and analysis identities", () => {
    const statusSchema = MdToolCatalog.find(
      (tool) => tool.name === "md-stage-status",
    )!.payloadSchema;
    const status = payloadFor("md-stage-status");
    expect(statusSchema.safeParse(status).success).toBe(true);
    const { operationId: _operationId, ...statusWithoutOperation } = status;
    expect(statusSchema.safeParse(statusWithoutOperation).success).toBe(false);
    expect(
      statusSchema.safeParse({
        ...status,
        replicaSegment: {
          replicaSetId: "replica-set-1",
          replicaSetRevision: 2,
          replicaSetDigest: digest("6"),
          replicaId: "replica-1",
          segmentIndex: 0,
        },
      }).success,
    ).toBe(false);

    const extensionSchema = MdToolCatalog.find(
      (tool) => tool.name === "md-extend-production",
    )!.payloadSchema;
    const extension = payloadFor("md-extend-production");
    expect(extensionSchema.safeParse(extension).success).toBe(true);
    const { extensionDecisionRevision: _decisionRevision, ...inexactExtension } = extension;
    expect(extensionSchema.safeParse(inexactExtension).success).toBe(false);

    const analysisSchema = MdToolCatalog.find(
      (tool) => tool.name === "md-trajectory-qc",
    )!.payloadSchema;
    const analysis = payloadFor("md-trajectory-qc");
    expect(analysisSchema.safeParse(analysis).success).toBe(true);
    const { systemManifestDigest: _manifestDigest, ...analysisWithoutManifestDigest } = analysis;
    expect(analysisSchema.safeParse(analysisWithoutManifestDigest).success).toBe(false);
    expect(analysisSchema.safeParse({ ...analysis, stageResultRefs: [] }).success).toBe(false);
    expect(analysisSchema.safeParse({ ...analysis, trajectorySegmentRefs: [] }).success).toBe(
      false,
    );
  });

  test("submits only an exact command-free v2 stage authorization", () => {
    const schema = MdToolCatalog.find((tool) => tool.name === "md-submit-stage")!.payloadSchema;
    const payload = payloadFor("md-submit-stage");
    expect(schema.safeParse(payload).success).toBe(true);
    expect(schema.safeParse({ ...payload, renderManifestDigest: digest("9") }).success).toBe(false);
    expect(
      schema.safeParse({
        ...payload,
        operationRequestDigest: digest("0"),
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...payload,
        operationRequest: {
          ...(payload.operationRequest as Record<string, unknown>),
          argv: ["-i", "stage.mdin"],
        },
      }).success,
    ).toBe(false);
  });

  test("enforces the receipt status and effect-stage transition matrix", () => {
    const baseReceipt = {
      schemaVersion: "eigengrid.md-tool-receipt/v2",
      requestId: "request-1",
      missionId: "mission-1",
      operationId: "operation-1",
      requestDigest: digest("1"),
      correlationId: "correlation-1",
      artifactRefs: [],
      observedVersions: [{ subjectId: "mission-1", revision: 1, contentDigest: digest("2") }],
      recordedAt: "2026-08-23T12:00:00.000Z",
    };
    const allowed = {
      intent: ["intent_recorded"],
      acknowledged: ["acknowledged", "receipt_recorded"],
      confirmed: ["receipt_recorded", "reconciled"],
      failed: [
        "intent_recorded",
        "effect_started",
        "acknowledged",
        "receipt_recorded",
        "reconciled",
      ],
      ambiguous: ["effect_started", "acknowledged", "receipt_recorded", "reconciled"],
    } as const;
    const allEffects = [
      "intent_recorded",
      "effect_started",
      "acknowledged",
      "receipt_recorded",
      "reconciled",
    ] as const;

    for (const [status, allowedEffects] of Object.entries(allowed)) {
      for (const effectStage of allEffects) {
        expect(
          MdOperationReceiptSchema.safeParse({ ...baseReceipt, status, effectStage }).success,
          `${status}/${effectStage}`,
        ).toBe((allowedEffects as readonly string[]).includes(effectStage));
      }
    }
  });

  test("rejects misbound subjects from generic read, proposal, and analysis outputs", () => {
    const missionVersion = {
      subjectId: "mission-1",
      revision: 7,
      contentDigest: digest("0"),
    };
    const subjectVersion = {
      subjectId: "subject-1",
      revision: 3,
      contentDigest: digest("1"),
    };

    const readInput = envelope(
      payloadFor("md-get-provenance"),
    ) as MdValidatedToolInvocation["input"];
    const readInvocation: MdValidatedToolInvocation = {
      name: "md-get-provenance",
      outputKind: "read",
      requestDigest: digestCanonical(readInput),
      input: readInput,
    };
    const readResult = {
      schemaVersion: "eigengrid.md-tool-read-result/v2" as const,
      requestId: readInput.requestId,
      missionId: readInput.missionId,
      status: "completed" as const,
      records: [],
      observedVersions: [missionVersion, subjectVersion],
      warnings: [],
    };
    expect(validateMdToolServiceResult(readInvocation, { ok: true, data: readResult }).ok).toBe(
      true,
    );
    expect(
      validateMdToolServiceResult(readInvocation, {
        ok: true,
        data: { ...readResult, observedVersions: [missionVersion] },
      }).error?.code,
    ).toBe("SERVICE_CONTRACT_VIOLATION");

    const proposalInput = envelope(
      payloadFor("md-propose-construct-policy"),
    ) as MdValidatedToolInvocation["input"];
    const proposalInvocation: MdValidatedToolInvocation = {
      name: "md-propose-construct-policy",
      outputKind: "proposal",
      requestDigest: digestCanonical(proposalInput),
      input: proposalInput,
    };
    const proposalResult = {
      schemaVersion: "eigengrid.md-tool-proposal-result/v2" as const,
      requestId: proposalInput.requestId,
      missionId: proposalInput.missionId,
      proposal: {
        id: "proposal-1",
        revision: 1,
        proposalDigest: digest("2"),
        status: "proposed" as const,
        approvalRequired: true as const,
      },
      evidenceRefs: [...proposalInput.evidenceRefs],
      observedVersions: [missionVersion, subjectVersion],
      warnings: [],
    };
    expect(
      validateMdToolServiceResult(proposalInvocation, { ok: true, data: proposalResult }).ok,
    ).toBe(true);
    expect(
      validateMdToolServiceResult(proposalInvocation, {
        ok: true,
        data: { ...proposalResult, observedVersions: [missionVersion] },
      }).error?.code,
    ).toBe("SERVICE_CONTRACT_VIOLATION");

    const analysisPayload = payloadFor("md-trajectory-qc");
    const trajectoryRefs = analysisPayload.trajectoryRefs as {
      id: string;
      contentDigest: string;
    }[];
    const analysisEvidence = [
      analysisPayload.atomMapRef,
      analysisPayload.topologyRef,
      ...trajectoryRefs,
    ] as MdValidatedToolInvocation["input"]["evidenceRefs"];
    const analysisInput = {
      ...envelope(analysisPayload),
      evidenceRefs: analysisEvidence,
    } as MdValidatedToolInvocation["input"];
    const analysisInvocation: MdValidatedToolInvocation = {
      name: "md-trajectory-qc",
      outputKind: "analysis",
      requestDigest: digestCanonical(analysisInput),
      input: analysisInput,
    };
    const segment = (analysisPayload.trajectorySegmentRefs as ReturnType<typeof exact>[])[0]!;
    const analysisObservedVersions = [
      missionVersion,
      observed(exact("analysis-plan-1", 3, "2")),
      observed(exact("system-1", 1, "a")),
      observed(exact("replica-set-1", 2, "d")),
      observed(exact("stage-result-1", 2, "e")),
      observed(segment),
    ];
    const analysisResult = {
      schemaVersion: "eigengrid.md-tool-analysis-result/v2" as const,
      requestId: analysisInput.requestId,
      missionId: analysisInput.missionId,
      analysisRef: {
        id: "trajectory-qc-1",
        kind: "trajectory_qc",
        revision: 1,
        contentDigest: digest("3"),
        summary: "Exact trajectory QC",
      },
      sourceArtifactRefs: [trajectoryRefs[0]!],
      observedVersions: analysisObservedVersions,
      validationStatus: "passed" as const,
      warnings: [],
    };
    expect(
      validateMdToolServiceResult(analysisInvocation, { ok: true, data: analysisResult }).ok,
    ).toBe(true);
    expect(
      validateMdToolServiceResult(analysisInvocation, {
        ok: true,
        data: {
          ...analysisResult,
          observedVersions: analysisObservedVersions.filter(
            (version) => version.subjectId !== segment.id,
          ),
        },
      }).error?.code,
    ).toBe("SERVICE_CONTRACT_VIOLATION");
  });

  test("materializes only one phase and separates allow definitions from ask metadata", () => {
    const services = new RecordingServices();
    const discovery = materializeMdToolBundle("discovery", services);

    expect(discovery.toolNames).toHaveLength(12);
    expect(discovery.definitions.map((tool) => tool.name).sort()).toEqual(
      discovery.toolNames
        .filter((name) => !name.startsWith("md-fetch-"))
        .slice()
        .sort(),
    );
    expect(discovery.approvalRequiredDefinitions.map((tool) => tool.name).sort()).toEqual([
      "md-fetch-pdb-entry",
      "md-fetch-pubchem-compound",
    ]);
    expect(discovery.toolNames.some((name) => name === "md-submit-stage")).toBe(false);
    expect(Object.isFrozen(discovery)).toBe(true);
    expect(Object.isFrozen(discovery.toolNames)).toBe(true);
    expect(Object.isFrozen(discovery.definitions[0])).toBe(true);
  });

  test("ask tools cannot settle from an unapproved phase snapshot", async () => {
    const services = new RecordingServices();
    const preparation = materializeMdToolBundle("preparation", services);

    expect(preparation.definitions).toHaveLength(0);
    expect(preparation.approvalRequiredDefinitions).toHaveLength(15);
    const result = await preparation.settle(
      {
        id: "call-1",
        name: "md-parameterize-ligand",
        input: envelope(payloadFor("md-parameterize-ligand")),
      },
      context,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TOOL_NOT_FOUND");
    expect(services.calls).toHaveLength(0);
  });

  test("strict per-tool payload schemas reject a raw command before service invocation", async () => {
    const services = new RecordingServices();
    const planning = materializeMdToolBundle("planning", services);
    const result = await planning.settle(
      {
        id: "call-1",
        name: "md-propose-construct-policy",
        input: envelope({
          subjectId: "system-1",
          subjectRevision: 3,
          subjectDigest: digest("f"),
          decisionKind: "construct",
          constraintRefs: [],
          rawCommand: "tleap -f input.leap",
        }),
      },
      context,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
    expect(services.calls).toHaveLength(0);
  });

  test("a valid planning request reaches only the injected typed mission service", async () => {
    const services = new RecordingServices();
    const planning = materializeMdToolBundle("planning", services);
    const result = await planning.settle(
      {
        id: "call-1",
        name: "md-propose-construct-policy",
        input: envelope({
          subjectId: "system-1",
          subjectRevision: 3,
          subjectDigest: digest("f"),
          decisionKind: "construct",
          constraintRefs: [],
        }),
      },
      context,
    );

    expect(result.ok).toBe(true);
    expect(services.calls).toHaveLength(1);
    expect(services.calls[0]!.name).toBe("md-propose-construct-policy");
    expect(services.calls[0]!.input.expectedMissionRevision).toBe(7);
    expect(services.calls[0]!.requestDigest).toBe(digestCanonical(services.calls[0]!.input));
  });

  test("rejects a stale envelope revision before invoking the mission service", async () => {
    const services = new RecordingServices();
    const planning = materializeMdToolBundle("planning", services);
    const result = await planning.settle(
      {
        id: "call-stale",
        name: "md-propose-construct-policy",
        input: envelope({
          subjectId: "system-1",
          subjectRevision: 2,
          subjectDigest: digest("f"),
          decisionKind: "construct",
          constraintRefs: [],
        }),
      },
      context,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
    expect(services.calls).toHaveLength(0);
  });

  test("rejects receipts that lie about request digest or observed exact revisions", () => {
    const input = {
      ...envelope(payloadFor("md-import-evidence")),
      expectedSubjectRevision: 1,
      evidenceRefs: [],
    } as MdValidatedToolInvocation["input"];
    const invocation: MdValidatedToolInvocation = {
      name: "md-import-evidence",
      outputKind: "receipt",
      requestDigest: digestCanonical(input),
      input,
    };
    const receipt = {
      schemaVersion: "eigengrid.md-tool-receipt/v2" as const,
      requestId: input.requestId,
      missionId: input.missionId,
      operationId: "operation-import-1",
      requestDigest: invocation.requestDigest,
      status: "confirmed" as const,
      effectStage: "receipt_recorded" as const,
      correlationId: "correlation-import-1",
      artifactRefs: [evidence("evidence-new-1", "8")],
      observedVersions: [
        { subjectId: input.missionId, revision: 7, contentDigest: digest("7") },
        { subjectId: "evidence-new-1", revision: 1, contentDigest: digest("8") },
      ],
      recordedAt: "2026-08-23T12:00:00.000Z",
    };
    expect(validateMdToolServiceResult(invocation, { ok: true, data: receipt }).ok).toBe(true);
    expect(
      validateMdToolServiceResult(invocation, {
        ok: true,
        data: { ...receipt, requestDigest: digest("0") },
      }).error?.code,
    ).toBe("SERVICE_CONTRACT_VIOLATION");
    expect(
      validateMdToolServiceResult(invocation, {
        ok: true,
        data: {
          ...receipt,
          observedVersions: receipt.observedVersions.map((version) =>
            version.subjectId === "evidence-new-1" ? { ...version, revision: 2 } : version,
          ),
        },
      }).error?.code,
    ).toBe("SERVICE_CONTRACT_VIOLATION");
  });

  test("rejects a receipt for the wrong operation or any omitted exact subject", () => {
    const input = {
      ...envelope(payloadFor("md-cancel-stage")),
      expectedSubjectRevision: 3,
      evidenceRefs: [],
    } as MdValidatedToolInvocation["input"];
    const invocation: MdValidatedToolInvocation = {
      name: "md-cancel-stage",
      outputKind: "receipt",
      requestDigest: digestCanonical(input),
      input,
    };
    const observedVersions = [
      { subjectId: input.missionId, revision: 7, contentDigest: digest("7") },
      { subjectId: "stage-1", revision: 3, contentDigest: digest("3") },
      { subjectId: "protocol-1", revision: 3, contentDigest: digest("2") },
      { subjectId: "work-unit-1", revision: 1, contentDigest: digest("4") },
      { subjectId: "operation-1", revision: 2, contentDigest: digest("5") },
    ];
    const receipt = {
      schemaVersion: "eigengrid.md-tool-receipt/v2" as const,
      requestId: input.requestId,
      missionId: input.missionId,
      operationId: "operation-1",
      requestDigest: invocation.requestDigest,
      status: "confirmed" as const,
      effectStage: "receipt_recorded" as const,
      correlationId: "correlation-cancel-1",
      artifactRefs: [],
      observedVersions,
      recordedAt: "2026-08-23T12:00:00.000Z",
    };

    expect(validateMdToolServiceResult(invocation, { ok: true, data: receipt }).ok).toBe(true);
    expect(
      validateMdToolServiceResult(invocation, {
        ok: true,
        data: { ...receipt, operationId: "operation-other" },
      }).error?.code,
    ).toBe("SERVICE_CONTRACT_VIOLATION");
    for (const requiredSubjectId of ["stage-1", "protocol-1", "work-unit-1", "operation-1"]) {
      expect(
        validateMdToolServiceResult(invocation, {
          ok: true,
          data: {
            ...receipt,
            observedVersions: observedVersions.filter(
              (version) => version.subjectId !== requiredSubjectId,
            ),
          },
        }).error?.code,
        requiredSubjectId,
      ).toBe("SERVICE_CONTRACT_VIOLATION");
    }
    expect(
      validateMdToolServiceResult(invocation, {
        ok: true,
        data: { ...receipt, status: "confirmed", effectStage: "intent_recorded" },
      }).error?.code,
    ).toBe("SERVICE_CONTRACT_VIOLATION");
  });

  test("requires stage status to return every exact queried execution subject", () => {
    const input = {
      ...envelope(payloadFor("md-stage-status")),
      expectedSubjectRevision: 3,
      evidenceRefs: [],
    } as MdValidatedToolInvocation["input"];
    const invocation: MdValidatedToolInvocation = {
      name: "md-stage-status",
      outputKind: "read",
      requestDigest: digestCanonical(input),
      input,
    };
    const records = [
      { ...exact("stage-1", 3, "3"), kind: "md_stage", summary: "Exact stage" },
      { ...exact("protocol-1", 3, "2"), kind: "md_protocol", summary: "Exact protocol" },
      { ...exact("work-unit-1", 1, "4"), kind: "work_unit", summary: "Exact work unit" },
      { ...exact("operation-1", 2, "5"), kind: "operation", summary: "Exact operation" },
    ];
    const result = {
      schemaVersion: "eigengrid.md-tool-read-result/v2" as const,
      requestId: input.requestId,
      missionId: input.missionId,
      status: "completed" as const,
      records,
      observedVersions: [
        { subjectId: input.missionId, revision: 7, contentDigest: digest("7") },
        ...records.map((record) => ({
          subjectId: record.id,
          revision: record.revision,
          contentDigest: record.contentDigest,
        })),
      ],
      warnings: [],
    };

    expect(validateMdToolServiceResult(invocation, { ok: true, data: result }).ok).toBe(true);
    expect(
      validateMdToolServiceResult(invocation, {
        ok: true,
        data: { ...result, records: records.filter((record) => record.id !== "work-unit-1") },
      }).error?.code,
    ).toBe("SERVICE_CONTRACT_VIOLATION");
  });

  test("execution exposes status and verification but gates render, submit, cancel and resume", () => {
    const snapshot = materializeMdToolBundle("execution", new RecordingServices());
    expect(snapshot.definitions.map((tool) => tool.name).sort()).toEqual([
      "md-stage-status",
      "md-verify-artifacts",
    ]);
    expect(snapshot.approvalRequiredDefinitions.map((tool) => tool.name)).toContain(
      "md-submit-stage",
    );
    expect(snapshot.approvalRequiredDefinitions.map((tool) => tool.name)).toContain(
      "md-cancel-stage",
    );
    expect(snapshot.approvalRequiredDefinitions.map((tool) => tool.name)).toContain(
      "md-extend-production",
    );
  });

  test("the same bundle and schemas produce the same frozen snapshot digest", () => {
    const first = materializeMdToolBundle("analysis", new RecordingServices());
    const second = materializeMdToolBundle("analysis", new RecordingServices());
    expect(first.snapshotDigest).toBe(second.snapshotDigest);
    expect(first.snapshotDigest).toMatch(/^[a-f0-9]{64}$/u);
  });
});
