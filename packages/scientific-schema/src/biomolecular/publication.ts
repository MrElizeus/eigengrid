import { z } from "zod";
import { DigestSchema, IdSchema, SemverSchema } from "../schemas";
import { BiomolecularBuildEvidenceBindingSchema } from "./build-request";
import {
  AtomMapPublicationRequestSchemaVersion,
  AtomMapPublicationRequestSchemaVersionV1,
  BiomolecularMaterialPublicationBindingSchemaVersion,
  ForceFieldStackPublicationRequestSchemaVersion,
  ForceFieldStackPublicationRequestSchemaVersionV1,
} from "./common";

const BiomolecularMaterialSubjectSchema = z
  .object({
    id: IdSchema,
    revision: z.number().int().positive(),
    digest: DigestSchema,
  })
  .strict();

const BiomolecularMaterialCapabilitySchema = z
  .object({
    id: IdSchema,
    version: SemverSchema,
    contractDigest: DigestSchema,
  })
  .strict();

/**
 * Command-free WorkUnit parameters for publishing one exact biomolecular
 * material revision. The operation request binds their canonical digest.
 */
export const BiomolecularMaterialPublicationBindingSchema = z.discriminatedUnion("subjectKind", [
  z
    .object({
      schemaVersion: z.literal(BiomolecularMaterialPublicationBindingSchemaVersion),
      subjectKind: z.literal("force_field_stack"),
      subject: BiomolecularMaterialSubjectSchema,
      sourceEvidenceRefs: z.array(IdSchema).min(1),
      artifactEvidenceRef: IdSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(BiomolecularMaterialPublicationBindingSchemaVersion),
      subjectKind: z.literal("atom_map"),
      subject: BiomolecularMaterialSubjectSchema,
      systemManifest: z
        .object({
          id: IdSchema,
          revision: z.number().int().positive(),
          digest: DigestSchema,
        })
        .strict(),
      sourceEvidenceRefs: z.array(IdSchema).length(1),
      artifactEvidenceRef: IdSchema,
    })
    .strict(),
]);

export type BiomolecularMaterialPublicationBinding = z.infer<
  typeof BiomolecularMaterialPublicationBindingSchema
>;

/** Exact, command-free intent used to publish a force-field stack CAS artifact. */
const ForceFieldStackPublicationRequestShape = {
  workUnitId: IdSchema,
  capability: BiomolecularMaterialCapabilitySchema,
  stack: BiomolecularMaterialSubjectSchema,
  sourceEvidence: z.array(z.object({ id: IdSchema, contentDigest: DigestSchema }).strict()).min(1),
  outputArtifact: BiomolecularBuildEvidenceBindingSchema,
  parametersDigest: DigestSchema,
  outputContractDigest: DigestSchema,
};

function refineForceFieldStackPublicationRequest(
  request: {
    sourceEvidence: Array<{ id: string; contentDigest: string }>;
    outputArtifact: { evidenceRef: string };
    inputEvidenceId?: string;
    inputContentDigest?: string;
  },
  context: z.RefinementCtx,
): void {
  const evidenceIds = request.sourceEvidence.map((evidence) => evidence.id);
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
      message: "The coordinator input must be one exact force-field source-evidence binding",
    });
  }
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceEvidence"],
      message: "A stack publication may bind each source evidence object only once",
    });
  }
  if (evidenceIds.includes(request.outputArtifact.evidenceRef)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outputArtifact"],
      message: "A stack output artifact cannot also be one of its source inputs",
    });
  }
}

const ForceFieldStackPublicationRequestV1Schema = z
  .object({
    schemaVersion: z.literal(ForceFieldStackPublicationRequestSchemaVersionV1),
    ...ForceFieldStackPublicationRequestShape,
  })
  .strict();

const ForceFieldStackPublicationRequestV2Schema = z
  .object({
    schemaVersion: z.literal(ForceFieldStackPublicationRequestSchemaVersion),
    ...ForceFieldStackPublicationRequestShape,
    missionId: IdSchema,
    planId: IdSchema,
    planVersion: z.number().int().positive(),
    intendedJobId: IdSchema,
    intendedAttemptId: IdSchema,
    inputEvidenceId: IdSchema,
    inputContentDigest: DigestSchema,
  })
  .strict();

export const ForceFieldStackPublicationRequestSchema = z
  .union([ForceFieldStackPublicationRequestV1Schema, ForceFieldStackPublicationRequestV2Schema])
  .superRefine(refineForceFieldStackPublicationRequest);

export type ForceFieldStackPublicationRequest = z.infer<
  typeof ForceFieldStackPublicationRequestSchema
>;

/** Exact, command-free intent used to validate the atom-map artifact of one manifest revision. */
const AtomMapPublicationRequestShape = {
  workUnitId: IdSchema,
  capability: BiomolecularMaterialCapabilitySchema,
  atomMap: BiomolecularMaterialSubjectSchema,
  systemManifest: z
    .object({
      id: IdSchema,
      revision: z.number().int().positive(),
      digest: DigestSchema,
    })
    .strict(),
  sourceArtifact: BiomolecularBuildEvidenceBindingSchema,
  parametersDigest: DigestSchema,
  outputContractDigest: DigestSchema,
};

const AtomMapPublicationRequestV1Schema = z
  .object({
    schemaVersion: z.literal(AtomMapPublicationRequestSchemaVersionV1),
    ...AtomMapPublicationRequestShape,
  })
  .strict();

const AtomMapPublicationRequestV2Schema = z
  .object({
    schemaVersion: z.literal(AtomMapPublicationRequestSchemaVersion),
    ...AtomMapPublicationRequestShape,
    missionId: IdSchema,
    planId: IdSchema,
    planVersion: z.number().int().positive(),
    intendedJobId: IdSchema,
    intendedAttemptId: IdSchema,
    inputEvidenceId: IdSchema,
    inputContentDigest: DigestSchema,
  })
  .strict();

export const AtomMapPublicationRequestSchema = z
  .union([AtomMapPublicationRequestV1Schema, AtomMapPublicationRequestV2Schema])
  .superRefine((request, context) => {
    if (
      "inputEvidenceId" in request &&
      (request.inputEvidenceId !== request.sourceArtifact.evidenceRef ||
        request.inputContentDigest !== request.atomMap.digest)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inputEvidenceId"],
        message: "Coordinator input must match the exact AtomMap source artifact and digest",
      });
    }
  });

export type AtomMapPublicationRequest = z.infer<typeof AtomMapPublicationRequestSchema>;
