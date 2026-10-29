import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  AmberPilotCandidateSchema,
  MdWorkflowProtocolSchema,
  assertAmberPilotCandidateDigest,
  computeAmberPilotCandidateDigest,
} from "@eigengrid/scientific-schema";
import {
  AMBER_PILOT_CANDIDATE_NOT_EXECUTABLE,
  AmberPilotCandidateNotExecutableError,
  assertAmberPilotCandidateNotExecutable,
  compileAmberPilotCandidateForReview,
  loadAmberPilotCandidate,
} from "@eigengrid/scientific-agent";

const candidatePath = fileURLToPath(
  new URL("../../examples/amber/ace-ala-nme-explicit-cpu-v1.candidate.json", import.meta.url),
);

async function candidateJson(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(candidatePath, "utf8")) as Record<string, unknown>;
}

describe("ACE–ALA–NME M2 pilot candidate", () => {
  test("loads a self-digested blocked review proposal without creating executable authority", async () => {
    const candidate = await loadAmberPilotCandidate(candidatePath);
    expect(candidate.status).toBe("candidate");
    expect(candidate.executionEligibility).toBe("blocked_pending_am02_and_scientific_review");
    expect(candidate.stages.map((stage) => stage.id)).toEqual([
      "min-01",
      "min-02",
      "heating",
      "equilibration-01",
      "equilibration-02",
      "production-01",
      "production-02",
    ]);
    expect(candidate.system).toMatchObject({
      forceFields: { protein: "ff14SB", water: "TIP3P" },
      solvation: { paddingAngstrom: 12, addedSalt: false, maximumAtomCount: 5000 },
      nonbonded: { cutoffAngstrom: 8, electrostatics: "PME" },
    });
    const review = compileAmberPilotCandidateForReview(candidate);
    expect(review).toMatchObject({
      state: "blocked",
      candidateId: candidate.id,
      candidateDigest: candidate.candidateDigest,
    });
    expect(review.blockers).toContain("am02-published-system");
    expect(review.blockers).toContain("m2-qc-and-cpptraj");
  });

  test("material changes require a new digest and neither foreign execution IDs nor approvals parse", async () => {
    const original = await candidateJson();
    const originalCandidate = assertAmberPilotCandidateDigest(original);
    const changed = {
      ...original,
      system: {
        ...(original.system as Record<string, unknown>),
        nonbonded: {
          ...((original.system as Record<string, unknown>).nonbonded as Record<string, unknown>),
          cutoffAngstrom: 9,
        },
      },
    };
    const changedDigest = computeAmberPilotCandidateDigest(changed);
    expect(changedDigest).not.toBe(originalCandidate.candidateDigest);
    expect(() => assertAmberPilotCandidateDigest(changed)).toThrow(/digest/i);
    expect(
      assertAmberPilotCandidateDigest({ ...changed, candidateDigest: changedDigest })
        .candidateDigest,
    ).toBe(changedDigest);
    expect(() => AmberPilotCandidateSchema.parse({ ...original, approvalRef: "forged" })).toThrow();
    expect(() =>
      AmberPilotCandidateSchema.parse({ ...original, topologyDigest: "a".repeat(64) }),
    ).toThrow();
    expect(() => AmberPilotCandidateSchema.parse({ ...original, slurmJobId: "999" })).toThrow();
  });

  test("fails closed for missing blockers, forged eligibility, workflow compilation shape and execution attempts", async () => {
    const original = await candidateJson();
    expect(() =>
      AmberPilotCandidateSchema.parse({ ...original, blockingRequirements: [] }),
    ).toThrow();
    expect(() =>
      AmberPilotCandidateSchema.parse({ ...original, executionEligibility: "eligible" }),
    ).toThrow();
    expect(MdWorkflowProtocolSchema.safeParse(original).success).toBe(false);
    expect(() => assertAmberPilotCandidateNotExecutable(original)).toThrow(
      AmberPilotCandidateNotExecutableError,
    );
    try {
      assertAmberPilotCandidateNotExecutable(original);
    } catch (error) {
      expect((error as AmberPilotCandidateNotExecutableError).code).toBe(
        AMBER_PILOT_CANDIDATE_NOT_EXECUTABLE,
      );
    }
  });

  test("rejects internally inconsistent candidate controls before scientific review", async () => {
    const original = await candidateJson();
    const stages = original.stages as Array<Record<string, unknown>>;
    const heating = stages[2]!;
    const production = stages[5]!;
    const minimization = stages[0]!;

    expect(() =>
      AmberPilotCandidateSchema.parse({
        ...original,
        stages: [{ ...minimization, ensemble: "npt", pressureBar: 1 }, ...stages.slice(1)],
      }),
    ).toThrow(/minimization|non-dynamic/u);
    expect(() =>
      AmberPilotCandidateSchema.parse({
        ...original,
        stages: [...stages.slice(0, 2), { ...heating, stepCount: 25_001 }, ...stages.slice(3)],
      }),
    ).toThrow(/dynamic-stage/u);
    expect(() =>
      AmberPilotCandidateSchema.parse({
        ...original,
        stages: [...stages.slice(0, 5), { ...production, pressureBar: null }, ...stages.slice(6)],
      }),
    ).toThrow(/NPT/u);
    expect(() =>
      AmberPilotCandidateSchema.parse({
        ...original,
        stages: [
          {
            ...minimization,
            shake: { enabled: false, tolerance: 0.00001, maximumIterations: 10 },
          },
          ...stages.slice(1),
        ],
      }),
    ).toThrow(/SHAKE/u);
    expect(() =>
      AmberPilotCandidateSchema.parse({
        ...original,
        system: {
          ...(original.system as Record<string, unknown>),
          solvation: {
            ...((original.system as Record<string, unknown>).solvation as Record<string, unknown>),
            maximumAtomCount: 5_001,
          },
        },
      }),
    ).toThrow();
    expect(() =>
      AmberPilotCandidateSchema.parse({
        ...original,
        stages: [
          {
            ...minimization,
            shake: { enabled: true, tolerance: null, maximumIterations: 3_001 },
          },
          ...stages.slice(1),
        ],
      }),
    ).toThrow(/minimization|SHAKE/u);
    expect(() =>
      AmberPilotCandidateSchema.parse({
        ...original,
        stages: [
          ...stages.slice(0, 2),
          {
            ...heating,
            ensemble: "npt",
            pressureBar: 1,
            barostat: { kind: "monte_carlo_isotropic", relaxationTimePs: null },
          },
          ...stages.slice(3),
        ],
      }),
    ).toThrow(/heating.*NVT/u);
    expect(() =>
      AmberPilotCandidateSchema.parse({
        ...original,
        stages: [
          ...stages.slice(0, 2),
          { ...heating, timeStepFs: 1_000, stepCount: 25 },
          ...stages.slice(3),
        ],
      }),
    ).toThrow(/dynamic-stage/u);
  });
});
