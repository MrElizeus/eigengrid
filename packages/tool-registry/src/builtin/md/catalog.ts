import { z } from "zod";
import type { PermissionEffect } from "../../types";
import {
  ArtifactVerificationPayloadSchema,
  ComparisonPayloadSchema,
  DecisionApprovalPayloadSchema,
  EmptyPayloadSchema,
  EvidenceImportPayloadSchema,
  FailureDiagnosisPayloadSchema,
  MdComponentPreparationPayloadObjectSchema,
  MdExactSubjectReferenceSchema,
  MdoutParsePayloadSchema,
  MdPoseDecisionReferenceSchema,
  MdSystemPreparationPayloadObjectSchema,
  PdbFetchPayloadSchema,
  ProposalPayloadSchema,
  ProductionExtensionPayloadSchema,
  ProtocolDiffPayloadSchema,
  ProtocolPayloadSchema,
  ProvenancePayloadSchema,
  PubChemFetchPayloadSchema,
  RemediationProposalPayloadSchema,
  ReplicaConvergencePayloadSchema,
  ReplicaSetCreatePayloadSchema,
  ScientificAssessmentPayloadSchema,
  StageAssessmentPayloadSchema,
  StageOperationPayloadSchema,
  StageRenderPayloadSchema,
  StageStatusPayloadSchema,
  StageSubmissionPayloadSchema,
  SubjectPayloadSchema,
  SystemManifestCreatePayloadSchema,
  TrajectoryAnalysisPayloadSchema,
  type MdToolOutputKind,
  type MdToolPayload,
} from "./contracts";
import {
  assessmentBindings,
  comparisonBindings,
  componentPreparationBindings,
  decisionApprovalBindings,
  evidenceBindings,
  noSubjectBindings,
  planningBindings,
  productionExtensionBindings,
  protocolDiffBindings,
  provenanceBindings,
  remediationBindings,
  replicaAnalysisBindings,
  replicaSetBindings,
  singleSubjectBindings,
  stageExecutionBindings,
  stageOperationBindings,
  stageResultBindings,
  stageStatusBindings,
  systemManifestBindings,
  systemPreparationBindings,
  trajectoryAnalysisBindings,
  type MdToolSubject,
  type MdToolSubjectBindings,
} from "./subject-bindings";

export const MdToolBundleSchema = z.enum([
  "discovery",
  "planning",
  "preparation",
  "execution",
  "analysis",
  "comparison",
  "provenance",
]);
export type MdToolBundle = z.infer<typeof MdToolBundleSchema>;

const discoveryNames = [
  "md-list-capabilities",
  "md-inspect-environment",
  "md-fetch-pdb-entry",
  "md-fetch-pubchem-compound",
  "md-inspect-structure",
  "md-inspect-construct",
  "md-inspect-missing-residues",
  "md-inspect-mutations-fusions",
  "md-inspect-ligand-identity",
  "md-enumerate-microstates",
  "md-inspect-force-field-stack",
  "md-inspect-system-manifest",
] as const;

const planningNames = [
  "md-propose-construct-policy",
  "md-propose-protonation-plan",
  "md-propose-ligand-state",
  "md-propose-pose-strategy",
  "md-propose-force-field-stack",
  "md-propose-membrane-model",
  "md-compile-amber-workflow",
  "md-estimate-resources",
  "md-diff-protocol-revisions",
  "md-critic-review-plan",
] as const;

const preparationNames = [
  "md-import-evidence",
  "md-create-system-manifest",
  "md-approve-construct-policy",
  "md-approve-ligand-state",
  "md-prepare-receptor",
  "md-prepare-ligand",
  "md-parameterize-ligand",
  "md-validate-ligand-parameters",
  "md-generate-pose-candidates",
  "md-select-pose",
  "md-orient-membrane",
  "md-build-membrane-system",
  "md-solvate-ionize",
  "md-build-amber-topology",
  "md-validate-topology",
] as const;

const executionNames = [
  "md-render-stage",
  "md-submit-stage",
  "md-stage-status",
  "md-reconcile-stage",
  "md-cancel-stage",
  "md-resume-stage",
  "md-collect-stage",
  "md-verify-artifacts",
  "md-create-replica-set",
  "md-extend-production",
  "md-stop-after-checkpoint",
] as const;

const analysisNames = [
  "md-parse-mdout",
  "md-run-cpptraj-plan",
  "md-trajectory-qc",
  "md-assess-equilibration",
  "md-analyze-ligand-stability",
  "md-analyze-pocket-interactions",
  "md-analyze-membrane",
  "md-assess-replica-convergence",
  "md-diagnose-failure",
  "md-propose-remediation",
  "md-generate-assessment",
] as const;

