import { z } from "zod";
import { DigestSchema, IdSchema, TimestampSchema } from "../schemas";
import { MdArtifactReferenceSchema, TrajectorySegmentSchemaVersion } from "./common";
import { assertSelfDigest, canonicalSelfDigest } from "./digests";

export const TrajectorySegmentSchema = z
  .object({
    schemaVersion: z.literal(TrajectorySegmentSchemaVersion),
    id: IdSchema,
    revision: z.number().finite().int().safe().positive(),
    missionId: IdSchema,
    replicaId: IdSchema,
    stageResultId: IdSchema,
    segmentIndex: z.number().finite().int().safe().nonnegative(),
    parentRestart: MdArtifactReferenceSchema,
    restart: MdArtifactReferenceSchema,
    trajectory: MdArtifactReferenceSchema,
    startStep: z.number().finite().int().safe().nonnegative(),
    endStep: z.number().finite().int().safe().positive(),
    startTimePs: z.number().finite().nonnegative(),
    endTimePs: z.number().finite().positive(),
    frameCount: z.number().finite().int().safe().positive(),
    netcdf: z
      .object({
        convention: z.string().min(1),
        atomCount: z.number().finite().int().safe().positive(),
        frameCount: z.number().finite().int().safe().positive(),
        hasPeriodicBox: z.boolean(),
      })
      .strict(),
    continuity: z
      .object({
        status: z.enum(["verified", "failed", "indeterminate"]),
        expectedParentRestartDigest: DigestSchema,
        observedParentRestartDigest: DigestSchema,
        expectedStartStep: z.number().finite().int().safe().nonnegative(),
        observedStartStep: z.number().finite().int().safe().nonnegative(),
        expectedStartTimePs: z.number().finite().nonnegative(),
        observedStartTimePs: z.number().finite().nonnegative(),
        reason: z.string().min(1),
      })
      .strict(),
    segmentDigest: DigestSchema,
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((segment, context) => {
    if (
      segment.parentRestart.role !== "restart" ||
      segment.restart.role !== "restart" ||
      segment.trajectory.role !== "trajectory"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parentRestart"],
        message: "Trajectory segment artifacts must use their canonical roles",
      });
    }
    if (segment.endStep <= segment.startStep || segment.endTimePs <= segment.startTimePs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endStep"],
        message: "A trajectory segment must advance both step and simulated time",
      });
    }
    if (segment.netcdf.frameCount !== segment.frameCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["netcdf", "frameCount"],
        message: "Parsed NetCDF frame count must match the segment frame count",
      });
    }
    if (segment.continuity.expectedParentRestartDigest !== segment.parentRestart.contentDigest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["continuity", "expectedParentRestartDigest"],
        message: "Continuity must be checked against the declared parent restart",
      });
    }
    if (
      segment.continuity.status === "verified" &&
      (segment.continuity.expectedParentRestartDigest !==
        segment.continuity.observedParentRestartDigest ||
        segment.continuity.expectedStartStep !== segment.continuity.observedStartStep ||
        Math.abs(segment.continuity.expectedStartTimePs - segment.continuity.observedStartTimePs) >
          1e-9)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["continuity", "status"],
        message: "Continuity cannot be verified when expected and observed values differ",
      });
    }
  });

export type TrajectorySegment = z.infer<typeof TrajectorySegmentSchema>;

/** Digests every normalized segment field except `segmentDigest` itself. */
export function computeTrajectorySegmentDigest(value: object): string {
  return canonicalSelfDigest(value, "segmentDigest");
}

/** Validates both the trajectory-segment schema and its canonical self-digest. */
export function assertTrajectorySegmentDigest(value: unknown): TrajectorySegment {
  const segment = TrajectorySegmentSchema.parse(value);
  return assertSelfDigest("TrajectorySegment", segment, segment.segmentDigest, "segmentDigest");
}
