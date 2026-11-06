import { z } from "zod";
import {
  BiomolecularSystemManifestReferenceSchema,
  EngineBuildIdentitySchema,
  ScientificSchemaDigestMismatchError,
  type ForceFieldStackManifest,
} from "../biomolecular";
import { digestCanonical } from "../canonical";
import { DigestSchema, IdSchema, SemverSchema, TimestampSchema } from "../schemas";
import {
  MdCapabilityReferenceSchema,
  MdProtocolSchemaVersion,
  StrictSkillVersionReferenceSchema,
  type MdStageKind,
} from "./common";
import { canonicalDigestOmitting } from "./digests";
import { MdStageSpecSchema } from "./stages";

/** Separately reviewed admission evidence for one technical pilot. This record
 * preserves the deposited stack metadata and does not certify scientific
 * equilibration or general engine/GPU qualification. Its complete content is
 * bound by the protocol approval and independently retained in same-mission CAS.
 */
export const MdForceFieldEngineAdmissionSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.md-force-field-engine-admission/v1"),
    missionId: IdSchema,
    scope: z.literal("provisional_technical_pilot"),
    system: BiomolecularSystemManifestReferenceSchema,
    forceFieldStack: z
      .object({
        id: IdSchema,
        revision: z.number().finite().int().safe().positive(),
        digest: DigestSchema,
      })
      .strict(),
    parameterDigests: z.array(DigestSchema).min(1),
    targetEngine: z
      .object({ family: z.enum(["amber", "gromacs"]), versionRange: z.string().min(1) })
      .strict(),
    engine: EngineBuildIdentitySchema,
    sourceEvidence: z
      .array(
        z
          .object({
            evidenceRef: IdSchema,
            contentDigest: DigestSchema,
            kind: z.enum(["environment", "source_snapshot", "rendered_input"]),
          })
          .strict(),
      )
      .min(2),
    rationale: z.string().min(1),
    limitations: z.array(z.string().min(1)).min(1),
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((admission, context) => {
    if (
      admission.engine.engine.toLowerCase() !== admission.targetEngine.family ||
      new Set(admission.parameterDigests).size !== admission.parameterDigests.length ||
      new Set(admission.sourceEvidence.map((source) => source.evidenceRef)).size !==
        admission.sourceEvidence.length ||
      !admission.sourceEvidence.some((source) => source.kind === "environment") ||
      !admission.sourceEvidence.some((source) => source.kind !== "environment")
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Technical engine admission requires an exact family and distinct environment/material source evidence",
      });
  });

export type MdForceFieldEngineAdmission = z.infer<typeof MdForceFieldEngineAdmissionSchema>;

export const MdForceFieldEngineAdmissionBindingSchema = z
  .object({
    evidenceRef: IdSchema,
    contentDigest: DigestSchema,
    admission: MdForceFieldEngineAdmissionSchema,
  })
  .strict()
  .superRefine((binding, context) => {
    if (digestCanonical(binding.admission) !== binding.contentDigest)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contentDigest"],
        message: "Engine admission digest must cover its complete canonical CAS content",
      });
  });

export function mdForceFieldParameterDigests(stack: ForceFieldStackManifest): string[] {
  return [
    ...new Set([
      stack.protein.parameterDigest,
      stack.lipid.parameterDigest,
      stack.water.parameterSet.parameterDigest,
      stack.ions.parameterDigest,
      ...stack.ligands.flatMap((ligand) => [
        ligand.parameterSet.parameterDigest,
        ligand.atomTypeDigest,
        ligand.chargeDigest,
      ]),
      ...stack.cofactors.map((cofactor) => cofactor.parameterSet.parameterDigest),
    ]),
  ].sort();
}

