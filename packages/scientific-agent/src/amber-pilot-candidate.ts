import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  assertAmberPilotCandidateDigest,
  type AmberPilotCandidate,
} from "@eigengrid/scientific-schema";

export const AMBER_PILOT_CANDIDATE_NOT_EXECUTABLE = "AMBER_PILOT_CANDIDATE_NOT_EXECUTABLE";

/** A candidate's explicit blockers are review material, not a fallback plan. */
export class AmberPilotCandidateNotExecutableError extends Error {
  readonly code = AMBER_PILOT_CANDIDATE_NOT_EXECUTABLE;

  constructor(candidate: Pick<AmberPilotCandidate, "id" | "candidateDigest">) {
    super(
      `Amber pilot candidate ${candidate.id} is not executable until AM-02 and scientific review`,
    );
    this.name = "AmberPilotCandidateNotExecutableError";
  }
}

/**
 * Loads a review manifest from a caller-selected immutable source. The path is
 * intentionally not a browser/worker API; this helper cannot create a mission,
 * WorkUnit, approval, operation, engine request, or scheduler effect.
 */
export async function loadAmberPilotCandidate(pathValue: string): Promise<AmberPilotCandidate> {
  if (!isAbsolute(pathValue) || resolve(pathValue) !== pathValue) {
    throw new Error("Amber pilot candidate path must be canonical and absolute");
  }
  const bytes = await readFile(pathValue);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error("Amber pilot candidate is not exact UTF-8");
  }
  try {
    return assertAmberPilotCandidateDigest(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Amber pilot candidate is not JSON");
    throw error;
  }
}

export function compileAmberPilotCandidateForReview(value: unknown): {
  state: "blocked";
  candidateId: string;
  candidateDigest: string;
  blockers: readonly string[];
} {
  const candidate = assertAmberPilotCandidateDigest(value);
  return {
    state: "blocked",
    candidateId: candidate.id,
    candidateDigest: candidate.candidateDigest,
    blockers: [
      ...candidate.decisions.map((decision) => decision.id),
      ...candidate.blockingRequirements.map((requirement) => requirement.id),
    ],
  };
}

/** Fail closed if a caller tries to turn review material into an MD execution input. */
export function assertAmberPilotCandidateNotExecutable(value: unknown): never {
  throw new AmberPilotCandidateNotExecutableError(assertAmberPilotCandidateDigest(value));
}
