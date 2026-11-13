import { test, expect } from "bun:test";
import type { MissionApplication } from "../mission-application";
import { observeApplicationOperation } from "./reconciliation";
import { createReconciliationFixture } from "./reconciliation-create.fixture";

function observer(f = createReconciliationFixture()) {
  let reads = 0;
  const application = {
    read: async (address: unknown) => {
      reads++;
      expect(address).toEqual({ projectId: f.record.projectId, missionId: f.mission.id });
      return f.provenance;
    },
  } as unknown as MissionApplication;
  return {
    f,
    readCount: () => reads,
    observe: () =>
      observeApplicationOperation(f.record, application, () => {
        throw new Error("agent service must not open");
      }),
  };
}

test("complete normalized creation is proved without trusting request actor/policy fields", async () => {
  const o = observer();
  const before = structuredClone(o.f.provenance);
  expect(await o.observe()).toEqual(o.f.mission);
  expect(o.f.provenance).toEqual(before);
  const request = o.f.record.request as Record<string, unknown>;
  request.mission = {
    ...o.f.request.mission,
    requestedBy: { id: "admin", kind: "human", role: "scientific_reviewer" },
    policyProfile: "injected-policy",
  };
  expect(await o.observe()).toBeNull();
});

test("legitimate consumed budget and lifecycle progress are not reset or falsely rejected", async () => {
  const o = observer();
  o.f.budget.revision = 3;
  o.f.budget.consumed.modelTokens = 300;
  o.f.budget.consumed.cost = 0.001;
  o.f.provenance.budgetReservations.push({
    id: "model-usage",
    kind: "model_tokens",
    amount: 300,
    state: "consumed",
    createdAt: o.f.at,
    updatedAt: o.f.at,
  });
  o.f.mission.revision = 2;
  o.f.mission.state = "scoping";
  o.f.mission.updatedAt = "2026-11-13T12:01:00.000Z";
  const before = structuredClone(o.f.provenance);
  expect(await o.observe()).toEqual(o.f.mission);
  expect(o.f.provenance).toEqual(before);
});

const changes: Record<string, (f: ReturnType<typeof createReconciliationFixture>) => void> = {
  "missing objective evidence": (f) => {
    f.provenance.evidence = [];
  },
  "cross-mission evidence collision": (f) => {
    f.evidence.missionId = "mission-eliseo";
  },
  "digest tamper": (f) => {
    f.evidence.contentDigest = "c".repeat(64);
  },
  "URI tamper": (f) => {
    f.evidence.uri = "cas://sha256/" + "c".repeat(64);
  },
  "metadata tamper": (f) => {
    f.evidence.sizeBytes = 8;
  },
  "mutable evidence": (f) => {
    f.evidence.immutable = false;
  },
  "changed limits": (f) => {
    f.budget.limits.modelTokens = 13000;
  },
  "wrong budget id": (f) => {
    f.budget.id = "other-budget";
  },
  "wrong budget mission": (f) => {
    f.budget.missionId = "mission-eliseo";
  },
  "missing budget": (f) => {
    f.provenance.budget = undefined as never;
  },
  "wrong requester": (f) => {
    f.mission.requestedBy.id = "eliseo";
  },
  "service requester": (f) => {
    f.mission.requestedBy.kind = "service";
  },
  "changed assumptions": (f) => {
    f.mission.assumptions.push({
      id: "new-assumption",
      statement: "Changed immutable baseline",
      status: "proposed",
      riskClass: 1,
      evidenceRefs: [],
    });
  },
  "changed creation timestamp": (f) => {
    f.mission.createdAt = "2026-11-13T13:00:00.000Z";
  },
};
for (const [name, change] of Object.entries(changes))
  test(`partial creation stays fenced: ${name}`, async () => {
    const o = observer();
    change(o.f);
    expect(await o.observe()).toBeNull();
  });

test("duplicate or incomplete requested objective baseline cannot prove creation", async () => {
  const o = observer();
  o.f.request.objectiveEvidence.push(structuredClone(o.f.request.objectiveEvidence[0]!));
  expect(await o.observe()).toBeNull();
  o.f.request.objectiveEvidence = [{ ...o.f.request.objectiveEvidence[0]!, id: "other-evidence" }];
  o.f.provenance.evidence = [structuredClone(o.f.request.objectiveEvidence[0]!)];
  expect(await o.observe()).toBeNull();
});

test("original budget baseline cannot disappear behind mutable accounting", async () => {
  const o = observer();
  o.f.request.budget.consumed.modelTokens = 10;
  expect(await o.observe()).toBeNull();
  o.f.budget.consumed.modelTokens = 11;
  expect(await o.observe()).toEqual(o.f.mission);
  const reservation = {
    id: "initial-reservation",
    kind: "model_tokens" as const,
    amount: 20,
    state: "reserved" as const,
    createdAt: o.f.at,
    updatedAt: o.f.at,
  };
  o.f.request.budget.reservations = [reservation];
  expect(await o.observe()).toBeNull();
  o.f.provenance.budgetReservations = [structuredClone(reservation)];
  expect(await o.observe()).toEqual(o.f.mission);
  o.f.provenance.budgetReservations[0]!.state = "consumed";
  expect(await o.observe()).toBeNull();
});

test("scope, malformed inputs and nonzero creation revision fail before read", async () => {
  const o = observer();
  o.f.record = { ...o.f.record, projectId: "different" };
  expect(await o.observe()).toBeNull();
  expect(o.readCount()).toBe(0);
  o.f.record = { ...o.f.record, projectId: o.f.request.projectId, expectedRevision: 1 };
  expect(await o.observe()).toBeNull();
  expect(o.readCount()).toBe(0);
  o.f.record = { ...o.f.record, expectedRevision: 0, request: {} };
  expect(await o.observe()).toBeNull();
  expect(o.readCount()).toBe(0);
});

test("current authority revocation never returns an old creation proof", async () => {
  const f = createReconciliationFixture();
  const app = {
    read: async () => {
      throw new Error("CURRENT_AUTHORITY_REVOKED");
    },
  } as unknown as MissionApplication;
  await expect(
    observeApplicationOperation(f.record, app, () => {
      throw new Error("unused");
    }),
  ).rejects.toThrow("CURRENT_AUTHORITY_REVOKED");
});