const comparisonNames = [
  "md-export-gromacs-parity-system",
  "md-compare-topologies",
  "md-compare-single-point-energies",
  "md-compare-protocols",
  "md-compare-ensemble-results",
] as const;

const provenanceNames = [
  "md-get-provenance",
  "md-verify-provenance",
  "md-export-reproducibility-bundle",
  "md-verify-reproducibility-bundle",
  "md-release-check",
] as const;

export const MdToolNames = [
  ...discoveryNames,
  ...planningNames,
  ...preparationNames,
  ...executionNames,
  ...analysisNames,
  ...comparisonNames,
  ...provenanceNames,
] as const;
export type MdToolName = (typeof MdToolNames)[number];

export interface MdToolDescriptor {
  readonly name: MdToolName;
  readonly bundle: MdToolBundle;
  readonly permission: PermissionEffect;
  readonly outputKind: MdToolOutputKind;
  readonly payloadSchema: z.ZodTypeAny;
  readonly subjectBindings: (payload: MdToolPayload) => readonly MdToolSubject[];
  readonly description: string;
}

function humanize(name: MdToolName): string {
  return name.slice(3).split("-").join(" ");
}

function descriptor(input: {
  readonly name: MdToolName;
  readonly bundle: MdToolBundle;
  readonly permission: PermissionEffect;
  readonly outputKind: MdToolOutputKind;
  readonly payloadSchema: z.ZodTypeAny;
  readonly subjectBindings: MdToolSubjectBindings;
}): MdToolDescriptor {
  return Object.freeze({
    ...input,
    description: `Typed MD ${humanize(input.name)} capability. Requires exact mission and subject revisions; it never accepts raw commands or arbitrary paths.`,
  });
}

const componentPreparationContracts = {
  "md-prepare-receptor": {
    operationKind: "prepare_receptor",
    componentKind: "protein",
    requiredDecisionKinds: ["construct", "protonation"],
  },
  "md-prepare-ligand": {
    operationKind: "prepare_ligand",
    componentKind: "ligand",
    requiredDecisionKinds: ["microstate"],
  },
  "md-parameterize-ligand": {
    operationKind: "parameterize_ligand",
    componentKind: "ligand",
    requiredDecisionKinds: ["microstate", "force_field_stack"],
  },
  "md-validate-ligand-parameters": {
    operationKind: "validate_ligand_parameters",
    componentKind: "ligand",
    requiredDecisionKinds: ["microstate", "force_field_stack"],
  },
  "md-generate-pose-candidates": {
    operationKind: "generate_pose_candidates",
    componentKind: "ligand",
    requiredDecisionKinds: ["microstate"],
  },
  "md-select-pose": {
    operationKind: "select_pose",
    componentKind: "ligand",
    requiredDecisionKinds: ["microstate"],
  },
} as const;

type ComponentPreparationToolName = keyof typeof componentPreparationContracts;

function componentPreparationSchema(name: ComponentPreparationToolName): z.ZodTypeAny {
  const contract = componentPreparationContracts[name];
  let schema: z.AnyZodObject = MdComponentPreparationPayloadObjectSchema.extend({
    operationKind: z.literal(contract.operationKind),
    componentKind: z.literal(contract.componentKind),
  }).strict();
  if (name === "md-generate-pose-candidates") {
    schema = schema
      .extend({
        pocketDefinitionRef: MdExactSubjectReferenceSchema,
        poseStrategyRef: MdExactSubjectReferenceSchema,
      })
      .strict();
  }
  if (name === "md-select-pose") {
    schema = schema
      .extend({
        poseCandidateSetRef: MdExactSubjectReferenceSchema,
        selectedPoseCandidateRef: MdExactSubjectReferenceSchema,
        poseDecisionRef: MdPoseDecisionReferenceSchema,
      })
      .strict();
  }
  return schema.strict().superRefine((payload, context) => {
    const decisionIds = payload.decisionRefs.map(
      (decision: { readonly id: string }) => decision.id,
    );
    if (new Set(decisionIds).size !== decisionIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decisionRefs"],
        message: "Exact decision references must be unique by id",
      });
    }
    const observedKinds = new Set(
      payload.decisionRefs.map((decision: { readonly kind: string }) => decision.kind),
    );
    for (const requiredKind of contract.requiredDecisionKinds) {
      if (!observedKinds.has(requiredKind)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["decisionRefs"],
          message: `${name} requires an exact ${requiredKind} decision reference`,
        });
      }
    }
  });
}

