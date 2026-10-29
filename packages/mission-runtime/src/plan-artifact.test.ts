import { describe, expect, test } from "bun:test";
import { appendFileSync, rmSync } from "node:fs";
import {
  DurablePlanArtifactStore,
  PLAN_MUTATING_CAPABILITIES,
  PlanCapabilityRegistry,
  createPlanApproval,
  createPlanArtifact,
  validateExactPlanApproval,
  verifyPlanArtifact,
} from "./plan-artifact";

function artifact(revision = 1) {
  return createPlanArtifact({
    planId: "plan-1",
    revision,
    priorRevision: revision > 1 ? revision - 1 : null,
    objective: {
      projectId: "project-1",
      missionId: "mission-1",
      objectiveId: "objective-1",
      revision: 1,
      digest: `sha256:${"1".repeat(64)}`,
    },
    problem: "qualify a deterministic calculation",
    nonGoals: ["publication"],
    assumptions: [],
    contradictions: [],
    humanInputs: [],
    evidence: [],
    alternatives: [{ id: "local", tradeoffs: [] }],
    selectedAlternative: "local",
    scientificDecisions: [],
    workGraph: { nodes: [] },
    environments: [],
    resources: [],
    risks: [],
    approvalPolicy: { roles: ["reviewer"] },
    validation: [{ id: "valid" }],
    recovery: { retry: false },
    budgets: { calls: 1 },
    critiques: [],
    limitations: ["not lab qualified"],
  });
}

describe("ScientificPlanArtifact/v1", () => {
  test("binds a canonical material digest and rejects tampering", () => {
    const value = artifact();
    expect(verifyPlanArtifact(value)).toEqual({ ok: true, artifact: value });
    expect(verifyPlanArtifact({ ...value, problem: "changed" }).ok).toBe(false);
  });

  test("persists append-only revisions and survives reopening", async () => {
    const path = `/tmp/eigengrid-plan-${Date.now()}-${Math.random()}.jsonl`;
    const first = new DurablePlanArtifactStore(path);
    await first.put(artifact());
    await first.put(artifact(2));
    expect((await first.list("plan-1")).map((entry) => entry.revision)).toEqual([1, 2]);
    const reopened = new DurablePlanArtifactStore(path);
    expect((await reopened.get("plan-1"))?.revision).toBe(2);
  });

  test("fails closed when a persisted revision is tampered", async () => {
    const path = `/tmp/eigengrid-plan-corrupt-${Date.now()}-${Math.random()}.jsonl`;
    try {
      appendFileSync(
        path,
        JSON.stringify({ schema: "eigengrid.scientific-plan-artifact.v1" }) + "\n",
      );
      await expect(new DurablePlanArtifactStore(path).list()).rejects.toThrow(
        "invalid plan artifact",
      );
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("keeps a corrupt journal failed after the first recovery attempt", async () => {
    const path = `/tmp/eigengrid-plan-corrupt-sticky-${Date.now()}-${Math.random()}.jsonl`;
    try {
      appendFileSync(path, "not-json\n");
      const store = new DurablePlanArtifactStore(path);
      await expect(store.list()).rejects.toThrow("invalid plan artifact JSON");
      await expect(store.put(artifact())).rejects.toThrow("invalid plan artifact JSON");
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("rejects an unterminated final record instead of replaying it", async () => {
    const path = `/tmp/eigengrid-plan-torn-${Date.now()}-${Math.random()}.jsonl`;
    try {
      appendFileSync(path, JSON.stringify(artifact()));
      await expect(new DurablePlanArtifactStore(path).list()).rejects.toThrow(
        "unterminated final record",
      );
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("hard Plan Mode denies all mutators and unknown methods", () => {
    const registry = new PlanCapabilityRegistry();
    for (const capability of PLAN_MUTATING_CAPABILITIES)
      expect(registry.decide(capability).allowed).toBe(false);
    expect(registry.decide("unknown.mutator").allowed).toBe(false);
    expect(registry.decide("inspect.mission").allowed).toBe(true);
  });

  test("approval is bound to exact plan/policy and expires", () => {
    const approval = createPlanApproval({
      missionId: "mission-1",
      planId: "plan-1",
      planRevision: 1,
      planDigest: `sha256:${"a".repeat(64)}`,
      policyDigest: `sha256:${"b".repeat(64)}`,
      decisionSet: ["execute"],
      decision: "approved",
      authorizedActor: { id: "reviewer-1", role: "reviewer" },
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(
      validateExactPlanApproval(approval, {
        missionId: "mission-1",
        planId: "plan-1",
        planRevision: 1,
        planDigest: approval.planDigest,
        policyDigest: approval.policyDigest,
      }),
    ).toEqual({ ok: true });
    expect(
      validateExactPlanApproval(approval, {
        missionId: "mission-1",
        planId: "plan-1",
        planRevision: 2,
        planDigest: approval.planDigest,
        policyDigest: approval.policyDigest,
      }).ok,
    ).toBe(false);
  });
});