export const MdWorkflowProtocolSchema = z
  .object({
    schemaVersion: z.literal(MdProtocolSchemaVersion),
    id: IdSchema,
    missionId: IdSchema,
    revision: z.number().finite().int().safe().positive(),
    status: z.enum(["draft", "under_review", "approved", "superseded"]),
    system: BiomolecularSystemManifestReferenceSchema,
    forceFieldStack: z
      .object({
        id: IdSchema,
        revision: z.number().finite().int().safe().positive(),
        digest: DigestSchema,
      })
      .strict(),
    targetEngine: z
      .object({ family: z.enum(["amber", "gromacs"]), versionRange: z.string().min(1) })
      .strict(),
    /** Historical protocols retain the existing production requirement. */
    purpose: z.enum(["production", "technical_pilot"]).optional(),
    /** Exact historical preparation policy ratified by the current protocol
     * approval for frozen decisions and completed material receipts only.
     * Never authorizes a new effect under the old policy. */
    preparationPolicyDigest: DigestSchema.optional(),
    forceFieldEngineAdmission: MdForceFieldEngineAdmissionBindingSchema.optional(),
    capabilityRefs: z.array(MdCapabilityReferenceSchema).min(1),
    stages: z.array(MdStageSpecSchema).min(1),
    decisionRefs: z.array(IdSchema).min(1),
    assumptions: z.array(z.string().min(1)),
    skillRefs: z.array(StrictSkillVersionReferenceSchema).min(1),
    compilerVersion: SemverSchema,
    protocolDigest: DigestSchema,
    approvedByRef: IdSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((protocol, context) => {
    const stageIds = protocol.stages.map((stage) => stage.id);
    if (new Set(stageIds).size !== stageIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stages"],
        message: "MD stage identifiers must be unique",
      });
    }
    const rank: Record<MdStageKind, number> = {
      minimization: 0,
      heating: 1,
      equilibration: 2,
      production: 3,
    };
    for (let index = 0; index < protocol.stages.length; index += 1) {
      const stage = protocol.stages[index]!;
      if (stage.sequence !== index + 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stages", index, "sequence"],
          message: "Protocol stages must use contiguous one-based sequence numbers",
        });
      }
      if (digestCanonical(stage.system) !== digestCanonical(protocol.system)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stages", index, "system"],
          message: "Every stage must bind the complete exact protocol system reference",
        });
      }
      if (index === 0 && stage.kind === "production") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stages", index, "kind"],
          message: "Production requires a validated upstream stage and cannot be the first stage",
        });
      }
      if (index > 0) {
        const previous = protocol.stages[index - 1]!;
        if (stage.parentStageId !== previous.id) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["stages", index, "parentStageId"],
            message: "Each stage must name the immediately preceding stage as parent",
          });
        }
        if (rank[stage.kind] < rank[previous.kind]) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["stages", index, "kind"],
            message: "MD workflow stage kinds cannot move backward",
          });
        }
      }
    }
    if (protocol.purpose === "technical_pilot") {
      if (protocol.stages.some((stage) => stage.kind === "production"))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stages"],
          message: "A technical pilot cannot contain or authorize a production stage",
        });
    } else if (!protocol.stages.some((stage) => stage.kind === "production")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stages"],
        message: "An MD workflow protocol must contain a production stage",
      });
    }
    if (protocol.forceFieldEngineAdmission !== undefined && protocol.purpose !== "technical_pilot")
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["forceFieldEngineAdmission"],
        message:
          "Provisional engine admission is restricted to an explicitly approved technical pilot",
      });
    if (protocol.preparationPolicyDigest !== undefined && protocol.purpose !== "technical_pilot")
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["preparationPolicyDigest"],
        message: "Preparation policy handoff requires an explicitly approved technical pilot",
      });
    const capabilityIds = protocol.capabilityRefs.map((capability) => capability.id);
    if (new Set(capabilityIds).size !== capabilityIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilityRefs"],
        message: "A workflow may bind each versioned capability only once",
      });
    }
    if ((protocol.status === "approved") !== (protocol.approvedByRef !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvedByRef"],
        message: "Only an approved protocol may carry, and must carry, its approval reference",
      });
    }
  });

export type MdWorkflowProtocol = z.infer<typeof MdWorkflowProtocolSchema>;

/**
 * Digests the immutable scientific content of a workflow. Lifecycle fields are omitted
 * so an exact approval can bind the reviewed digest before the durable transition to
 * `approved`; nested stage digests remain included and bind exact stage revisions.
 */
export function computeMdWorkflowProtocolDigest(value: object): string {
  return canonicalDigestOmitting(value, ["protocolDigest", "status", "approvedByRef", "updatedAt"]);
}

export const computeMdProtocolDigest = computeMdWorkflowProtocolDigest;

/** Validates both the workflow schema and its canonical self-digest. */
export function assertMdWorkflowProtocolDigest(value: unknown): MdWorkflowProtocol {
  const protocol = MdWorkflowProtocolSchema.parse(value);
  const observedDigest = computeMdWorkflowProtocolDigest(protocol);
  if (observedDigest !== protocol.protocolDigest) {
    throw new ScientificSchemaDigestMismatchError(
      "MdWorkflowProtocol",
      protocol.id,
      protocol.protocolDigest,
      observedDigest,
    );
  }
  return protocol;
}

export const assertMdProtocolDigest = assertMdWorkflowProtocolDigest;
