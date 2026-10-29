import { z } from "zod";
import { sha256Canonical } from "./canonical";
import { Sha256Schema } from "./contracts";

const ReplicaIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

export const SegmentRequestSchema = z
  .object({
    schemaVersion: z.literal("amber-segment-request/v1"),
    replicaId: ReplicaIdSchema,
    segmentIndex: z.number().int().nonnegative(),
    parentRestartDigest: Sha256Schema,
    topologyDigest: Sha256Schema,
    systemManifestDigest: Sha256Schema,
    startStep: z.number().int().nonnegative(),
    startTimePs: z.number().finite().nonnegative(),
    steps: z.number().int().positive(),
    timestepPs: z.number().finite().positive(),
    trajectoryEvery: z.number().int().positive(),
    includeStartFrame: z.boolean(),
    randomSeed: z.number().int().positive().max(2_147_483_647),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.trajectoryEvery > request.steps || request.steps % request.trajectoryEvery !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trajectoryEvery"],
        message: "trajectory cadence must divide the requested segment length exactly",
      });
    }
  });
export type SegmentRequest = z.infer<typeof SegmentRequestSchema>;

export function segmentRequestDigest(request: SegmentRequest): string {
  return sha256Canonical(SegmentRequestSchema.parse(request));
}

export const TrajectorySegmentSchema = z
  .object({
    schemaVersion: z.literal("amber-trajectory-segment/v1"),
    requestDigest: Sha256Schema,
    replicaId: ReplicaIdSchema,
    segmentIndex: z.number().int().nonnegative(),
    parentRestartDigest: Sha256Schema,
    restartDigest: Sha256Schema,
    topologyDigest: Sha256Schema,
    systemManifestDigest: Sha256Schema,
    trajectoryDigest: Sha256Schema,
    startStep: z.number().int().nonnegative(),
    endStep: z.number().int().positive(),
    startTimePs: z.number().finite().nonnegative(),
    endTimePs: z.number().finite().positive(),
    frameCount: z.number().int().positive(),
  })
  .strict()
  .refine((segment) => segment.endStep > segment.startStep, {
    path: ["endStep"],
    message: "segment end step must be after its start step",
  })
  .refine((segment) => segment.endTimePs > segment.startTimePs, {
    path: ["endTimePs"],
    message: "segment end time must be after its start time",
  });
export type TrajectorySegment = z.infer<typeof TrajectorySegmentSchema>;

export interface SegmentContinuityIssue {
  code: string;
  message: string;
}

export interface SegmentContinuityResult {
  continuous: boolean;
  issues: SegmentContinuityIssue[];
}

export function validateSegmentAgainstRequest(
  requestValue: SegmentRequest,
  segmentValue: TrajectorySegment,
  timeTolerancePs = 1e-9,
): SegmentContinuityResult {
  const request = SegmentRequestSchema.parse(requestValue);
  const segment = TrajectorySegmentSchema.parse(segmentValue);
  const tolerance = z.number().finite().nonnegative().parse(timeTolerancePs);
  const issues: SegmentContinuityIssue[] = [];
  if (segment.requestDigest !== segmentRequestDigest(request)) {
    issues.push({
      code: "request_digest_mismatch",
      message: "Segment request digest is not exact",
    });
  }
  for (const [field, code] of [
    ["replicaId", "replica_mismatch"],
    ["segmentIndex", "segment_index_mismatch"],
    ["parentRestartDigest", "restart_parent_mismatch"],
    ["topologyDigest", "topology_mismatch"],
    ["systemManifestDigest", "system_manifest_mismatch"],
    ["startStep", "start_step_mismatch"],
  ] as const) {
    if (segment[field] !== request[field]) {
      issues.push({ code, message: `Segment ${field} does not match its request` });
    }
  }
  if (Math.abs(segment.startTimePs - request.startTimePs) > tolerance) {
    issues.push({
      code: "start_time_mismatch",
      message: "Segment start time does not match its request",
    });
  }
  if (segment.endStep !== request.startStep + request.steps) {
    issues.push({
      code: "end_step_mismatch",
      message: "Segment end step does not match requested steps",
    });
  }
  const expectedEndTime = request.startTimePs + request.steps * request.timestepPs;
  if (Math.abs(segment.endTimePs - expectedEndTime) > tolerance) {
    issues.push({
      code: "end_time_mismatch",
      message: "Segment end time does not match steps and dt",
    });
  }
  const expectedFrameCount =
    request.steps / request.trajectoryEvery + (request.includeStartFrame ? 1 : 0);
  if (segment.frameCount !== expectedFrameCount) {
    issues.push({
      code: "frame_count_mismatch",
      message: "Segment frame count does not match steps and trajectory cadence",
    });
  }
  return { continuous: issues.length === 0, issues };
}

export function validateSegmentContinuity(
  previousValue: TrajectorySegment,
  nextValue: TrajectorySegment,
  timeTolerancePs = 1e-9,
): SegmentContinuityResult {
  const previous = TrajectorySegmentSchema.parse(previousValue);
  const next = TrajectorySegmentSchema.parse(nextValue);
  const tolerance = z.number().finite().nonnegative().parse(timeTolerancePs);
  const issues: SegmentContinuityIssue[] = [];
  if (next.replicaId !== previous.replicaId) {
    issues.push({ code: "replica_mismatch", message: "Segments belong to different replicas" });
  }
  if (next.segmentIndex !== previous.segmentIndex + 1) {
    issues.push({ code: "segment_index_gap", message: "Segment indexes are not consecutive" });
  }
  if (next.parentRestartDigest !== previous.restartDigest) {
    issues.push({
      code: "restart_parent_mismatch",
      message: "Next segment does not consume the previous restart digest",
    });
  }
  if (next.topologyDigest !== previous.topologyDigest) {
    issues.push({ code: "topology_changed", message: "Topology digest changed between segments" });
  }
  if (next.systemManifestDigest !== previous.systemManifestDigest) {
    issues.push({
      code: "system_manifest_changed",
      message: "System manifest digest changed between segments",
    });
  }
  if (next.startStep !== previous.endStep) {
    issues.push({
      code: "step_discontinuity",
      message: "Segment step boundaries have a gap/overlap",
    });
  }
  if (Math.abs(next.startTimePs - previous.endTimePs) > tolerance) {
    issues.push({
      code: "time_discontinuity",
      message: "Segment time boundaries have a gap/overlap",
    });
  }
  return { continuous: issues.length === 0, issues };
}
