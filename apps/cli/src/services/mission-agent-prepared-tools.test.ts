import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { openMissionApplication } from "./mission-composition";
import { createMissionAgentEffects } from "./mission-agent";

const principal = {
  actorId: "owner",
  projectId: "project",
  missionId: "mission",
  policyDigest: "a".repeat(64),
};
const address = { projectId: principal.projectId, missionId: principal.missionId };
function fixture(command: unknown = { ...address, planId: "plan", action: "finish-preparation" }) {
  let bytes = Buffer.from(JSON.stringify(command)),
    revision = 1,
    applied = 0,
    casReads = 0;
  const contentDigest = createHash("sha256").update(bytes).digest("hex");
  const refs = [
    {
      id: "prepared",
      missionId: principal.missionId,
      kind: "artifact",
      immutable: true,
      contentDigest,
      uri: `cas://sha256/${contentDigest}`,
      mediaType: "application/json",
      sizeBytes: bytes.length,
    },
  ];
  const session = {
    context: {
      databaseUrl: "SECRET_DATABASE_URL",
      artifactRoot: "/SECRET_ARTIFACT_ROOT",
      compilerPolicy: {
        id: "policy",
        policyDigest: principal.policyDigest,
        minimumApprovalRole: "scientific_reviewer",
      },
      environment: {
        id: "environment",
        environmentDigest: "b".repeat(64),
        selectedEngine: { id: "amber" },
        capabilities: [],
      },
    },
    application: {
      status: async () => ({ revision }),
      read: async () => ({ evidence: refs }),
      review: async () => ({ candidateDigest: "c".repeat(64) }),
      requestCancel: async () => ({ state: "cancel_requested" }),
    },
    artifacts: {
      get: async () => {
        casReads++;
        return { bytes };
      },
    },
    applyAmberMaterial: async () => {
      applied++;
      return { state: "prepared" };
    },
    close: async () => {},
  } as unknown as Awaited<ReturnType<typeof openMissionApplication>>;
  const effects = createMissionAgentEffects(
    { current: async () => principal, assertCurrent: async () => {} },
    async () => principal,
    async () => session,
  );
  const call = {
    id: "call",
    name: "mission-material",
    input: { ...address, evidenceId: "prepared", contentDigest, expectedRevision: 1 },
  };
  return {
    effects,
    session,
    call,
    refs,
    applied: () => applied,
    casReads: () => casReads,
    alterBytes: () => {
      bytes = Buffer.from('{"changed":true}');
    },
    advanceRevision: () => {
      revision++;
    },
  };
}

test("prepared material is gated and executed through the canonical application port", async () => {
  const f = fixture();
  expect(await f.effects.tools.decide(f.call, "session")).toBe("ask");
  expect((await f.effects.tools.execute(f.call, "session")).ok).toBe(true);
  expect(f.applied()).toBe(1);
});

test("human scientific approval cannot be exposed through a prepared command, even skipping decide", async () => {
  const f = fixture({
    ...address,
    planId: "plan",
    action: "approve",
    approvalRequestId: "approval",
    subjectVersion: 1,
    subjectRevision: 1,
    payloadDigest: "a".repeat(64),
    policyDigest: "b".repeat(64),
    decision: "approved",
    reason: "forbidden model approval",
  });
  expect(await f.effects.tools.decide(f.call, "session")).toBe("deny");
  await expect(f.effects.tools.execute(f.call, "session")).rejects.toThrow(
    "human scientific approval",
  );
  expect(f.applied()).toBe(0);
  expect(f.effects.tools.describe().some((tool) => tool.name === "mission-approve")).toBe(false);
});

test("scope and prepared input drift after approval fail before application mutation", async () => {
  for (const scenario of ["bytes", "metadata", "revision", "scope"]) {
    const f = fixture();
    expect(await f.effects.tools.decide(f.call, "session")).toBe("ask");
    if (scenario === "bytes") f.alterBytes();
    if (scenario === "metadata") f.refs[0]!.contentDigest = "f".repeat(64);
    if (scenario === "revision") f.advanceRevision();
    const call =
      scenario === "scope" ? { ...f.call, input: { ...f.call.input, missionId: "other" } } : f.call;
    await expect(f.effects.tools.execute(call, "session")).rejects.toThrow();
    expect(f.applied()).toBe(0);
  }
});

test("knowing a CAS hash does not grant access to unregistered or foreign-mission evidence", async () => {
  const f = fixture();
  f.refs[0]!.missionId = "other";
  expect(await f.effects.tools.decide(f.call, "session")).toBe("deny");
  expect(f.casReads()).toBe(0);
  expect(f.applied()).toBe(0);
});

test("capability inspection exposes only scientific metadata, with no protected connection or paths", async () => {
  const f = fixture();
  const call = { id: "capabilities", name: "mission-capabilities", input: address };
  expect(await f.effects.tools.decide(call, "session")).toBe("allow");
  const observed = await f.effects.tools.execute(call, "session");
  expect(JSON.stringify(observed)).not.toContain("SECRET");
  expect(observed.result).toMatchObject({ policy: { id: "policy" } });
});
