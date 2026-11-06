import { z } from "zod";
import { digestCanonical } from "../canonical";
import { DigestSchema, IdSchema, TimestampSchema } from "../schemas";
import { MdArtifactReferenceSchema, MdReplicaSetSchemaVersion } from "./common";
import { type MdStageSpec } from "./stages";

export const MdReplicaSchema = z
  .object({
    id: IdSchema,
    index: z.number().finite().int().safe().positive(),
    seed: z.number().finite().int().safe().min(1).max(2_147_483_646),
    segmentSeeds: z
      .array(z.number().finite().int().safe().min(1).max(2_147_483_646))
      .min(1)
      .max(1024)
      .optional(),
    initialRestart: MdArtifactReferenceSchema,
  })
  .strict()
  .superRefine((replica, context) => {
    if (replica.segmentSeeds !== undefined && replica.segmentSeeds[0] !== replica.seed) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["segmentSeeds"],
        message: "The initial replica seed must equal its first explicit segment seed",
      });
    }
    if (replica.initialRestart.role !== "restart") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["initialRestart", "role"],
        message: "A replica must start from a restart artifact",
      });
    }
  });

export type MdReplica = z.infer<typeof MdReplicaSchema>;

/** The complete finite schedule is approved; no engine seed is generated at dispatch. */
export function computeMdReplicaSeedPolicyDigest(replicas: readonly MdReplica[]): string {
  return digestCanonical({
    schemaVersion: "eigengrid.md-replica-segment-seeds/v1",
    policy: "explicit_per_segment",
    replicas: replicas.map((replica) => {
      if (replica.segmentSeeds === undefined) throw new Error("Explicit segment seeds are missing");
      return { id: replica.id, index: replica.index, seeds: replica.segmentSeeds };
    }),
  });
}

export const ReplicaSetSchema = z
  .object({
    schemaVersion: z.literal(MdReplicaSetSchemaVersion),
    id: IdSchema,
    missionId: IdSchema,
    revision: z.number().finite().int().safe().positive(),
    protocolId: IdSchema,
    protocolRevision: z.number().finite().int().safe().positive(),
    protocolDigest: DigestSchema,
    systemManifestDigest: DigestSchema,
    replicaCount: z.number().finite().int().safe().positive(),
    replicas: z.array(MdReplicaSchema).min(1),
    seedPolicyDigest: DigestSchema,
    decisionRef: IdSchema,
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((replicaSet, context) => {
    if (replicaSet.replicas.some((replica) => replica.segmentSeeds !== undefined)) {
      const count = replicaSet.replicas[0]?.segmentSeeds?.length;
      const complete = replicaSet.replicas.every(
        (replica) => replica.segmentSeeds !== undefined && replica.segmentSeeds.length === count,
      );
      const segmentSeeds = replicaSet.replicas.flatMap((replica) => replica.segmentSeeds ?? []);
      if (!complete || new Set(segmentSeeds).size !== segmentSeeds.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["replicas"],
          message: "Every replica needs an equally long segment seed schedule, globally unique",
        });
      }
      if (
        complete &&
        replicaSet.seedPolicyDigest !== computeMdReplicaSeedPolicyDigest(replicaSet.replicas)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["seedPolicyDigest"],
          message: "Seed policy digest must bind the complete explicit segment seed schedule",
        });
      }
    }
    if (replicaSet.replicas.length !== replicaSet.replicaCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replicaCount"],
        message: "Replica count must equal the number of replica definitions",
      });
    }
    const ids = replicaSet.replicas.map((replica) => replica.id);
    const seeds = replicaSet.replicas.map((replica) => replica.seed);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replicas"],
        message: "Replica identifiers must be unique",
      });
    }
    if (new Set(seeds).size !== seeds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replicas"],
        message: "Independent replicas must use distinct random seeds",
      });
    }
    const indices = replicaSet.replicas.map((replica) => replica.index).sort((a, b) => a - b);
    if (indices.some((index, offset) => index !== offset + 1)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replicas"],
        message: "Replica indices must be contiguous and one-based",
      });
    }
  });

export type ReplicaSet = z.infer<typeof ReplicaSetSchema>;

export const MdReplicaSetSchema = ReplicaSetSchema;

export type MdReplicaSet = ReplicaSet;

/** Undefined is a historical binding, never permission for a production renderer fallback. */
export function resolveMdReplicaSegmentSeed(
  stage: MdStageSpec,
  replicaSet: ReplicaSet,
  replicaId: string,
  segmentIndex: number,
): number | undefined {
  replicaSet = ReplicaSetSchema.parse(replicaSet);
  const replica = replicaSet.replicas.find((candidate) => candidate.id === replicaId);
  if (
    stage.kind !== "production" ||
    replica === undefined ||
    !Number.isSafeInteger(segmentIndex) ||
    segmentIndex < 0
  ) {
    throw new Error("Invalid replica segment seed request");
  }
  const policy = stage.randomSeed;
  if (policy?.policy !== "replica_segment") {
    if (replicaSet.replicas.some((candidate) => candidate.segmentSeeds !== undefined)) {
      throw new Error("An explicit replica schedule requires a replica_segment protocol policy");
    }
    return undefined;
  }
  if (
    segmentIndex >= policy.segmentCount ||
    replicaSet.replicas.some((candidate) => candidate.segmentSeeds?.length !== policy.segmentCount)
  ) {
    throw new Error("Segment index or seed schedule exceeds the exact approved production length");
  }
  return replica.segmentSeeds![segmentIndex]!;
}

/** Canonical identity for a complete replica-set revision. */
export function computeMdReplicaSetDigest(value: object): string {
  return digestCanonical(value);
}
