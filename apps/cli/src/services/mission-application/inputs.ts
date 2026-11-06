import { type MissionProvenance } from "@eigengrid/mission-runtime";
import {
  BiomolecularSystemBuildRequestSchema,
  BiomolecularSystemBuildRequestSchemaVersion,
  BiomolecularSystemBuildWorkUnitParametersSchema,
  type ApprovalRequest,
} from "@eigengrid/scientific-schema";
import {
  MissionApplicationError,
  type MissionApplicationContext,
  type MissionApplicationState,
} from "./contracts";
import { missionVerifyEvidence, requiredEvidenceIds } from "./evidence";
import { missionVerifyMd } from "./md-validation";
import { type MissionCandidate } from "./requests";

export async function missionVerifyInputs<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
  candidate: MissionCandidate,
  context: C,
) {
  const provenance = await application.options.store.getMissionProvenance(candidate.plan.missionId);
  await missionVerifyEvidence(application, candidate.evidence, candidate.plan.missionId);
  const objective = provenance.evidence.find(
    (item) => item.id === provenance.mission.objective.system.evidenceId,
  );
  if (!objective || objective.contentDigest !== provenance.mission.objective.system.contentDigest)
    throw new MissionApplicationError(
      "CANDIDATE_CHANGED",
      "Objective input evidence is absent or changed",
    );
  await missionVerifyEvidence(application, [objective], candidate.plan.missionId);
  for (const id of requiredEvidenceIds(candidate)) {
    const reference = provenance.evidence.find((item) => item.id === id);
    if (!reference)
      throw new MissionApplicationError(
        "INVALID_CANDIDATE",
        `Candidate input evidence ${id} is absent`,
      );
    await missionVerifyEvidence(application, [reference], candidate.plan.missionId);
  }
  const environmentDigest = candidate.md
    ? context.mdEnvironment?.environmentDigest
    : context.environment.environmentDigest;
  if (candidate.plan.skillResolution.environmentDigest !== environmentDigest)
    throw new MissionApplicationError(
      "ENVIRONMENT_CHANGED",
      "Current environment differs from reviewed candidate",
    );
  if (candidate.md) await missionVerifyMd(application, candidate, context, provenance.evidence);
}

export async function missionVerifySystemBuildApprovalInputs<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
  approval: ApprovalRequest,
  candidate: MissionCandidate,
  provenance: MissionProvenance,
): Promise<void> {
  if (approval.subjectType !== "operation") return;
  const operation = provenance.operations.find((item) => item.id === approval.subjectId);
  const parsed = operation
    ? BiomolecularSystemBuildRequestSchema.safeParse(operation.request)
    : undefined;
  if (
    !operation ||
    !parsed?.success ||
    parsed.data.schemaVersion !== BiomolecularSystemBuildRequestSchemaVersion
  )
    return;
  const workUnit = provenance.workUnits.find((item) => item.id === operation.workUnitId);
  const parameters = workUnit
    ? BiomolecularSystemBuildWorkUnitParametersSchema.safeParse(
        workUnit.protocolFragment.parameters,
      )
    : undefined;
  if (!workUnit || !parameters?.success) return;
  const binding = parameters.data.systemBuild;
  const refs = [...binding.sourceEvidenceRefs, binding.forceFieldStackEvidenceRef];
  const evidence = refs.map((id) => {
    const matches = provenance.evidence.filter((item) => item.id === id);
    if (matches.length !== 1) {
      throw new MissionApplicationError(
        "CANDIDATE_CHANGED",
        `System-build evidence ${id} is missing or ambiguous`,
      );
    }
    return matches[0]!;
  });
  const requestEvidence = new Map(parsed.data.sourceEvidence.map((item) => [item.id, item]));
  if (
    evidence.some((item) =>
      item.id === binding.forceFieldStackEvidenceRef
        ? item.contentDigest !== binding.forceFieldStack.digest || item.kind !== "force_field_stack"
        : requestEvidence.get(item.id)?.contentDigest !== item.contentDigest,
    )
  )
    throw new MissionApplicationError(
      "CANDIDATE_CHANGED",
      "System-build CAS evidence no longer matches the reviewed request",
    );
  await missionVerifyEvidence(application, evidence, candidate.plan.missionId);
}
