import {
  computePlanDigest,
  computeProtocolDigest,
  computeSkillGraphDigest,
} from "@eigengrid/mission-runtime";
import {
  EvidenceReferenceSchema,
  canonicalJson,
  digestCanonical,
} from "@eigengrid/scientific-schema";
import { z } from "zod";
import { currentMissionContext, missionAccess } from "./authority";
import { candidateEvidenceId } from "./candidates";
import {
  type MissionApplicationContext,
  MissionApplicationError,
  type MissionApplicationState,
} from "./contracts";
import { missionVerifyEvidence, requiredEvidenceIds } from "./evidence";
import { missionRequestMdApproval } from "./md-approvals";
import { missionPolicy, missionVerifyMd } from "./md-validation";
import { Import, computeMissionCandidateDigest } from "./requests";

export async function missionImportCandidate<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
  value: z.input<typeof Import>,
) {
  const input = Import.parse(value);
  const context = await currentMissionContext(application);
  await missionAccess(application, input, context);
  const candidate = input.candidate;
  if (
    candidate.plan.missionId !== input.missionId ||
    computeMissionCandidateDigest(candidate) !== input.expectedCandidateDigest ||
    candidate.candidateDigest !== input.expectedCandidateDigest
  )
    throw new MissionApplicationError(
      "CANDIDATE_CHANGED",
      "Candidate manifest differs from the exact requested digest or mission",
    );
  const { protocolDigest, ...protocolMaterial } = candidate.plan.protocol;
  if (
    candidate.plan.planDigest !== computePlanDigest(candidate.plan) ||
    protocolDigest !== computeProtocolDigest(protocolMaterial) ||
    candidate.plan.skillResolution.graphDigest !==
      computeSkillGraphDigest(candidate.plan.skillResolution)
  )
    throw new MissionApplicationError(
      "INVALID_CANDIDATE",
      "Candidate plan, protocol, or skill graph digest is invalid",
    );
  const provenance = await application.options.store.getMissionProvenance(input.missionId);
  if (
    candidate.plan.status !== "under_review" ||
    candidate.plan.revision !== 1 ||
    candidate.plan.missingInputs.length ||
    candidate.decisions.some(
      (decision) => decision.missionId !== input.missionId || decision.planId !== candidate.plan.id,
    ) ||
    new Set(candidate.decisions.map((decision) => decision.id)).size !==
      candidate.decisions.length ||
    digestCanonical([...candidate.plan.protocol.decisions].sort()) !==
      digestCanonical(candidate.decisions.map((decision) => decision.id).sort())
  )
    throw new MissionApplicationError(
      "INVALID_CANDIDATE",
      "Candidate must contain a complete under-review plan and its exact decisions",
    );
  const existingPlan = provenance.plans.find((plan) => plan.id === candidate.plan.id);
  if (
    !existingPlan &&
    !["created", "scoping", "blocked", "paused", "planning", "replanning"].includes(
      provenance.mission.state,
    )
  ) {
    throw new MissionApplicationError(
      "CONFLICT",
      `Mission ${input.missionId} cannot import a new plan from ${provenance.mission.state}`,
    );
  }
  if (existingPlan && existingPlan.planDigest !== candidate.plan.planDigest) {
    throw new MissionApplicationError(
      "CANDIDATE_CHANGED",
      "Imported plan differs from its persisted revision",
    );
  }
  const parent = [...provenance.plans].sort((left, right) => right.version - left.version)[0];
  if (
    !existingPlan &&
    (candidate.plan.version !== (parent?.version ?? 0) + 1 ||
      candidate.plan.parentPlanId !== parent?.id)
  )
    throw new MissionApplicationError("CONFLICT", "Candidate plan version or parent is stale");
  if (input.approvalExpiresAt && Date.parse(input.approvalExpiresAt) <= application.now().getTime())
    throw new MissionApplicationError(
      "INVALID_CANDIDATE",
      "Candidate approval expiration must be in the future",
    );
  if (
    candidate.plan.protocol.objectiveId !== provenance.mission.objective.id ||
    digestCanonical(candidate.plan.protocol.system) !==
      digestCanonical(provenance.mission.objective.system)
  )
    throw new MissionApplicationError(
      "INVALID_CANDIDATE",
      "Candidate objective must match the durable mission",
    );
  await missionVerifyEvidence(application, candidate.evidence, input.missionId);
  for (const item of candidate.evidence) {
    const existing = provenance.evidence.find((entry) => entry.id === item.id);
    if (existing && digestCanonical(existing) !== digestCanonical(item))
      throw new MissionApplicationError(
        "CANDIDATE_CHANGED",
        "Candidate evidence differs from its immutable durable identity",
      );
  }
  const allEvidence = [...provenance.evidence, ...candidate.evidence];
  for (const id of requiredEvidenceIds(candidate)) {
    const evidence = allEvidence.find((item) => item.id === id);
    if (!evidence)
      throw new MissionApplicationError(
        "INVALID_CANDIDATE",
        `Candidate input evidence ${id} is absent`,
      );
    await missionVerifyEvidence(application, [evidence], input.missionId);
  }
  if (candidate.md) await missionVerifyMd(application, candidate, context, allEvidence);
  const policy = missionPolicy(application, candidate, context);
  if (
    candidate.plan.requiredApprovals.length !== 1 ||
    candidate.plan.requiredApprovals[0] !== policy.minimumApprovalRole
  )
    throw new MissionApplicationError(
      "INVALID_CANDIDATE",
      "Candidate approval role does not match current policy",
    );
  if (
    candidate.plan.skillResolution.environmentDigest !==
    (candidate.md
      ? context.mdEnvironment!.environmentDigest
      : context.environment.environmentDigest)
  )
    throw new MissionApplicationError(
      "ENVIRONMENT_CHANGED",
      "Candidate environment digest differs from current environment",
    );
  const { candidateDigest, ...material } = candidate;
  const stored = await application.options.artifacts.put(
    new TextEncoder().encode(canonicalJson(material)),
  );
  if (stored.digest !== candidateDigest)
    throw new MissionApplicationError(
      "INVALID_CANDIDATE",
      "Candidate CAS material digest mismatch",
    );
  await missionAccess(application, input, context);
  for (const evidence of candidate.evidence)
    await application.options.store.createEvidence(evidence);
  await application.options.store.createEvidence(
    EvidenceReferenceSchema.parse({
      id: candidateEvidenceId(candidate.plan.id),
      missionId: input.missionId,
      kind: "human_review",
      uri: stored.uri,
      contentDigest: stored.digest,
      immutable: true,
      sourceId: candidate.plan.id,
      createdAt: candidate.plan.createdAt,
    }),
  );
  const approval = await application.options.service.importPlanInProject({
    authenticatedActor: context.authenticatedActor,
    projectId: input.projectId,
    plan: candidate.plan,
    decisions: candidate.decisions,
    currentPolicyDigest: policy.policyDigest,
    minimumApprovalRole: policy.minimumApprovalRole,
    approvalExpiresAt: input.approvalExpiresAt,
  });
  if (candidate.md) {
    const mdStore = application.options.mdStore!;
    const existingProtocol = await mdStore.getProtocol(
      candidate.md.protocol.id,
      candidate.md.protocol.revision,
    );
    if (!existingProtocol)
      await mdStore.putProtocol(candidate.md.protocol, {
        planId: candidate.plan.id,
        planVersion: candidate.plan.version,
      });
    else if (existingProtocol.protocolDigest !== candidate.md.protocol.protocolDigest)
      throw new MissionApplicationError(
        "CANDIDATE_CHANGED",
        "Persisted MD protocol differs from candidate",
      );
    await missionRequestMdApproval(application, candidate, context, input.approvalExpiresAt);
  }
  return {
    missionId: input.missionId,
    planId: candidate.plan.id,
    candidateDigest,
    approval,
    state: (await application.options.store.getMission(input.missionId))!.state,
  };
}
