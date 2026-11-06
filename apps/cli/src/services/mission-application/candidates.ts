import { digestCanonical } from "@eigengrid/scientific-schema";
import { z } from "zod";
import {
  type MissionApplicationContext,
  MissionApplicationError,
  type MissionApplicationState,
} from "./contracts";
import {
  ExactCandidate,
  type MissionCandidate,
  MissionCandidateSchema,
  computeMissionCandidateDigest,
} from "./requests";

export const candidateEvidenceId = (planId: string) =>
  `candidate-${digestCanonical({ planId }).slice(0, 32)}`;

export async function missionLoadCandidate<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
  missionId: string,
  planId: string,
): Promise<MissionCandidate> {
  const provenance = await application.options.store.getMissionProvenance(missionId);
  const evidence = provenance.evidence.find(
    (item) => item.id === candidateEvidenceId(planId) && item.sourceId === planId,
  );
  const plan = provenance.plans.find((item) => item.id === planId);
  if (
    !evidence ||
    !plan ||
    !evidence.immutable ||
    evidence.uri !== `cas://sha256/${evidence.contentDigest}`
  )
    throw new MissionApplicationError(
      "NOT_FOUND",
      "No durable candidate manifest exists for this plan",
    );
  const stored = await application.options.artifacts.get(evidence.contentDigest);
  const candidate = MissionCandidateSchema.parse({
    ...JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes)),
    candidateDigest: evidence.contentDigest,
  });
  if (
    candidate.plan.id !== planId ||
    candidate.plan.missionId !== missionId ||
    candidate.plan.planDigest !== plan.planDigest ||
    computeMissionCandidateDigest(candidate) !== evidence.contentDigest
  )
    throw new MissionApplicationError(
      "CANDIDATE_CHANGED",
      "Durable candidate manifest does not match persisted plan",
    );
  return candidate;
}

export async function missionExactCandidate<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
  input: z.infer<typeof ExactCandidate>,
) {
  const candidate = await missionLoadCandidate(application, input.missionId, input.planId);
  if (candidate.candidateDigest !== input.candidateDigest)
    throw new MissionApplicationError(
      "CANDIDATE_CHANGED",
      "Candidate changed since review; review the exact persisted manifest again",
    );
  return candidate;
}
