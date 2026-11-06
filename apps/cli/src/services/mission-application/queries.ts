import { z } from "zod";
import { missionBelongsToCandidate } from "./approval-binding";
import { currentMissionContext, missionAccess } from "./authority";
import { missionLoadCandidate } from "./candidates";
import { type MissionApplicationContext, type MissionApplicationState } from "./contracts";
import { Address, PlanAddress } from "./requests";

export async function missionRead<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
  value: z.input<typeof Address>,
) {
  const input = Address.parse(value);
  const context = await currentMissionContext(application);
  await missionAccess(application, input, context);
  return application.options.store.getMissionProvenance(input.missionId);
}

export async function missionStatus<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
  value: z.input<typeof Address>,
) {
  const provenance = await missionRead(application, value);
  return {
    missionId: provenance.mission.id,
    revision: provenance.mission.revision,
    state: provenance.mission.state,
    activePlanId: provenance.mission.activePlanId,
    pendingApprovals: provenance.approvals
      .filter((item) => item.state === "pending")
      .map((item) => item.id),
    workUnits: provenance.workUnits.map((item) => ({
      workUnitId: item.id,
      state: item.state,
      jobId: item.jobId ?? null,
      attemptId: item.attemptId ?? null,
    })),
    operations: provenance.operations.map((item) => ({
      operationId: item.id,
      workUnitId: item.workUnitId,
      state: item.state,
    })),
    validationCount: provenance.validations.length,
    qcPending: provenance.assessments.length === 0,
    scientificAssessment: provenance.assessments,
    complete: provenance.complete,
  };
}

export async function missionReview<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
  value: z.input<typeof PlanAddress>,
) {
  const input = PlanAddress.parse(value);
  const context = await currentMissionContext(application);
  await missionAccess(application, input, context);
  const candidate = await missionLoadCandidate(application, input.missionId, input.planId);
  const provenance = await application.options.store.getMissionProvenance(input.missionId);
  return {
    missionId: input.missionId,
    planId: input.planId,
    candidateDigest: candidate.candidateDigest,
    candidate,
    approvals: provenance.approvals.filter((item) =>
      missionBelongsToCandidate(item, candidate, provenance),
    ),
    state: provenance.mission.state,
  };
}