const systemPreparationContracts = {
  "md-orient-membrane": {
    operationKind: "orient_membrane",
    requiredDecisionKinds: ["membrane_model"],
  },
  "md-build-membrane-system": {
    operationKind: "build_membrane_system",
    requiredDecisionKinds: ["membrane_model", "force_field_stack"],
  },
  "md-solvate-ionize": {
    operationKind: "solvate_ionize",
    requiredDecisionKinds: ["membrane_model", "force_field_stack"],
  },
  "md-build-amber-topology": {
    operationKind: "build_amber_topology",
    requiredDecisionKinds: ["force_field_stack"],
  },
  "md-validate-topology": {
    operationKind: "validate_topology",
    requiredDecisionKinds: ["force_field_stack"],
  },
} as const;

type SystemPreparationToolName = keyof typeof systemPreparationContracts;

function systemPreparationSchema(name: SystemPreparationToolName): z.ZodTypeAny {
  const contract = systemPreparationContracts[name];
  return MdSystemPreparationPayloadObjectSchema.extend({
    operationKind: z.literal(contract.operationKind),
  })
    .strict()
    .superRefine((payload, context) => {
      const decisionIds = payload.decisionRefs.map(
        (decision: { readonly id: string }) => decision.id,
      );
      if (new Set(decisionIds).size !== decisionIds.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["decisionRefs"],
          message: "Exact decision references must be unique by id",
        });
      }
      const observedKinds = new Set(
        payload.decisionRefs.map((decision: { readonly kind: string }) => decision.kind),
      );
      for (const requiredKind of contract.requiredDecisionKinds) {
        if (!observedKinds.has(requiredKind)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["decisionRefs"],
            message: `${name} requires an exact ${requiredKind} decision reference`,
          });
        }
      }
    });
}

const descriptors: MdToolDescriptor[] = [];

for (const name of discoveryNames) {
  const payloadSchema =
    name === "md-list-capabilities" || name === "md-inspect-environment"
      ? EmptyPayloadSchema
      : name === "md-fetch-pdb-entry"
        ? PdbFetchPayloadSchema
        : name === "md-fetch-pubchem-compound"
          ? PubChemFetchPayloadSchema
          : SubjectPayloadSchema;
  const permission = name.startsWith("md-fetch-") ? "ask" : "allow";
  const subjectBindings =
    name === "md-list-capabilities" ||
    name === "md-inspect-environment" ||
    name === "md-fetch-pdb-entry" ||
    name === "md-fetch-pubchem-compound"
      ? noSubjectBindings
      : singleSubjectBindings;
  descriptors.push(
    descriptor({
      name,
      bundle: "discovery",
      permission,
      outputKind: "read",
      payloadSchema,
      subjectBindings,
    }),
  );
}

for (const name of planningNames) {
  const proposalKind = {
    "md-propose-construct-policy": "construct",
    "md-propose-protonation-plan": "protonation",
    "md-propose-ligand-state": "microstate",
    "md-propose-pose-strategy": "pose",
    "md-propose-force-field-stack": "force_field_stack",
    "md-propose-membrane-model": "membrane_model",
  } as const;
  const payloadSchema =
    name === "md-diff-protocol-revisions"
      ? ProtocolDiffPayloadSchema
      : name === "md-compile-amber-workflow" ||
          name === "md-estimate-resources" ||
          name === "md-critic-review-plan"
        ? ProtocolPayloadSchema
        : ProposalPayloadSchema.extend({ decisionKind: z.literal(proposalKind[name]) }).strict();
  const readOnly = [
    "md-estimate-resources",
    "md-diff-protocol-revisions",
    "md-critic-review-plan",
  ].includes(name);
  const subjectBindings =
    name === "md-diff-protocol-revisions"
      ? protocolDiffBindings
      : name === "md-compile-amber-workflow" ||
          name === "md-estimate-resources" ||
          name === "md-critic-review-plan"
        ? planningBindings
        : singleSubjectBindings;
  descriptors.push(
    descriptor({
      name,
      bundle: "planning",
      permission: "allow",
      outputKind: readOnly ? "read" : "proposal",
      payloadSchema,
      subjectBindings,
    }),
  );
}

for (const name of preparationNames) {
  const payloadSchema =
    name === "md-import-evidence"
      ? EvidenceImportPayloadSchema
      : name === "md-create-system-manifest"
        ? SystemManifestCreatePayloadSchema
        : name === "md-approve-construct-policy"
          ? DecisionApprovalPayloadSchema.extend({ decisionKind: z.literal("construct") }).strict()
          : name === "md-approve-ligand-state"
            ? DecisionApprovalPayloadSchema.extend({
                decisionKind: z.literal("microstate"),
              }).strict()
            : [
                  "md-prepare-receptor",
                  "md-prepare-ligand",
                  "md-parameterize-ligand",
                  "md-validate-ligand-parameters",
                  "md-generate-pose-candidates",
                  "md-select-pose",
                ].includes(name)
              ? componentPreparationSchema(name as ComponentPreparationToolName)
              : systemPreparationSchema(name as SystemPreparationToolName);
  const subjectBindings =
    name === "md-import-evidence"
      ? evidenceBindings
      : name === "md-create-system-manifest"
        ? systemManifestBindings
        : name === "md-approve-construct-policy" || name === "md-approve-ligand-state"
          ? decisionApprovalBindings
          : [
                "md-prepare-receptor",
                "md-prepare-ligand",
                "md-parameterize-ligand",
                "md-validate-ligand-parameters",
                "md-generate-pose-candidates",
                "md-select-pose",
              ].includes(name)
            ? componentPreparationBindings
            : systemPreparationBindings;
  descriptors.push(
    descriptor({
      name,
      bundle: "preparation",
      permission: "ask",
      outputKind: "receipt",
      payloadSchema,
      subjectBindings,
    }),
  );
}

