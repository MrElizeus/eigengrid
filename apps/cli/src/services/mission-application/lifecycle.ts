import {
  ScientificApprovalPolicyMismatchError,
  ScientificRevisionConflictError,
} from "@eigengrid/mission-runtime";
import {
  MdExecutionBindingParametersSchema,
  ScientificMissionSchema,
} from "@eigengrid/scientific-schema";
import { z } from "zod";
import { missionBelongsToCandidate } from "./approval-binding";
import { currentMissionContext, missionAccess } from "./authority";
import { missionExactCandidate } from "./candidates";
import {
  type MissionApplicationContext,
  MissionApplicationError,
  type MissionApplicationState,
} from "./contracts";
import { missionVerifyEvidence } from "./evidence";
import { missionVerifyInputs } from "./inputs";
import { missionCompileMd } from "./md-compilation";
import { missionPolicy } from "./md-validation";
import { Cancel, Create, ExactCandidate, ReplanUnstarted } from "./requests";

export async function missionCreate<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
  value: z.input<typeof Create>,
) {
  const input = Create.parse(value);
  const context = await currentMissionContext(application);
  await missionVerifyEvidence(application, input.objectiveEvidence, input.mission.id);
  await application.options.authority.assertCurrent(context);
  return application.options.service.createMissionInProject({
    ...input,
    authenticatedActor: context.authenticatedActor,
    mission: ScientificMissionSchema.parse({
      ...input.mission,
      requestedBy: context.authenticatedActor,
      policyProfile: context.compilerPolicy.id,
    }),
  });
}

export async function missionCompile<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
  value: z.input<typeof ExactCandidate>,
) {
  const input = ExactCandidate.parse(value);
  const context = await currentMissionContext(application);
  await missionAccess(application, input, context);
  const candidate = await missionExactCandidate(application, input);
  await missionVerifyInputs(application, candidate, context);
  await missionAccess(application, input, context);
  if (!candidate.md) {
    const provenance = await application.options.store.getMissionProvenance(input.missionId);
    const approved = provenance.approvals.filter(
      (request) =>
        request.subjectType === "plan" &&
        request.subjectId === candidate.plan.id &&
        request.subjectVersion === candidate.plan.version &&
        request.subjectRevision === candidate.plan.revision &&
        request.payloadDigest === candidate.plan.planDigest &&
        request.state === "approved",
    );
    if (!approved.some((request) => request.policyDigest === context.compilerPolicy.policyDigest)) {
      if (approved[0])
        throw new ScientificApprovalPolicyMismatchError(
          approved[0].id,
          approved[0].policyDigest,
          context.compilerPolicy.policyDigest,
        );
      throw new MissionApplicationError(
        "APPROVAL_REQUIRED",
        `Plan ${candidate.plan.id} has no current exact-revision approval`,
      );
    }
    return application.options.service.compileApprovedPlanInProject({
      ...input,
      authenticatedActor: context.authenticatedActor,
      compilerPolicy: context.compilerPolicy,
      environment: context.environment,
    });
  }
  return missionCompileMd(application, candidate, context, input.projectId);
}

export async function missionStart<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
  value: z.input<typeof ExactCandidate>,
) {
  const input = ExactCandidate.parse(value);
  // Recompilation revalidates current approvals, expiry, inputs, environment and exact DAG.
  await missionCompile(application, input);
  const context = await currentMissionContext(application);
  await missionAccess(application, input, context);
  const candidate = await missionExactCandidate(application, input);
  await missionVerifyInputs(application, candidate, context);
  const policy = missionPolicy(application, candidate, context);
  const provenance = await application.options.store.getMissionProvenance(input.missionId);
  const approvals = provenance.approvals.filter(
    (item) => missionBelongsToCandidate(item, candidate, provenance) && item.state === "approved",
  );
  for (const approval of approvals) {
    const historicalPreparation = candidate.md?.protocol.preparationPolicyDigest;
    const preservedDecision = candidate.md?.decisionRefs.some(
      (ref) => ref.approvalRef === approval.id,
    );
    const completedPreparation =
      approval.subjectType === "operation" &&
      provenance.operations.some(
        (operation) => operation.id === approval.subjectId && operation.state === "confirmed",
      );
    await application.options.store.assertApprovalValid(approval.id, {
      now: application.now().toISOString(),
      currentPolicyDigest:
        historicalPreparation && (preservedDecision || completedPreparation)
          ? historicalPreparation
          : policy.policyDigest,
    });
  }
  await missionAccess(application, input, context);
  try {
    return await application.options.service.startExecutionInProject({
      ...input,
      authenticatedActor: context.authenticatedActor,
    });
  } catch (error) {
    if (
      !(error instanceof ScientificRevisionConflictError) ||
      error.details.entity !== "mission" ||
      error.details.id !== input.missionId
    )
      throw error;
    // A concurrent exact start may win the mission runtime's revision CAS. Observe its durable
    // proof without retrying the transition or granting any new effect.
    const observed = await missionReconcileStart(application, input);
    if (observed) return observed;
    throw error;
  }
}

