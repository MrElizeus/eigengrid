import { z } from "zod";
import {
  ActorIdentitySchema,
  DigestSchema,
  IdSchema,
  ScientificCapabilityIdSchema,
  ScientificCapabilityReferenceSchema,
  SkillVersionReferenceSchema,
} from "../schemas";

export const StrictActorIdentitySchema = ActorIdentitySchema.strict();

export const StrictSkillVersionReferenceSchema = SkillVersionReferenceSchema.strict();

export const MdProtocolSchemaVersion = "eigengrid.md-workflow-protocol/v2" as const;

export const MdStageSchemaVersion = "eigengrid.md-stage/v2" as const;

export const MdReplicaSetSchemaVersion = "eigengrid.md-replica-set/v1" as const;

export const TrajectorySegmentSchemaVersion = "eigengrid.trajectory-segment/v1" as const;

export const MdStageResultSchemaVersion = "eigengrid.md-stage-result/v1" as const;

export const MdMetricSeriesSchemaVersion = "eigengrid.md-metric-series/v1" as const;

export const MdAssessmentSchemaVersion = "eigengrid.md-assessment/v1" as const;

export const MdStageKindSchema = z.enum(["minimization", "heating", "equilibration", "production"]);

export type MdStageKind = z.infer<typeof MdStageKindSchema>;

export const MdExecutionBindingParametersSchemaVersion =
  "eigengrid.md-execution-binding/v2" as const;

export const MdStageOperationRequestSchemaVersion =
  "eigengrid.md-stage-operation-request/v2" as const;

export const MdEnvironmentCapabilitySnapshotSchemaVersion =
  "eigengrid.md-environment-capability-snapshot/v1" as const;

export const MdArtifactRoleSchema = z.enum([
  "topology",
  "coordinates",
  "parent_restart",
  "restart",
  "trajectory",
  "mdout",
  "mdinfo",
  "energy_series",
  "normalized_metrics",
  "analysis_plan",
  "analysis_result",
  "atom_map",
]);

export type MdArtifactRole = z.infer<typeof MdArtifactRoleSchema>;

export const MdArtifactReferenceSchema = z
  .object({
    artifactId: IdSchema,
    evidenceRef: IdSchema,
    role: MdArtifactRoleSchema,
    contentDigest: DigestSchema,
    mediaType: z.string().min(1),
    sizeBytes: z.number().finite().int().safe().nonnegative().optional(),
  })
  .strict();

export type MdArtifactReference = z.infer<typeof MdArtifactReferenceSchema>;

/**
 * Open, namespaced capability identity used by MD workflows instead of widening the
 * legacy QC ProtocolFragment kind enum.
 */
export const MdCapabilityIdSchema = ScientificCapabilityIdSchema;

export const MdCapabilityReferenceSchema = ScientificCapabilityReferenceSchema;

export type MdCapabilityReference = z.infer<typeof MdCapabilityReferenceSchema>;