for (const name of executionNames) {
  const readOnly = name === "md-stage-status" || name === "md-verify-artifacts";
  const payloadSchema =
    name === "md-render-stage"
      ? StageRenderPayloadSchema
      : name === "md-submit-stage"
        ? StageSubmissionPayloadSchema
        : name === "md-verify-artifacts"
          ? ArtifactVerificationPayloadSchema
          : name === "md-create-replica-set"
            ? ReplicaSetCreatePayloadSchema
            : name === "md-extend-production"
              ? ProductionExtensionPayloadSchema
              : name === "md-stage-status"
                ? StageStatusPayloadSchema
                : StageOperationPayloadSchema;
  const subjectBindings =
    name === "md-verify-artifacts"
      ? stageResultBindings
      : name === "md-create-replica-set"
        ? replicaSetBindings
        : name === "md-extend-production"
          ? productionExtensionBindings
          : name === "md-render-stage" || name === "md-submit-stage"
            ? stageExecutionBindings
            : name === "md-stage-status"
              ? stageStatusBindings
              : stageOperationBindings;
  descriptors.push(
    descriptor({
      name,
      bundle: "execution",
      permission: readOnly ? "allow" : "ask",
      outputKind: readOnly ? "read" : "receipt",
      payloadSchema,
      subjectBindings,
    }),
  );
}

for (const name of analysisNames) {
  const materialWrite = name === "md-run-cpptraj-plan" || name === "md-generate-assessment";
  const proposal = name === "md-propose-remediation";
  const payloadSchema =
    name === "md-parse-mdout"
      ? MdoutParsePayloadSchema
      : name === "md-assess-equilibration"
        ? StageAssessmentPayloadSchema
        : name === "md-assess-replica-convergence"
          ? ReplicaConvergencePayloadSchema
          : name === "md-diagnose-failure"
            ? FailureDiagnosisPayloadSchema
            : name === "md-propose-remediation"
              ? RemediationProposalPayloadSchema
              : name === "md-generate-assessment"
                ? ScientificAssessmentPayloadSchema
                : TrajectoryAnalysisPayloadSchema;
  const subjectBindings =
    name === "md-parse-mdout" ||
    name === "md-assess-equilibration" ||
    name === "md-diagnose-failure"
      ? stageResultBindings
      : name === "md-assess-replica-convergence"
        ? replicaAnalysisBindings
        : name === "md-propose-remediation"
          ? remediationBindings
          : name === "md-generate-assessment"
            ? assessmentBindings
            : trajectoryAnalysisBindings;
  descriptors.push(
    descriptor({
      name,
      bundle: "analysis",
      permission: materialWrite ? "ask" : "allow",
      outputKind: materialWrite ? "receipt" : proposal ? "proposal" : "analysis",
      payloadSchema,
      subjectBindings,
    }),
  );
}

for (const name of comparisonNames) {
  const materialEffect =
    name === "md-export-gromacs-parity-system" || name === "md-compare-single-point-energies";
  descriptors.push(
    descriptor({
      name,
      bundle: "comparison",
      permission: materialEffect ? "ask" : "allow",
      outputKind: materialEffect ? "receipt" : "analysis",
      payloadSchema: ComparisonPayloadSchema,
      subjectBindings: comparisonBindings,
    }),
  );
}

for (const name of provenanceNames) {
  const materialEffect = name === "md-export-reproducibility-bundle";
  descriptors.push(
    descriptor({
      name,
      bundle: "provenance",
      permission: materialEffect ? "ask" : "allow",
      outputKind: materialEffect ? "receipt" : "read",
      payloadSchema: ProvenancePayloadSchema,
      subjectBindings: provenanceBindings,
    }),
  );
}

export const MdToolCatalog: readonly MdToolDescriptor[] = Object.freeze(descriptors);

export function mdToolsForBundle(bundle: MdToolBundle): readonly MdToolDescriptor[] {
  return MdToolCatalog.filter((tool) => tool.bundle === bundle);
}