/** Read back the mission runtime's exact mission-start transition after a lost acknowledgement.
 * This is proof of durable admission only; it never certifies a Slurm/MD effect. */
export async function missionReconcileStart<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
  value: z.input<typeof ExactCandidate>,
) {
  const input = ExactCandidate.parse(value);
  const context = await currentMissionContext(application);
  await missionAccess(application, input, context);
  const candidate = await missionExactCandidate(application, input);
  const provenance = await application.options.store.getMissionProvenance(input.missionId);
  if (
    provenance.mission.activePlanId !== candidate.plan.id ||
    !["executing", "observing", "completed", "failed", "cancelled"].includes(
      provenance.mission.state,
    ) ||
    !provenance.transitions.some(
      (item) => item.toState === "executing" && item.reason === "persistent_head_execution_started",
    )
  )
    return null;
  await missionAccess(application, input, context);
  return provenance.mission;
}

/** Versioned durable cancellation request. Never invents a scheduler kill receipt. */
export async function missionRequestCancel<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
  value: z.input<typeof Cancel>,
) {
  const input = Cancel.parse(value);
  const context = await currentMissionContext(application);
  await missionAccess(application, input, context);
  const mission = await application.options.store.getMission(input.missionId);
  if (!mission || mission.revision !== input.expectedRevision)
    throw new MissionApplicationError("CONFLICT", "Mission revision changed");
  if (
    ["completed", "failed", "cancelled", "cancel_requested", "cancelling"].includes(mission.state)
  )
    return mission;
  await missionAccess(application, input, context);
  return application.options.store.transitionMission({
    missionId: mission.id,
    expectedRevision: input.expectedRevision,
    to: "cancel_requested",
    reason: input.reason,
    actor: context.authenticatedActor,
    at: application.now().toISOString(),
  });
}

/** Withdraw only an unstarted MD phase. Never touches a live or acknowledged effect. */
export async function missionReplanUnstarted<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
  value: z.input<typeof ReplanUnstarted>,
) {
  const input = ReplanUnstarted.parse(value),
    context = await currentMissionContext(application);
  await missionAccess(application, input, context);
  const candidate = await missionExactCandidate(application, input);
  if (!candidate.md)
    throw new MissionApplicationError(
      "CONFLICT",
      "Unstarted replanning is restricted to MD candidates",
    );
  let provenance = await application.options.store.getMissionProvenance(input.missionId);
  let mission = provenance.mission;
  const planUnits = provenance.workUnits.filter((w) => w.planId === input.planId);
  const units = planUnits.filter(
    (w) => MdExecutionBindingParametersSchema.safeParse(w.protocolFragment.parameters).success,
  );
  const otherUnits = planUnits.filter((w) => !units.includes(w));
  const otherIds = new Set(otherUnits.map((w) => w.id));
  const ids = new Set(units.map((w) => w.id));
  if (
    mission.activePlanId !== input.planId ||
    units.length === 0 ||
    otherUnits.some((w) => !["succeeded", "cancelled"].includes(w.state)) ||
    provenance.operations.some(
      (op) => otherIds.has(op.workUnitId) && !["confirmed", "abandoned"].includes(op.state),
    ) ||
    !["ready", "paused", "replanning"].includes(mission.state) ||
    units.some(
      (w) =>
        !["created", "ready", "cancel_requested", "cancelled"].includes(w.state) ||
        w.jobId ||
        w.attemptId ||
        w.claimOwner,
    ) ||
    provenance.operations.some((op) => ids.has(op.workUnitId))
  )
    throw new MissionApplicationError(
      "CONFLICT",
      "Replanning requires an unstarted active MD plan with no claims or effects",
    );
  await missionAccess(application, input, context);
  const at = application.now().toISOString();
  if (mission.state === "ready")
    mission = await application.options.store.transitionMission({
      missionId: mission.id,
      expectedRevision: mission.revision,
      to: "paused",
      reason: "withdraw_unstarted_md:" + input.reason,
      actor: context.authenticatedActor,
      at,
    });
  for (let work of units) {
    if (!["cancel_requested", "cancelled"].includes(work.state))
      work = await application.options.store.transitionWorkUnit({
        workUnitId: work.id,
        expectedRevision: work.revision,
        to: "cancel_requested",
        at,
      });
    if (work.state !== "cancelled")
      await application.options.store.transitionWorkUnit({
        workUnitId: work.id,
        expectedRevision: work.revision,
        to: "cancelled",
        at,
      });
  }
  if (mission.state !== "replanning")
    mission = await application.options.store.transitionMission({
      missionId: mission.id,
      expectedRevision: mission.revision,
      to: "replanning",
      reason: "withdraw_unstarted_md:" + input.reason,
      actor: context.authenticatedActor,
      at,
    });
  return {
    missionId: mission.id,
    planId: input.planId,
    state: mission.state,
    cancelledWorkUnitIds: [...ids],
    mdDispatched: false,
  };
}
