import { compileMdWorkflowProtocol } from "@eigengrid/scientific-agent";
import {
  assertPublishedBiomolecularSystemManifestDigest,
  digestCanonical,
  type ApprovalRequest,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import { missionBelongsToCandidate } from "./approval-binding";
import { missionAccess } from "./authority";
import {
  MissionApplicationError,
  type MissionApplicationContext,
  type MissionApplicationState,
} from "./contracts";
import { assertCompletedMdPredecessor } from "./md-predecessor";
import { type MissionCandidate } from "./requests";

export async function missionCompileMd<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
  candidate: MissionCandidate,
  context: C,
  projectId: string,
) {
  const md = candidate.md!;
  const policy = context.mdCompilerPolicy!;
  const provenance = await application.options.store.getMissionProvenance(candidate.plan.missionId);
  const plan = provenance.plans.find((item) => item.id === candidate.plan.id)!;
  if (plan.status !== "approved")
    throw new MissionApplicationError("APPROVAL_REQUIRED", "MD plan requires exact human approval");
  const approvals = provenance.approvals.filter(
    (item) =>
      missionBelongsToCandidate(item, candidate, provenance) &&
      item.state === "approved" &&
      item.policyDigest ===
        (item.subjectType === "decision"
          ? (md.protocol.preparationPolicyDigest ?? policy.policyDigest)
          : policy.policyDigest),
  );
  const find = (type: ApprovalRequest["subjectType"], id: string) => {
    const item = approvals.find((value) => value.subjectType === type && value.subjectId === id);
    if (!item)
      throw new MissionApplicationError(
        "APPROVAL_REQUIRED",
        `MD subject ${id} requires exact human approval`,
      );
    return item;
  };
  const planApproval = find("plan", plan.id),
    systemApproval = find("biomolecular_system_manifest", md.system.id),
    protocolApproval = find("md_protocol", md.protocol.id);
  const decisionApprovals = md.decisionRefs.map((item) => {
    const approval = find("decision", item.id);
    if (approval.id !== item.approvalRef)
      throw new MissionApplicationError(
        "APPROVAL_REQUIRED",
        "MD decision approval differs from frozen preparation",
      );
    return approval;
  });
  for (const approval of [planApproval, systemApproval, protocolApproval, ...decisionApprovals])
    await application.options.store.assertApprovalValid(approval.id, {
      now: application.now().toISOString(),
      currentPolicyDigest:
        approval.subjectType === "decision"
          ? (md.protocol.preparationPolicyDigest ?? policy.policyDigest)
          : policy.policyDigest,
    });
  const system = assertPublishedBiomolecularSystemManifestDigest(
    await application.options.mdStore!.getSystemManifest(md.system.id, md.system.revision),
  );
  const protocol = (await application.options.mdStore!.getProtocol(
    md.protocol.id,
    md.protocol.revision,
  ))!;
  const compiled = compileMdWorkflowProtocol({
    plan: {
      id: plan.id,
      missionId: plan.missionId,
      version: plan.version,
      revision: plan.revision,
      status: "approved",
      planDigest: plan.planDigest,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    },
    planApproval,
    system,
    systemApproval,
    protocol,
    protocolApproval,
    decisionRefs: md.decisionRefs,
    decisionApprovals,
    stageSkillBindings: md.stageSkillBindings,
    policy,
    environment: context.mdEnvironment!,
  });
  // Lifecycle state is mutable; scientific definitions remain byte-exact on retries.
  const definition = (work: WorkUnit) => {
    const {
      state: _state,
      revision: _revision,
      claimOwner: _owner,
      claimExpiresAt: _expiry,
      jobId: _job,
      attemptId: _attempt,
      updatedAt: _at,
      ...material
    } = work;
    return digestCanonical(material);
  };
  const missing: WorkUnit[] = [];
  for (const work of compiled.workUnits) {
    const existing = await application.options.store.getWorkUnit(work.id);
    if (existing && definition(existing) !== definition(work))
      throw new MissionApplicationError(
        "CANDIDATE_CHANGED",
        "Persisted MD work unit differs from exact compiled candidate",
      );
    if (!existing) missing.push(work);
  }
  await missionAccess(application, { projectId, missionId: plan.missionId }, context);
  await application.options.store.createWorkUnits(missing);
  let mission = (await application.options.store.getMission(plan.missionId))!;
  if (mission.activePlanId !== null && mission.activePlanId !== plan.id) {
    const current = await application.options.store.getMissionProvenance(mission.id);
    assertCompletedMdPredecessor({
      state: mission.state,
      activePlanId: mission.activePlanId,
      parentPlanId: plan.parentPlanId,
      workUnits: current.workUnits,
      operations: current.operations,
      plans: current.plans,
      approvals: current.approvals,
    });
  }
  if (mission.activePlanId !== plan.id)
    mission = await application.options.store.activatePlan({
      missionId: mission.id,
      planId: plan.id,
      expectedMissionRevision: mission.revision,
      actor: context.authenticatedActor,
      at: application.now().toISOString(),
    });
  if (mission.activePlanId !== plan.id)
    throw new MissionApplicationError("CONFLICT", "A different plan is already active");
  if (mission.state === "awaiting_approval")
    await application.options.store.transitionMission({
      missionId: mission.id,
      expectedRevision: mission.revision,
      to: "ready",
      reason: `human_md_candidate_compiled:${compiled.graphDigest}`,
      actor: context.authenticatedActor,
      at: application.now().toISOString(),
    });
  else if (
    ![
      "ready",
      "executing",
      "observing",
      "diagnosing",
      "validating",
      "completed",
      "paused",
      "blocked",
    ].includes(mission.state)
  )
    throw new MissionApplicationError(
      "CONFLICT",
      "Mission cannot reuse compiled MD candidate in its current state",
    );
  for (const work of compiled.workUnits) {
    const persisted = (await application.options.store.getWorkUnit(work.id))!;
    if (persisted.state === "created")
      await application.options.store.transitionWorkUnit({
        workUnitId: persisted.id,
        expectedRevision: persisted.revision,
        to: "ready",
        at: application.now().toISOString(),
      });
  }
  return compiled;
}
