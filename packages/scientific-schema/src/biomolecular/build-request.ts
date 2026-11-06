import { z } from "zod";
import { DigestSchema, IdSchema, SemverSchema } from "../schemas";
import {
  BiomolecularSystemBuildRequestSchemaVersion,
  BiomolecularSystemBuildRequestSchemaVersionV1,
  BiomolecularSystemBuildWorkUnitBindingSchemaVersion,
  UniqueIds,
} from "./common";
import { BiomolecularDecisionReferenceSchema } from "./decisions";

/** Command-free, reviewed inputs for a system-build WorkUnit. The durable
 * operation request adds mission/plan/job identity and exact CAS digests. */
export const BiomolecularSystemBuildWorkUnitBindingSchema = z
  .object({
    schemaVersion: z.literal(BiomolecularSystemBuildWorkUnitBindingSchemaVersion),
    primaryInputEvidenceId: IdSchema,
    sourceEvidenceRefs: z.array(IdSchema).min(1),
    forceFieldStackEvidenceRef: IdSchema,
    decisionRefs: z.array(BiomolecularDecisionReferenceSchema).min(1),
    forceFieldStack: z
      .object({
        id: IdSchema,
        revision: z.number().int().positive(),
        digest: DigestSchema,
      })
      .strict(),
    outputArtifacts: z
      .object({
        topology: z
          .object({
            evidenceRef: IdSchema,
            mediaType: z.literal("application/vnd.amber.prmtop"),
          })
          .strict(),
        coordinates: z
          .object({
            evidenceRef: IdSchema,
            mediaType: z.literal("application/vnd.amber.rst7"),
          })
          .strict(),
        atomMap: z
          .object({
            evidenceRef: IdSchema,
            mediaType: z.literal("application/vnd.eigengrid.atom-map+json"),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((binding, context) => {
    if (!binding.sourceEvidenceRefs.includes(binding.primaryInputEvidenceId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["primaryInputEvidenceId"],
        message: "The primary input must be one of the exact source evidence references",
      });
    }
    if (new Set(binding.sourceEvidenceRefs).size !== binding.sourceEvidenceRefs.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceEvidenceRefs"],
        message: "Source evidence references must be unique",
      });
    }
    if (binding.sourceEvidenceRefs.includes(binding.forceFieldStackEvidenceRef)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["forceFieldStackEvidenceRef"],
        message: "Force-field stack evidence is bound separately from source evidence",
      });
    }
    const decisionIds = binding.decisionRefs.map((decision) => decision.id);
    if (new Set(decisionIds).size !== decisionIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decisionRefs"],
        message: "Each exact system-build decision may be bound once",
      });
    }
    const outputIds = Object.values(binding.outputArtifacts).map(
      (artifact) => artifact.evidenceRef,
    );
    if (
      new Set(outputIds).size !== outputIds.length ||
      outputIds.some(
        (evidenceRef) =>
          binding.sourceEvidenceRefs.includes(evidenceRef) ||
          evidenceRef === binding.forceFieldStackEvidenceRef,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputArtifacts"],
        message: "Output evidence identities must be unique and distinct from all inputs",
      });
    }
  });

export type BiomolecularSystemBuildWorkUnitBinding = z.infer<
  typeof BiomolecularSystemBuildWorkUnitBindingSchema
>;

export const BiomolecularSystemBuildWorkUnitParametersSchema = z
  .object({
    manifestId: IdSchema,
    manifestRevision: z.number().int().positive(),
    manifestDigest: DigestSchema,
    systemBuild: BiomolecularSystemBuildWorkUnitBindingSchema,
  })
  .strict();

export type BiomolecularSystemBuildWorkUnitParameters = z.infer<
  typeof BiomolecularSystemBuildWorkUnitParametersSchema
>;

export const BiomolecularBuildEvidenceBindingSchema = z
  .object({
    evidenceRef: IdSchema,
    mediaType: z.string().min(1),
  })
  .strict();

/**
 * Canonical intent payload for the one external effect allowed to publish a
 * biomolecular system manifest. It deliberately contains no executable, argv,
 * path, or shell field.
 */
const BiomolecularSystemBuildRequestShape = {
  workUnitId: IdSchema,
  capability: z
    .object({
      id: IdSchema,
      version: SemverSchema,
      contractDigest: DigestSchema,
    })
    .strict(),
  systemManifest: z
    .object({
      id: IdSchema,
      revision: z.number().int().positive(),
    })
    .strict(),
  sourceEvidence: z.array(z.object({ id: IdSchema, contentDigest: DigestSchema }).strict()).min(1),
  decisionRefs: z.array(BiomolecularDecisionReferenceSchema).min(1),
  forceFieldStack: z
    .object({
      id: IdSchema,
      revision: z.number().int().positive(),
      digest: DigestSchema,
    })
    .strict(),
  outputArtifacts: z
    .object({
      topology: BiomolecularBuildEvidenceBindingSchema,
      coordinates: BiomolecularBuildEvidenceBindingSchema,
      atomMap: BiomolecularBuildEvidenceBindingSchema,
    })
    .strict(),
  parametersDigest: DigestSchema,
  outputContractDigest: DigestSchema,
};

function refineBiomolecularSystemBuildRequest(
  request: {
    sourceEvidence: Array<{ id: string; contentDigest: string }>;
    decisionRefs: Array<{ id: string }>;
    outputArtifacts: Record<string, { evidenceRef: string }>;
    inputEvidenceId?: string;
    inputContentDigest?: string;
  },
  context: z.RefinementCtx,
): void {
  const sourceIds = request.sourceEvidence.map((evidence) => evidence.id);
  if (
    "inputEvidenceId" in request &&
    !request.sourceEvidence.some(
      (evidence) =>
        evidence.id === request.inputEvidenceId &&
        evidence.contentDigest === request.inputContentDigest,
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["inputEvidenceId"],
      message: "The coordinator input must be one exact source-evidence binding",
    });
  }
  if (new Set(sourceIds).size !== sourceIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceEvidence"],
      message: "A system-build request may bind each source evidence object only once",
    });
  }
  if (!UniqueIds(request.decisionRefs)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["decisionRefs"],
      message: "A system-build request may bind each exact decision only once",
    });
  }
  const outputIds = Object.values(request.outputArtifacts).map((artifact) => artifact.evidenceRef);
  if (new Set(outputIds).size !== outputIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outputArtifacts"],
      message: "Topology, coordinates, and atom map require distinct evidence identities",
    });
  }
}

const BiomolecularSystemBuildRequestV1Schema = z
  .object({
    schemaVersion: z.literal(BiomolecularSystemBuildRequestSchemaVersionV1),
    ...BiomolecularSystemBuildRequestShape,
  })
  .strict();

const BiomolecularSystemBuildRequestV2Schema = z
  .object({
    schemaVersion: z.literal(BiomolecularSystemBuildRequestSchemaVersion),
    ...BiomolecularSystemBuildRequestShape,
    missionId: IdSchema,
    planId: IdSchema,
    planVersion: z.number().int().positive(),
    intendedJobId: IdSchema,
    intendedAttemptId: IdSchema,
    inputEvidenceId: IdSchema,
    inputContentDigest: DigestSchema,
  })
  .strict();

export const BiomolecularSystemBuildRequestSchema = z
  .union([BiomolecularSystemBuildRequestV1Schema, BiomolecularSystemBuildRequestV2Schema])
  .superRefine(refineBiomolecularSystemBuildRequest);

export type BiomolecularSystemBuildRequest = z.infer<typeof BiomolecularSystemBuildRequestSchema>;
