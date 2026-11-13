import { signedMapping } from "../../../../../../packages/amber-adapter/src/canonical-stage.fixture";
import { expect, test } from "bun:test";
import { handleMaterialRoute } from "./material-routes";

const origin = "https://example.test";
function fixture() {
  const calls: unknown[] = [],
    reservations: unknown[] = [];
  let allowed = true,
    csrf = true;
  const options = {
    origin,
    session: {
      context: { authenticatedActor: { id: "human-owner" }, httpProjectIds: ["project-one"] },
      assertCurrent: async () => {
        if (!allowed) throw new Error("revoked");
      },
      verifyCsrf: async () => csrf,
    },
    open: async () => ({
      application: {
        status: async (address: unknown) => {
          calls.push(address);
          return { revision: 1 };
        },
      },
      applyAmberMaterial: async (value: unknown) => {
        calls.push(value);
        return { pending: true };
      },
      publishMdStage: async (value: unknown) => {
        calls.push(value);
        return { published: true };
      },
    }),
    idempotency: {
      run: async (value: unknown, execute: () => Promise<unknown>) => {
        reservations.push(value);
        return { operationId: "one", result: await execute(), replayed: false };
      },
    },
  };
  const request = (
    body: unknown = {
      expectedRevision: 1,
      request: {
        projectId: "project-one",
        missionId: "mission-one",
        planId: "plan-one",
        action: "finish-preparation",
      },
    },
    path = "/api/v1/projects/project-one/missions/mission-one/materials",
    method = "POST",
  ) =>
    new Request(origin + path, {
      method,
      headers: {
        origin,
        "content-type": "application/json",
        "idempotency-key": "material-one",
        "x-csrf-token": "csrf",
      },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    });
  return {
    options: options as unknown as Parameters<typeof handleMaterialRoute>[1],
    request,
    calls,
    reservations,
    revoke: () => {
      allowed = false;
    },
    denyCsrf: () => {
      csrf = false;
    },
  };
}

test("material command preserves exact authenticated actor, scope, revision and operation identity", async () => {
  const f = fixture();
  const response = await handleMaterialRoute(f.request(), f.options);
  expect(response?.status).toBe(200);
  expect(f.reservations[0]).toMatchObject({
    actorId: "human-owner",
    projectId: "project-one",
    operation: "material.apply",
    expectedRevision: 1,
  });
  expect(f.calls).toContainEqual({
    projectId: "project-one",
    missionId: "mission-one",
    planId: "plan-one",
    action: "finish-preparation",
  });
});

test("denies wrong project, CSRF and revoked sessions before mutation reservation", async () => {
  for (const scenario of ["scope", "csrf", "revoked"]) {
    const f = fixture();
    if (scenario === "csrf") f.denyCsrf();
    if (scenario === "revoked") f.revoke();
    const req = f.request(
      undefined,
      scenario === "scope" ? "/api/v1/projects/other/missions/mission-one/materials" : undefined,
    );
    await expect(handleMaterialRoute(req, f.options)).rejects.toThrow();
    expect(f.reservations).toHaveLength(0);
  }
});

test("rejects body scope overrides, actor injection, invalid mappings and non-POST routes", async () => {
  const mutations = [
    {
      expectedRevision: 1,
      request: {
        projectId: "other",
        missionId: "mission-one",
        planId: "plan-one",
        action: "finish-preparation",
      },
    },
    {
      expectedRevision: 1,
      request: {
        projectId: "project-one",
        missionId: "mission-one",
        planId: "plan-one",
        action: "finish-preparation",
        actor: "admin",
      },
    },
    {
      expectedRevision: 0,
      request: {
        projectId: "project-one",
        missionId: "mission-one",
        planId: "plan-one",
        action: "finish-preparation",
      },
    },
  ];
  for (const body of mutations) {
    const f = fixture();
    await expect(handleMaterialRoute(f.request(body), f.options)).rejects.toThrow();
    expect(f.reservations).toHaveLength(0);
  }
  const f = fixture();
  await expect(
    handleMaterialRoute(
      f.request({}, "/api/v1/projects/project-one/missions/mission-one/md-stage-publications"),
      f.options,
    ),
  ).rejects.toThrow();
  await expect(handleMaterialRoute(f.request({}, undefined, "GET"), f.options)).rejects.toThrow();
  expect(f.reservations).toHaveLength(0);
});

test("revocation during an idempotent replay prevents returning cached result", async () => {
  const f = fixture();
  f.options.idempotency = {
    run: async () => {
      f.revoke();
      return { operationId: "prior", result: { pending: true }, replayed: true };
    },
  };
  await expect(handleMaterialRoute(f.request(), f.options)).rejects.toThrow("revoked");
});

test("defective idempotency adapter cannot invoke a material effect twice", async () => {
  const f = fixture();
  f.options.idempotency = {
    run: async (_request, execute) => {
      await execute();
      await execute();
      return { operationId: "bad", result: {}, replayed: false };
    },
  };
  await expect(handleMaterialRoute(f.request(), f.options)).rejects.toMatchObject({
    code: "EFFECT_UNCERTAIN",
  });
  expect(
    f.calls.filter((call) => (call as { action?: string }).action === "finish-preparation"),
  ).toHaveLength(1);
});

test("MD publication preserves its distinct durable operation and validated mapping", async () => {
  const f = fixture();
  const input = {
    projectId: "project-one",
    missionId: "mission-one",
    workUnitId: "stage-work",
    mapping: signedMapping(),
  };
  const response = await handleMaterialRoute(
    f.request(
      { expectedRevision: 2, request: input },
      "/api/v1/projects/project-one/missions/mission-one/md-stage-publications",
    ),
    f.options,
  );
  expect(response?.status).toBe(200);
  expect(f.reservations[0]).toMatchObject({ operation: "md.publish-stage", expectedRevision: 2 });
  expect(f.calls).toContainEqual(input);
});
