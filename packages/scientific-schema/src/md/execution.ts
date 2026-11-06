import { z } from "zod";
import { BiomolecularDecisionReferenceSchema, EngineBuildIdentitySchema } from "../biomolecular";
import {
  DigestSchema,
  IdSchema,
  ScientificCapabilityReferenceSchema,
  SemverSchema,
  TimestampSchema,
} from "../schemas";
import {
  MdArtifactReferenceSchema,
  MdArtifactRoleSchema,
  MdEnvironmentCapabilitySnapshotSchemaVersion,
  MdExecutionBindingParametersSchemaVersion,
  MdStageKindSchema,
  MdStageOperationRequestSchemaVersion,
} from "./common";
import { assertSelfDigest, canonicalSelfDigest } from "./digests";

const MdAuthorizedStageOutputRoleSchema = z
  .object({
    engineRole: z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
    canonicalRole: MdArtifactRoleSchema.extract(["restart", "trajectory", "mdout", "mdinfo"]),
    mediaType: z.string().min(1),
    required: z.boolean(),
  })
  .strict();

/**
 * Command-free durable intent recorded after a renderer has produced and validated
 * one exact engine request, but before any external effect may start. The WorkUnit
 * remains owner of the scientific binding. Digests bind the internal render and
 * command without exposing argv, paths, or a shell surface to model-facing tools.
 */
export const MdStageOperationRequestSchema = z
  .object({
    schemaVersion: z.literal(MdStageOperationRequestSchemaVersion),
    workUnitId: IdSchema,
    bindingDigest: DigestSchema,
    outputContractDigest: DigestSchema,
    stage: z
      .object({
        id: IdSchema,
        revision: z.number().finite().int().safe().positive(),
        digest: DigestSchema,
        // Absent only in historical v2 requests, whose output set remains four roles.
        kind: MdStageKindSchema.optional(),
      })
      .strict(),
    environment: z
      .object({
        canonicalSnapshotId: IdSchema,
        canonicalSnapshotDigest: DigestSchema,
        engineEnvironmentDigest: DigestSchema,
        bindingVersion: SemverSchema,
        bindingDigest: DigestSchema,
        engine: EngineBuildIdentitySchema,
        binaryDigest: DigestSchema,
      })
      .strict(),
    render: z
      .object({
        schemaVersion: z.string().min(1),
        renderedStageDigest: DigestSchema,
        mapperVersion: SemverSchema,
        mapperDigest: DigestSchema,
        mdinDigest: DigestSchema,
        commandRequestDigest: DigestSchema,
      })
      .strict(),
    outputs: z
      .object({
        mappingVersion: SemverSchema,
        mappingDigest: DigestSchema,
        bindings: z.array(MdAuthorizedStageOutputRoleSchema).min(3).max(4),
      })
      .strict(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.environment.engine.buildDigest !== request.environment.binaryDigest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["environment", "binaryDigest"],
        message: "Authorized binary digest must equal the exact engine build digest",
      });
    }
    if (
      request.environment.engine.environmentDigest !== request.environment.engineEnvironmentDigest
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["environment", "engineEnvironmentDigest"],
        message: "Engine identity must bind the exact observed engine environment",
      });
    }
    const canonicalRoles = request.outputs.bindings.map((binding) => binding.canonicalRole);
    const engineRoles = request.outputs.bindings.map((binding) => binding.engineRole);
    const requiredCanonicalRoles =
      request.stage.kind === "minimization"
        ? (["restart", "mdout", "mdinfo"] as const)
        : (["restart", "trajectory", "mdout", "mdinfo"] as const);
    if (
      canonicalRoles.length !== requiredCanonicalRoles.length ||
      new Set(canonicalRoles).size !== requiredCanonicalRoles.length ||
      requiredCanonicalRoles.some((role) => !canonicalRoles.includes(role))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputs", "bindings"],
        message: "Stage authorization requires the complete closed canonical output-role set",
      });
    }
    if (new Set(engineRoles).size !== engineRoles.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputs", "bindings"],
        message: "Stage authorization engine output roles must be unique",
      });
    }
  });

export type MdStageOperationRequest = z.infer<typeof MdStageOperationRequestSchema>;

