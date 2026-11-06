import { ContentAddressedStoreError } from "@eigengrid/mission-runtime";
import { type EvidenceReference } from "@eigengrid/scientific-schema";
import {
  type MissionApplicationContext,
  MissionApplicationError,
  type MissionApplicationState,
} from "./contracts";
import { type MissionCandidate } from "./requests";

export function requiredEvidenceIds(candidate: MissionCandidate): Set<string> {
  const ids = new Set([
    candidate.plan.protocol.system.evidenceId,
    ...candidate.decisions.flatMap((decision) => decision.evidenceRefs),
    ...candidate.plan.assumptions.flatMap((assumption) => assumption.evidenceRefs),
  ]);
  for (const step of candidate.plan.protocol.engineAgnosticSteps) {
    const execution = step.parameters.execution as { inputEvidenceId?: unknown } | undefined;
    if (typeof execution?.inputEvidenceId === "string") ids.add(execution.inputEvidenceId);
  }
  return ids;
}

export async function missionVerifyEvidence<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
  evidence: readonly EvidenceReference[],
  missionId: string,
): Promise<void> {
  const ids = new Set<string>();
  for (const item of evidence) {
    if (
      item.missionId !== missionId ||
      !item.immutable ||
      ids.has(item.id) ||
      item.uri !== `cas://sha256/${item.contentDigest}`
    )
      throw new MissionApplicationError(
        "INVALID_CANDIDATE",
        "Candidate evidence must be unique, immutable CAS evidence in this mission",
      );
    ids.add(item.id);
    try {
      await application.options.artifacts.verify(item.contentDigest);
    } catch (error) {
      if (
        error instanceof ContentAddressedStoreError &&
        ["NOT_FOUND", "DIGEST_MISMATCH"].includes(error.code)
      ) {
        throw new MissionApplicationError(
          error.code === "NOT_FOUND" ? "INVALID_CANDIDATE" : "CANDIDATE_CHANGED",
          error.message,
        );
      }
      throw error;
    }
  }
}