/** Canonical, versioned environment identity shared by compilers and engine adapters. */
export const MdEnvironmentCapabilitySnapshotSchema = z
  .object({
    schemaVersion: z.literal(MdEnvironmentCapabilitySnapshotSchemaVersion),
    id: IdSchema,
    environmentDigest: DigestSchema,
    engine: EngineBuildIdentitySchema,
    capabilities: z.array(ScientificCapabilityReferenceSchema).min(1),
    targetCompatibility: z
      .object({
        family: z.enum(["amber", "gromacs"]),
        versionRange: z.string().min(1),
        compatible: z.literal(true),
        evaluatorVersion: SemverSchema,
        evidenceDigest: DigestSchema,
      })
      .strict(),
    observedAt: TimestampSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    const identities = snapshot.capabilities.map(
      (capability) =>
        `${capability.id}\u0000${capability.version}\u0000${capability.contractDigest}`,
    );
    if (new Set(identities).size !== identities.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities"],
        message: "Environment capability identities must be unique",
      });
    }
  });

export type MdEnvironmentCapabilitySnapshot = z.infer<typeof MdEnvironmentCapabilitySnapshotSchema>;

/** Exact, command-free identity copied into every executable MD WorkUnit. */
export const MdExecutionBindingParametersSchema = z
  .object({
    schemaVersion: z.literal(MdExecutionBindingParametersSchemaVersion),
    plan: z
      .object({
        id: IdSchema,
        version: z.number().finite().int().safe().positive(),
        revision: z.number().finite().int().safe().positive(),
        digest: DigestSchema,
        approvalRef: IdSchema,
      })
      .strict(),
    system: z
      .object({
        id: IdSchema,
        revision: z.number().finite().int().safe().positive(),
        digest: DigestSchema,
        approvalRef: IdSchema,
      })
      .strict(),
    protocol: z
      .object({
        id: IdSchema,
        revision: z.number().finite().int().safe().positive(),
        digest: DigestSchema,
        approvalRef: IdSchema,
      })
      .strict(),
    stage: z
      .object({
        id: IdSchema,
        revision: z.number().finite().int().safe().positive(),
        sequence: z.number().finite().int().safe().positive(),
        kind: MdStageKindSchema,
        digest: DigestSchema,
      })
      .strict(),
    decisions: z.array(BiomolecularDecisionReferenceSchema).min(1),
    parentRestart: MdArtifactReferenceSchema.optional(),
    replicaSegment: z
      .object({
        replicaSetId: IdSchema,
        replicaSetRevision: z.number().finite().int().safe().positive(),
        replicaSetDigest: DigestSchema,
        replicaId: IdSchema,
        replicaIndex: z.number().finite().int().safe().positive(),
        replicaSeed: z.number().finite().int().safe().min(1).max(2_147_483_646),
        segmentIndex: z.number().finite().int().safe().nonnegative(),
        segmentSeed: z.number().finite().int().safe().min(1).max(2_147_483_646).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((binding, context) => {
    if (binding.stage.sequence > 1 !== (binding.parentRestart !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parentRestart"],
        message: "Every downstream execution binding requires its exact parent restart artifact",
      });
    }
    if (binding.parentRestart !== undefined && binding.parentRestart.role !== "restart") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parentRestart", "role"],
        message: "An execution parent restart must use the canonical restart role",
      });
    }
    if ((binding.stage.kind === "production") !== (binding.replicaSegment !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replicaSegment"],
        message: "Production execution bindings require, and only production may use, a segment",
      });
    }
    const decisionIds = binding.decisions.map((decision) => decision.id);
    if (new Set(decisionIds).size !== decisionIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decisions"],
        message: "Execution bindings may include each exact decision once",
      });
    }
  });

export type MdExecutionBindingParameters = z.infer<typeof MdExecutionBindingParametersSchema>;

/** Digests the complete capability snapshot except its self-digest. */
export function computeMdEnvironmentCapabilitySnapshotDigest(value: object): string {
  return canonicalSelfDigest(value, "environmentDigest");
}

/** Validates a canonical environment snapshot and its exact self-digest. */
export function assertMdEnvironmentCapabilitySnapshotDigest(
  value: unknown,
): MdEnvironmentCapabilitySnapshot {
  const snapshot = MdEnvironmentCapabilitySnapshotSchema.parse(value);
  return assertSelfDigest(
    "MdEnvironmentCapabilitySnapshot",
    snapshot,
    snapshot.environmentDigest,
    "environmentDigest",
  );
}
