import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { createHash } from "node:crypto";
import { applyApplicationHttpSchema, validateApplicationHttpSchema } from "./http/composition";
import { createApplicationHttpHandler } from "./http/server";
import { PostgresHttpAuth } from "./http/auth";
import { PostgresMissionHttpIdempotency, type PgTransactionPool } from "./http/idempotency";
import { MissionHttpError } from "./http/routes/mission-routes";
import type { MissionLocalContext } from "./mission-local-authority";
import type { openMissionApplication } from "./mission-composition";
import { AgentSessionService } from "./agent-sessions";
import { createMissionAgentEffects } from "./mission-agent";
import { observeApplicationOperation } from "./http/reconciliation";
import { PostgresHttpArtifactGrants } from "./http/artifact-grants";
import { createMissionBoundInference } from "./mission-inference";
import { PostgresDatabase } from "@eigengrid/db";
import {
  ContentAddressedArtifactStore,
  ScientificStore,
  ScientificRevisionConflictError,
  MdProjectionStore,
  computePlanDigest,
  computeProtocolDigest,
  computeSkillGraphDigest,
} from "@eigengrid/mission-runtime";
import {
  SchemaVersion,
  MissionBudgetSchema,
  ScientificMissionSchema,
  ScientificPlanSchema,
  ScientificDecisionSchema,
  digestCanonical,
  canonicalJson,
  ForceFieldStackManifestSchema,
  computeForceFieldStackDigest,
  WorkUnitSchema,
  type EvidenceReference,
} from "@eigengrid/scientific-schema";
import {
  ScientificMissionService,
  computeCompilerPolicyDigest,
  type CompilerPolicyProfile,
} from "@eigengrid/scientific-agent";
import {
  canRunPostgres,
  startEphemeralPostgres,
  type EphemeralPostgresCluster,
} from "../../../../tests/ts/helpers/postgres";
import {
  MissionApplication,
  MissionApplicationError,
  MissionCandidateSchema,
  MissionCreateRequestSchema,
  computeMissionCandidateDigest,
  type MissionApplicationContext,
} from "./mission-application";
import {
  AmberMaterialApplication,
  amberMaterialCapability,
  materialOperationIdentity,
} from "./amber-material-publication";

const NOW = "2026-09-25T12:00:00.000Z";
// This recovery workflow provisions, approves, restarts, reconciles and streams
// over real PostgreSQL. Bound the dedicated shared runner's complete case, not
// individual production requests; keep the normal local 20-second deadline.
const sessionRecoveryTimeout = process.env.EIGENGRID_CI_EXTENDED_TIMEOUTS === "1" ? 60_000 : 20_000;
const actor = { id: "mission-human", kind: "human" as const, role: "scientific_reviewer" };
const address = { projectId: "project-human", missionId: "mission-human" };
const fragment = {
  skillId: "methods.fixture",
  version: "1.0.0",
  contentDigest: "a".repeat(64),
  fragmentId: "fixture-method",
  fragmentDigest: "b".repeat(64),
  relativePath: "protocols/fixture.md",
  selector: "method",
};
function trustedContext(): MissionApplicationContext {
  const policy: Omit<CompilerPolicyProfile, "policyDigest"> = {
    id: "human-policy",
    version: "1.0.0",
    minimumKnowledgeMaturity: "draft",
    minimumCapabilityMaturity: "plannable",
    automaticApprovalRiskCeiling: 1,
    materialDecisionApproval: "covered_by_plan",
    minimumApprovalRole: actor.role,
    requiredDecisionCategories: ["method"],
    defaultRetryPolicy: { maximumAttempts: 1, ambiguityRequiresReconciliation: true },
    retryOverrides: {},
    dependencyMap: {},
    capabilityByKind: {
      optimization: "scientific.optimization.request",
      validation: "scientific.result.validate",
      assessment: "scientific.assessment.compose",
      collection: "scientific.artifact.collect",
      parsing: "scientific.output.parse",
    },
  };
  const environment = {
    id: "human-environment",
    selectedEngine: { id: "fixture", version: "1.0.0", adapterVersion: "1.0.0" },
    capabilities: Object.values(policy.capabilityByKind),
    skillCompatibility: [
      {
        skillId: fragment.skillId,
        version: fragment.version,
        contentDigest: fragment.contentDigest,
        compatible: true,
        reasons: [],
        knowledgeMaturity: "draft" as const,
        capabilityMaturity: "plannable" as const,
        engineNeutral: true,
        compatibleEngines: [],
      },
    ],
  };
  return {
    authenticatedActor: actor,
    authorizedRoles: [actor.role],
    compilerPolicy: { ...policy, policyDigest: computeCompilerPolicyDigest(policy) },
    environment: { ...environment, environmentDigest: digestCanonical(environment) },
  };
}

describe.skipIf(!canRunPostgres)("human mission application through real PostgreSQL", () => {
  let cluster: EphemeralPostgresCluster, database: PostgresDatabase, store: ScientificStore;
  let directory: string, artifacts: ContentAddressedArtifactStore, app: MissionApplication;
  let context: MissionApplicationContext, now: string, evidence: EvidenceReference;
  let mission: ReturnType<typeof ScientificMissionSchema.parse>;
  let modelTokens = 0,
    modelCost = 0;
  let candidate: ReturnType<typeof MissionCandidateSchema.parse>;
  const currentApp = () =>
    new MissionApplication({
      store,
      service: new ScientificMissionService({ store, now: () => new Date(now) }),
      artifacts,
      now: () => new Date(now),
      authority: {
        current: async () => structuredClone(context),
        assertCurrent: async (prior) => {
          if (digestCanonical(prior) !== digestCanonical(context))
            throw new Error("Trusted context changed");
        },
      },
    });
  beforeEach(async () => {
    modelTokens = 0;
    modelCost = 0;
    cluster = await startEphemeralPostgres();
    database = new PostgresDatabase(cluster.url);
    await database.init();
    store = new ScientificStore(database);
    directory = mkdtempSync(join(tmpdir(), "human-mission-"));
    artifacts = new ContentAddressedArtifactStore(directory);
    await artifacts.init();
    context = trustedContext();
    now = NOW;
    app = currentApp();
    await database.createUser({ id: actor.id, username: actor.id });
    await database.createProject({ id: address.projectId, name: "Human mission test" });
    await database.addProjectMember(address.projectId, actor.id, "member");
    const object = await artifacts.put(
      new TextEncoder().encode("3\nwater fixture\nO 0 0 0\nH 0 1 0\nH 1 0 0\n"),
    );
    evidence = {
      id: "human-input",
      missionId: address.missionId,
      kind: "structure",
      contentDigest: object.digest,
      uri: object.uri,
      immutable: true,
      createdAt: NOW,
    };
    mission = ScientificMissionSchema.parse({
      schemaVersion: SchemaVersion,
      id: address.missionId,
      revision: 1,
      state: "created",
      objective: {
        schemaVersion: SchemaVersion,
        id: "human-objective",
        statement: "Review a complete scientific candidate without a model provider",
        system: {
          evidenceId: evidence.id,
          format: "xyz",
          contentDigest: object.digest,
          atomCount: 3,
          charge: 0,
          multiplicity: 1,
        },
        targetProperties: ["normal termination"],
        requiredConfidence: "screening",
      },
      constraints: {
        allowedEngines: ["fixture"],
        deniedEngines: [],
        offlineRequired: true,
        materialChangesRequireApproval: true,
        immutableScientificFields: ["objective", "method"],
      },
      assumptions: [],
      acceptanceCriteria: [
        {
          id: "normal",
          kind: "normal_termination",
          description: "The authorized fixture terminates normally",
          required: true,
        },
      ],
      activePlanId: null,
      budgetId: "human-budget",
      policyProfile: context.compilerPolicy.id,
      requestedBy: actor,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const graph = {
      id: "human-graph",
      schemaVersion: "eigengrid.resolved-skill-graph/v1" as const,
      missionId: mission.id,
      requestedSkillIds: [fragment.skillId],
      nodes: [
        {
          skillId: fragment.skillId,
          version: fragment.version,
          contentDigest: fragment.contentDigest,
        },
      ],
      edges: [],
      selectedFragments: [fragment],
      resolverVersion: "1.0.0",
      environmentDigest: context.environment.environmentDigest,
      resolvedAt: NOW,
    };
    const skillResolution = { ...graph, graphDigest: computeSkillGraphDigest(graph) };
    const protocol = {
      id: "human-protocol",
      schemaVersion: "eigengrid.scientific-protocol/v1" as const,
      objectiveId: mission.objective.id,
      system: mission.objective.system,
      charge: 0,
      multiplicity: 1,
      method: "fixture-method",
      basis: "fixture-basis",
      physicalModel: "gas-phase",
      engineAgnosticSteps: [
        {
          id: "optimize",
          kind: "optimization" as const,
          reason: "Bounded fixture optimization",
          parameters: {
            execution: { software: "fixture", recipeId: "fixture", inputEvidenceId: evidence.id },
          },
          sourceFragments: [fragment],
          riskClass: 1 as const,
        },
      ],
      assumptions: [],
      decisions: ["human-decision"],
      acceptanceCriteria: ["normal"],
      skillGraphDigest: skillResolution.graphDigest,
      compilerVersion: "1.0.0",
    };
    const planBase = {
      id: "human-plan",
      missionId: mission.id,
      version: 1,
      revision: 1,
      status: "under_review" as const,
      normalizedObjective: mission.objective.statement,
      missingInputs: [],
      assumptions: [],
      skillResolution,
      protocol: { ...protocol, protocolDigest: computeProtocolDigest(protocol) },
      alternatives: [],
      risks: [],
      estimatedCost: { wallTimeSeconds: 60, cpuCoreHours: 1, cost: 0 },
      requiredApprovals: [actor.role],
      validationGates: ["normal"],
      limitations: ["Synthetic authority test, no scientific qualification"],
      createdBy: actor,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const plan = ScientificPlanSchema.parse({
      ...planBase,
      planDigest: computePlanDigest(planBase),
    });
    const decision = ScientificDecisionSchema.parse({
      id: "human-decision",
      missionId: mission.id,
      planId: plan.id,
      category: "method",
      question: "Which method is authorized?",
      selectedOption: "fixture-method",
      alternatives: [{ option: "other", reasonNotSelected: "Outside fixture" }],
      rationale: "Explicit fixture selection",
      skillRefs: [fragment],
      evidenceRefs: [evidence.id],
      confidence: { level: "high", basis: "Synthetic contract" },
      riskClass: 3,
      requiresApproval: true,
      actor,
      createdAt: NOW,
    });
    const material = {
      schemaVersion: "eigengrid.mission-candidate/v1" as const,
      plan,
      decisions: [decision],
      evidence: [evidence],
    };
    candidate = MissionCandidateSchema.parse({
      ...material,
      candidateDigest: computeMissionCandidateDigest(material),
    });
  });
  afterEach(async () => {
    await database?.close();
    await cluster?.cleanup();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  async function create() {
    const { requestedBy: _actor, policyProfile: _policy, ...dto } = mission;
    return app.create({
      projectId: address.projectId,
      mission: dto,
      budget: MissionBudgetSchema.parse({
        id: mission.budgetId,
        missionId: mission.id,
        revision: 1,
        limits: { externalOperations: 3, modelTokens, wallTimeSeconds: 600, cost: modelCost },
        consumed: { externalOperations: 0, modelTokens: 0, wallTimeSeconds: 0, cost: 0 },
        reservations: [],
      }),
      objectiveEvidence: [evidence],
    });
  }
  async function imported(expiresAt?: string) {
    await create();
    return app.importCandidate({
      ...address,
      candidate,
      expectedCandidateDigest: candidate.candidateDigest,
      approvalExpiresAt: expiresAt,
    });
  }
  async function approve() {
    const review = await app.review({ ...address, planId: candidate.plan.id });
    const approval = review.approvals[0]!;
    return app.approve({
      ...address,
      planId: candidate.plan.id,
      candidateDigest: review.candidateDigest,
      approvalRequestId: approval.id,
      subjectVersion: approval.subjectVersion,
      subjectRevision: approval.subjectRevision,
      payloadDigest: approval.payloadDigest,
      policyDigest: approval.policyDigest,
      decision: "approved",
      reason: "Explicit exact candidate review",
    });
  }
  const exact = () => ({
    ...address,
    planId: candidate.plan.id,
    candidateDigest: candidate.candidateDigest,
  });

  async function httpFixture(providerFailure?: string) {
    const pool = new Pool({ connectionString: cluster.url, max: 8 });
    await applyApplicationHttpSchema(pool);
    await validateApplicationHttpSchema(pool);
    let revoked = false,
      inferenceCount = 0,
      startCount = 0,
      loseAck = false;
    const credential = "A".repeat(43);
    const local: MissionLocalContext = {
      ...context,
      unixUid: 1001,
      configDigest: "f".repeat(64),
      databaseUrl: cluster.url,
      artifactRoot: directory,
      http: { origin: "https://eigengrid.test", port: 8080, sessionSeconds: 3600 },
      httpProjectIds: [address.projectId],
    };
    const current = async () => {
      if (revoked) throw new Error("authority revoked");
    };
    const authority = {
      authenticateHttp: async (value: string) => {
        await current();
        if (value !== credential) throw Error("bad credential");
        return local;
      },
      httpActor: async (actorId: string, digest: string) => {
        await current();
        if (actorId !== actor.id || digest !== local.configDigest) throw Error("foreign identity");
        return local;
      },
      assertCurrent: current,
    };
    const auth = new PostgresHttpAuth(
      {
        query: async (text, args) => {
          const r = await pool.query(text, args);
          return { rows: r.rows, rowCount: r.rowCount };
        },
      },
      authority,
    );
    const transactions: PgTransactionPool = {
      async connect() {
        const c = await pool.connect();
        return {
          async query<T extends object>(text: string, args?: readonly unknown[]) {
            const r = await c.query(text, args ? [...args] : undefined);
            return { rows: r.rows as T[], rowCount: r.rowCount };
          },
          release: () => c.release(),
        };
      },
    };
    const idempotency = new PostgresMissionHttpIdempotency(transactions, async (input) => {
      if (input.operation.startsWith("agent.") || input.operation === "create") return;
      const request = input.request as { missionId: string };
      if (
        (await app.status({ projectId: input.projectId, missionId: request.missionId }))
          .revision !== input.expectedRevision
      )
        throw new MissionHttpError("REVISION_CONFLICT");
    });
    const open = async () => {
      const scoped = currentApp();
      const original = scoped.start.bind(scoped);
      scoped.start = async (value) => {
        startCount++;
        const result = await original(value);
        if (loseAck) {
          loseAck = false;
          throw Error("ACK lost after canonical commit");
        }
        return result;
      };
      return {
        application: scoped,
        database,
        artifacts,
        context: local,
        close: async () => {},
      } as Awaited<ReturnType<typeof openMissionApplication>>;
    };
    const options = {
      grants: new PostgresHttpArtifactGrants({
        query: async (text, args) => {
          const result = await pool.query(text, args);
          return { rows: result.rows, rowCount: result.rowCount };
        },
      }),
      origin: local.http!.origin,
      auth,
      idempotency,
      open,
      agent: (_context: MissionLocalContext, live: () => Promise<void>) => {
        let service!: AgentSessionService;
        const identity = {
          current: async (value: typeof address) => {
            await live();
            await app.status(value);
            return { actorId: actor.id, ...value, policyDigest: local.configDigest };
          },
          assertCurrent: live,
        };
        const effects = createMissionAgentEffects(identity, (id) => service.principal(id), open);
        service = new AgentSessionService(
          join(directory, "agent-sessions"),
          identity,
          createMissionBoundInference(
            (id) => service.principal(id),
            open,
            async () => ({
              provider: "synthetic-network-fixture",
              model: "fixture-model-v1",
              maximumOutputTokens: 32,
              timeoutMilliseconds: 1000,
              inference: {
                infer: async () => {
                  inferenceCount++;
                  if (providerFailure) throw new Error(providerFailure);
                  return {
                    provider: "synthetic-network-fixture",
                    usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 },
                    text:
                      inferenceCount === 1
                        ? "I will inspect the canonical result"
                        : "Canonical mission admission observed",
                    calls:
                      inferenceCount === 1
                        ? [{ id: "start-once", name: "mission-start", input: exact() }]
                        : [],
                  };
                },
              },
            }),
          ),
          effects,
        );
        return service;
      },
    };
    const wired = {
      ...options,
      reconcile: (
        input: { actorId: string; projectId: string; missionId: string; operationId: string },
        _context: MissionLocalContext,
        live: () => Promise<void>,
      ) =>
        idempotency.reconcile(input, async (record) => {
          await live();
          const result = await observeApplicationOperation(record, app, () =>
            options.agent(local, live),
          );
          await live();
          return result;
        }),
    };
    const direct = createApplicationHttpHandler(wired);
    const start = () =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) =>
          direct(
            new Request(
              local.http!.origin + new URL(request.url).pathname + new URL(request.url).search,
              request,
            ),
            "test-network",
          ),
      });
    let server = start();
    let cookie = "",
      csrf = "";
    const request = async (
      path: string,
      method = "GET",
      value?: unknown,
      key = "request-one",
      extra: Record<string, string> = {},
    ) =>
      fetch(`http://127.0.0.1:${server.port}${path}`, {
        method,
        headers: {
          origin: local.http!.origin,
          cookie,
          "x-csrf-token": csrf,
          "idempotency-key": key,
          ...(value === undefined ? {} : { "content-type": "application/json" }),
          ...extra,
        },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      });
    return {
      request,
      direct,
      auth,
      pool,
      local,
      options: wired,
      login: async () => {
        const r = await request("/api/v1/auth/login", "POST", { credential });
        expect(r.status).toBe(200);
        cookie = r.headers.get("set-cookie")!.split(";")[0]!;
        csrf = ((await r.json()) as { csrfToken: string }).csrfToken;
      },
      headers: () => ({ origin: local.http!.origin, cookie, "x-csrf-token": csrf }),
      restart: async () => {
        await server.stop(true);
        server = start();
      },
      revoke: () => {
        revoked = true;
      },
      loseAck: () => {
        loseAck = true;
      },
      starts: () => startCount,
      inferences: () => inferenceCount,
      close: async () => {
        await server.stop(true);
        await pool.end();
      },
    };
  }

  test("application live HTTP: manual no-model workflow, durable replay after listener restart, CSRF, IDOR and logout", async () => {
    const http = await httpFixture();
    const base = `/api/v1/projects/${address.projectId}/missions`;
    try {
      expect((await http.request(`${base}/${mission.id}/status`)).status).toBe(401);
      await http.login();
      const { requestedBy: _actor, policyProfile: _policy, ...dto } = mission;
      const createRequest = {
        projectId: address.projectId,
        mission: dto,
        budget: MissionBudgetSchema.parse({
          id: mission.budgetId,
          missionId: mission.id,
          revision: 1,
          limits: { externalOperations: 3, modelTokens: 0, wallTimeSeconds: 600, cost: 0 },
          consumed: { externalOperations: 0, modelTokens: 0, wallTimeSeconds: 0, cost: 0 },
          reservations: [],
        }),
        objectiveEvidence: [evidence],
      };
      const forbidden = await http.request(
        base,
        "POST",
        { expectedRevision: 0, request: createRequest },
        "create",
      );
      expect(forbidden.status).toBe(404);
      expect(await store.getMission(mission.id)).toBeNull();
      const uploaded = await http.direct(
        new Request(
          http.local.http!.origin +
            `/api/v1/projects/${address.projectId}/artifacts/${evidence.contentDigest}`,
          {
            method: "PUT",
            headers: { ...http.headers(), "content-type": "application/octet-stream" },
            body: new Uint8Array((await artifacts.get(evidence.contentDigest)).bytes),
          },
        ),
      );
      expect(uploaded.status).toBe(201);
      const created = await http.request(
        base,
        "POST",
        { expectedRevision: 0, request: createRequest },
        "create",
      );
      expect(created.status).toBe(201);
      const mutate = async (action: string, request: unknown, key = action) => {
        const state = await app.status(address);
        return http.request(
          `${base}/${mission.id}/${action}`,
          "POST",
          { expectedRevision: state.revision, request },
          key,
        );
      };
      expect(
        (
          await mutate("import", {
            ...address,
            candidate,
            expectedCandidateDigest: candidate.candidateDigest,
          })
        ).status,
      ).toBe(200);
      const reviewed = await http.request(
        `${base}/${mission.id}/plans/${candidate.plan.id}/review`,
      );
      expect(reviewed.status).toBe(200);
      const review = ((await reviewed.json()) as { result: Awaited<ReturnType<typeof app.review>> })
        .result;
      const approval = review.approvals[0]!;
      expect(
        (
          await mutate("approve", {
            ...exact(),
            approvalRequestId: approval.id,
            subjectVersion: approval.subjectVersion,
            subjectRevision: approval.subjectRevision,
            payloadDigest: approval.payloadDigest,
            policyDigest: approval.policyDigest,
            decision: "approved",
            reason: "Manual HTTP review without a model",
          })
        ).status,
      ).toBe(200);
      expect((await mutate("compile", exact())).status).toBe(200);
      const body = { expectedRevision: (await app.status(address)).revision, request: exact() };
      const first = await http.request(
        `${base}/${mission.id}/start`,
        "POST",
        body,
        "start-idempotent",
      );
      const firstJson = await first.json();
      expect({ status: first.status, body: firstJson }).toMatchObject({ status: 200 });
      await http.restart();
      const replay = await http.request(
        `${base}/${mission.id}/start`,
        "POST",
        body,
        "start-idempotent",
      );
      expect(replay.headers.get("idempotency-replayed")).toBe("true");
      expect(await replay.json()).toEqual(firstJson);
      expect(http.starts()).toBe(1);
      expect(
        (
          await http.request(`${base}/${mission.id}/start`, "POST", body, "csrf-reject", {
            "x-csrf-token": "wrong",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await http.request(`${base}/${mission.id}/start`, "POST", body, "origin-reject", {
            origin: "https://attacker.test",
          })
        ).status,
      ).toBe(403);
      expect(
        (await http.request(`/api/v1/projects/foreign/missions/${mission.id}/status`)).status,
      ).toBe(403);
      expect((await http.request(`${base}/missing/status`)).status).toBe(404);
      expect(
        (await store.getMissionProvenance(mission.id)).transitions.filter(
          (x) => x.toState === "executing",
        ),
      ).toHaveLength(1);
      const logout = await http.request("/api/v1/auth/logout", "POST");
      expect(logout.status).toBe(200);
      expect((await http.request(`${base}/${mission.id}/status`)).status).toBe(401);
    } finally {
      await http.close();
    }
  }, 20000);

  test(
    "application live HTTP: exact-call approval, restart, lost ACK and canonical reconciliation never start twice",
    async () => {
      modelTokens = 2000;
      modelCost = 1;
      await imported();
      await approve();
      await app.compile(exact());
      const http = await httpFixture();
      const base = `/api/v1/projects/${address.projectId}/missions/${mission.id}/agent-sessions`;
      try {
        await http.login();
        const opened = await http.request(
          base,
          "POST",
          { expectedRevision: 0, request: { prompt: "Start the reviewed mission" } },
          "open-session",
        );
        expect(opened.status).toBe(201);
        const original = (
          (await opened.json()) as { result: import("@eigengrid/agent-runtime").AgentSession }
        ).result;
        const sid = original.sessionId;
        const mutate = async (action: string, request: unknown = {}, key = action) => {
          const observed = await http.request(`${base}/${sid}`);
          const state = (
            (await observed.json()) as { result: import("@eigengrid/agent-runtime").AgentSession }
          ).result;
          return http.request(
            `${base}/${sid}/${action}`,
            "POST",
            { expectedRevision: state.cursor.sequence, request },
            key,
          );
        };
        const pending = await mutate("resume");
        expect(pending.status).toBe(200);
        const state = (
          (await pending.json()) as { result: import("@eigengrid/agent-runtime").AgentSession }
        ).result;
        expect(state.phase).toBe("awaiting_approval");
        await http.restart();
        expect(
          (
            await mutate("approve", {
              callId: state.call!.id,
              inputDigest: digestCanonical(state.call!.input),
              cursor: state.cursor,
              ttlSeconds: 60,
            })
          ).status,
        ).toBe(200);
        http.loseAck();
        const uncertain = await mutate("resume", {}, "resume-approved");
        expect(((await uncertain.json()) as { result: { phase: string } }).result.phase).toBe(
          "uncertain_effect",
        );
        expect(http.starts()).toBe(1);
        expect((await mutate("reconcile")).status).toBe(200);
        const final = await mutate("resume", {}, "resume-reconciled");
        const finalJson = await final.json();
        expect({ status: final.status, body: finalJson }).toMatchObject({
          status: 200,
          body: { result: { phase: "completed", text: "Canonical mission admission observed" } },
        });
        expect(http.starts()).toBe(1);
        const budget = await store.getMissionBudget(mission.id);
        expect(budget.consumed.modelTokens).toBe(4);
        expect(budget.consumed.cost).toBe(0.002);
        const modelIntents = (await store.getMissionProvenance(mission.id)).modelInvocationIntents;
        expect(modelIntents).toHaveLength(2);
        expect(
          modelIntents.every(
            (intent) =>
              intent.provider === "synthetic-network-fixture" &&
              intent.model === "fixture-model-v1" &&
              intent.status === "observed",
          ),
        ).toBe(true);
        const events = await http.request(`${base}/${sid}/events?after=0&maximum=2`);
        expect((await events.text()).trim().split("\n")).toHaveLength(2);
        expect((await http.request(`${base}/${sid}/events?maximum=257`)).status).toBe(400);
        http.revoke();
        expect((await http.request(`${base}/${sid}`)).status).toBe(401);
      } finally {
        await http.close();
      }
    },
    sessionRecoveryTimeout,
  );

  test("application live HTTP: pending start response reconciles through mission runtime readback and versioned cancellation is only a request", async () => {
    await imported();
    await approve();
    await app.compile(exact());
    const http = await httpFixture();
    const base = `/api/v1/projects/${address.projectId}/missions/${mission.id}`;
    try {
      await http.login();
      http.loseAck();
      const body = { expectedRevision: (await app.status(address)).revision, request: exact() };
      const lost = await http.request(`${base}/start`, "POST", body, "lost-http-start");
      expect(lost.status).toBe(500);
      const row = await http.pool.query(
        "SELECT operation_id FROM eigengrid_a5_http_operations WHERE idempotency_key='lost-http-start'",
      );
      const operationId = String(row.rows[0]!.operation_id);
      const recovered = await http.request(`${base}/operations/${operationId}/reconcile`, "POST");
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({
        operationId,
        result: { recoveredFromCanonical: true, observation: { state: "executing" } },
      });
      expect(http.starts()).toBe(1);
      const replay = await http.request(`${base}/start`, "POST", body, "lost-http-start");
      expect(replay.headers.get("idempotency-replayed")).toBe("true");
      const state = await app.status(address);
      const cancellation = await http.request(
        `${base}/cancel`,
        "POST",
        {
          expectedRevision: state.revision,
          request: {
            ...address,
            schemaVersion: "eigengrid.mission-cancel/v1",
            expectedRevision: state.revision,
            reason: "Operator requested cancellation",
          },
        },
        "cancel-request",
      );
      expect(cancellation.status).toBe(200);
      expect(await cancellation.json()).toMatchObject({ result: { state: "cancel_requested" } });
      expect((await app.status(address)).state).toBe("cancel_requested");
      expect(http.starts()).toBe(1);
    } finally {
      await http.close();
    }
  }, 20000);

  test("application live HTTP: streamed artifacts are bounded, membership and session expiry revoke access, and errors redact secrets", async () => {
    await create();
    const http = await httpFixture();
    const base = `/api/v1/projects/${address.projectId}/missions/${mission.id}`;
    try {
      await http.login();
      const downloaded = await http.request(`${base}/artifacts/${evidence.contentDigest}`);
      expect(downloaded.status).toBe(200);
      expect((await downloaded.text()).startsWith("3\nwater")).toBe(true);
      expect((await http.request(`${base}/artifacts/${"0".repeat(64)}`)).status).toBe(404);
      const upload = await http.direct(
        new Request(http.local.http!.origin + `${base}/artifacts/${evidence.contentDigest}`, {
          method: "PUT",
          headers: {
            ...http.headers(),
            "content-type": "application/octet-stream",
            "content-length": String(65 * 1024 * 1024),
          },
          body: "oversized",
        }),
      );
      expect(upload.status).toBe(413);
      const bytes = new TextEncoder().encode("bounded upload fixture");
      const uploadedDigest = createHash("sha256").update(bytes).digest("hex");
      const put = (digest: string) =>
        http.direct(
          new Request(http.local.http!.origin + `${base}/artifacts/${digest}`, {
            method: "PUT",
            headers: {
              ...http.headers(),
              "content-type": "application/octet-stream",
              "content-length": String(bytes.byteLength),
            },
            body: bytes,
          }),
        );
      expect((await put(uploadedDigest)).status).toBe(201);
      expect((await artifacts.get(uploadedDigest)).bytes).toEqual(bytes);
      expect((await http.request(`${base}/artifacts/${uploadedDigest}`)).status).toBe(404);
      expect((await put("1".repeat(64))).status).toBe(400);
      await expect(artifacts.get("1".repeat(64))).rejects.toThrow();
      const data = new Uint8Array(2 * 1024 * 1024).fill(120);
      const object = await artifacts.put(data);
      await store.createEvidence({
        ...evidence,
        id: "streamed-evidence",
        kind: "artifact",
        contentDigest: object.digest,
        uri: object.uri,
      });
      const streamed = await http.direct(
        new Request(http.local.http!.origin + `${base}/artifacts/${object.digest}`, {
          headers: http.headers(),
        }),
      );
      const reader = streamed.body!.getReader();
      expect((await reader.read()).value!.length).toBeLessThanOrEqual(1024 * 1024);
      await database.removeProjectMember(address.projectId, actor.id);
      await expect(reader.read()).rejects.toThrow();
      expect((await http.request(`${base}/status`)).status).toBe(404);
      await database.addProjectMember(address.projectId, actor.id, "member");
      const incidents: unknown[] = [];
      const failing = createApplicationHttpHandler({
        ...http.options,
        open: async () => {
          throw Error("postgresql://private:secret-password@host/db");
        },
        reportIncident: (value) => {
          incidents.push(value);
        },
      });
      const failed = await failing(
        new Request(http.local.http!.origin + `${base}/status`, { headers: http.headers() }),
      );
      expect(failed.status).toBe(500);
      expect(await failed.text()).not.toContain("secret-password");
      expect(JSON.stringify(incidents)).not.toContain("private");
      await http.pool.query(
        "UPDATE eigengrid_a5_http_sessions SET expires_at=clock_timestamp()-interval '1 second'",
      );
      expect((await http.request(`${base}/status`)).status).toBe(401);
    } finally {
      await http.close();
    }
  }, 20000);

  test("application live HTTP: credentials and CSRF are hashed, duplicate cookies and disabled users fail, schema drift is rejected", async () => {
    await create();
    const http = await httpFixture();
    const path = `/api/v1/projects/${address.projectId}/missions/${mission.id}/status`;
    try {
      expect(
        (await http.request("/api/v1/auth/login", "POST", { credential: "B".repeat(43) })).status,
      ).toBe(401);
      await http.login();
      const rows = await http.pool.query(
        "SELECT token_digest,csrf_digest FROM eigengrid_a5_http_sessions",
      );
      expect(JSON.stringify(rows.rows)).not.toContain(http.headers().cookie.split("=")[1]!);
      expect(JSON.stringify(rows.rows)).not.toContain(http.headers()["x-csrf-token"]);
      expect(
        (
          await http.request(path, "GET", undefined, "duplicate-cookie", {
            cookie: http.headers().cookie + "; " + http.headers().cookie,
          })
        ).status,
      ).toBe(401);
      const version = await http.pool.query(
        "SELECT checksum FROM eigengrid_a5_http_schema WHERE version=1",
      );
      await http.pool.query("UPDATE eigengrid_a5_http_schema SET checksum=$1 WHERE version=1", [
        "0".repeat(64),
      ]);
      await expect(validateApplicationHttpSchema(http.pool)).rejects.toThrow("migration");
      await http.pool.query("UPDATE eigengrid_a5_http_schema SET checksum=$1 WHERE version=1", [
        version.rows[0]!.checksum,
      ]);
      await http.pool.query("UPDATE users SET status='disabled' WHERE id=$1", [actor.id]);
      expect((await http.request(path)).status).toBe(401);
      for (let i = 0; i < 9; i++)
        await http.request("/api/v1/auth/login", "POST", { credential: "B".repeat(43) });
      expect(
        (await http.request("/api/v1/auth/login", "POST", { credential: "B".repeat(43) })).status,
      ).toBe(429);
    } finally {
      await http.close();
    }
  }, 20000);

  test("application parent model budget: two Heads cannot over-reserve and unknown usage stays fenced", async () => {
    modelTokens = 40;
    modelCost = 1;
    await create();
    const request = {
      ...address,
      sessionId: "11111111-1111-4111-8111-111111111111",
      step: 1,
      requestDigest: "a".repeat(64),
      contextDigest: "b".repeat(64),
      provider: "fixture-provider",
      model: "fixture-v1",
      maximumInputTokens: 20,
      maximumOutputTokens: 10,
      maximumCost: 1,
      timeoutMilliseconds: 1000,
    };
    const lease = await app.beginAgentInference(request);
    const other = currentApp();
    await expect(
      other.beginAgentInference({ ...request, sessionId: "22222222-2222-4222-8222-222222222222" }),
    ).rejects.toThrow("PARENT_MODEL_BUDGET_EXHAUSTED");
    await expect(other.observeAgentInference(lease, { ambiguous: true })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await app.observeAgentInference(lease, {
      responseDigest: "c".repeat(64),
      inputTokens: 3,
      outputTokens: 2,
      cost: 0.1,
    });
    expect((await store.getMissionBudget(mission.id)).consumed).toMatchObject({
      modelTokens: 5,
      cost: 0.1,
    });
    const unknown = await other.beginAgentInference({
      ...request,
      sessionId: "22222222-2222-4222-8222-222222222222",
    });
    await other.observeAgentInference(unknown, { ambiguous: true });
    expect(
      (await store.getMissionBudget(mission.id)).reservations.some((r) => r.state === "ambiguous"),
    ).toBe(true);
    await expect(
      currentApp().beginAgentInference({
        ...request,
        sessionId: "33333333-3333-4333-8333-333333333333",
      }),
    ).rejects.toThrow("PARENT_MODEL_BUDGET_EXHAUSTED");
  });

  test("application live HTTP: zero parent model budget prevents provider calls while manual status remains usable", async () => {
    await create();
    const http = await httpFixture();
    const base = `/api/v1/projects/${address.projectId}/missions/${mission.id}/agent-sessions`;
    try {
      await http.login();
      const opened = await http.request(
        base,
        "POST",
        { expectedRevision: 0, request: { prompt: "Inspect" } },
        "zero-open",
      );
      const state = (
        (await opened.json()) as { result: { sessionId: string; cursor: { sequence: number } } }
      ).result;
      const resumed = await http.request(
        `${base}/${state.sessionId}/resume`,
        "POST",
        { expectedRevision: state.cursor.sequence, request: {} },
        "zero-resume",
      );
      expect(await resumed.json()).toMatchObject({
        result: { phase: "budget_exhausted", detail: "PARENT_MODEL_BUDGET_EXHAUSTED" },
      });
      expect(http.inferences()).toBe(0);
      expect((await store.getMissionProvenance(mission.id)).modelInvocationIntents).toHaveLength(0);
      expect((await app.status(address)).missionId).toBe(mission.id);
    } finally {
      await http.close();
    }
  }, 20000);

  test("application live HTTP: provider secrets never enter durable session events and unknown usage remains reserved", async () => {
    modelTokens = 2000;
    modelCost = 1;
    await create();
    const secret = "https://provider.test/private?api_key=private-provider-secret";
    const http = await httpFixture(secret);
    const base = `/api/v1/projects/${address.projectId}/missions/${mission.id}/agent-sessions`;
    try {
      await http.login();
      const opened = await http.request(
        base,
        "POST",
        { expectedRevision: 0, request: { prompt: "Inspect" } },
        "failure-open",
      );
      const state = (
        (await opened.json()) as { result: { sessionId: string; cursor: { sequence: number } } }
      ).result;
      const resumed = await http.request(
        `${base}/${state.sessionId}/resume`,
        "POST",
        { expectedRevision: state.cursor.sequence, request: {} },
        "failure-resume",
      );
      const failed = await resumed.json();
      expect(failed).toMatchObject({
        result: { phase: "failed", detail: "MISSION_MODEL_INFERENCE_UNAVAILABLE" },
      });
      expect(JSON.stringify(failed)).not.toContain("private-provider-secret");
      const events = await http.request(`${base}/${state.sessionId}/events`, "GET");
      expect(await events.text()).not.toContain("private-provider-secret");
      expect(http.inferences()).toBe(1);
      expect((await store.getMissionProvenance(mission.id)).modelInvocationIntents).toMatchObject([
        { status: "ambiguous" },
      ]);
      expect(
        (await store.getMissionBudget(mission.id)).reservations.some(
          (r) => r.state === "ambiguous",
        ),
      ).toBe(true);
    } finally {
      await http.close();
    }
  }, 20000);

  test("one CAS object retains distinct immutable provenance while duplicate authority and ID drift are rejected", async () => {
    await create();
    const adopted = { ...evidence, id: "unit-adopted-source", sourceId: "unit-adoption-context" };
    expect(await store.createEvidence(adopted)).toEqual(adopted);
    expect(await store.createEvidence(adopted)).toEqual(adopted);
    await expect(
      store.createEvidence({ ...adopted, id: "unit-duplicate-source" }),
    ).rejects.toThrow();
    await expect(
      store.createEvidence({ ...adopted, contentDigest: "e".repeat(64) }),
    ).rejects.toThrow();
    expect((await app.read(address)).evidence.map((x) => x.id).sort()).toEqual(
      [evidence.id, adopted.id].sort(),
    );
  });

  test("frozen publication crosses real PostgreSQL approval/effect/projection boundaries exactly once", async () => {
    const object = await artifacts.put(
      new TextEncoder().encode(canonicalJson({ unitOnly: "parameter-byte-source" })),
    );
    const source = {
      ...evidence,
      id: "unit-parameter-source",
      contentDigest: object.digest,
      uri: object.uri,
      sizeBytes: object.sizeBytes,
      mediaType: "application/json",
    };
    const parameter = {
      id: "unit-parameters",
      family: "unit-only",
      version: "1.0.0",
      source: "ephemeral unit material",
      sourceEvidenceRefs: [source.id],
      parameterDigest: object.digest,
      knownLimitations: ["No physical parameter or engine qualification"],
    };
    const stackMaterial = {
      schemaVersion: "eigengrid.force-field-stack/v1",
      id: "unit-published-stack",
      revision: 1,
      protein: parameter,
      lipid: parameter,
      ligands: [],
      water: { model: "TIP3P", parameterSet: parameter },
      ions: parameter,
      cofactors: [],
      engineCompatibility: [{ engine: "unit-only", versionRange: "unit-only" }],
      compatibilityEvidenceRefs: [source.id],
      knownLimitations: ["Ephemeral engineering test"],
      createdAt: NOW,
    };
    const stack = ForceFieldStackManifestSchema.parse({
      ...stackMaterial,
      stackDigest: computeForceFieldStackDigest(stackMaterial),
    });
    expect(
      (await artifacts.put(new TextEncoder().encode(canonicalJson(stackMaterial)))).digest,
    ).toBe(stack.stackDigest);
    const capability = amberMaterialCapability("amber.force-field-stack");
    const parameters = {
      schemaVersion: "eigengrid.biomolecular-material-publication-binding/v1",
      subjectKind: "force_field_stack",
      subject: { id: stack.id, revision: stack.revision, digest: stack.stackDigest },
      sourceEvidenceRefs: [source.id],
      artifactEvidenceRef: "unit-stack-output",
    };
    const workUnit = WorkUnitSchema.parse({
      id: "unit-stack-publication",
      missionId: mission.id,
      planId: candidate.plan.id,
      planVersion: 1,
      kind: "scientific_capability",
      state: "created",
      reason: "Ephemeral typed publication integration",
      dependencies: [],
      inputRefs: [source.id],
      outputContract: {
        requiredEvidenceKinds: ["force_field_stack"],
        requiredObservationKinds: ["artifact_integrity"],
      },
      skillRefs: [fragment],
      protocolFragment: {
        schemaVersion: "eigengrid.scientific-capability-fragment/v1",
        id: "unit-stack-fragment",
        kind: "scientific_capability",
        capability,
        reason: "Unit integration",
        parameters,
        sourceFragments: [fragment],
        riskClass: 3,
      },
      retryPolicy: { maximumAttempts: 1, ambiguityRequiresReconciliation: true },
      approvalPolicy: { required: true, minimumRole: actor.role },
      executionPolicy: { capability: capability.id, riskClass: 3 },
      revision: 1,
      claimOwner: null,
      claimExpiresAt: null,
      jobId: null,
      attemptId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const identity = materialOperationIdentity(workUnit);
    const request = {
      schemaVersion: "eigengrid.force-field-stack-publication-request/v2",
      missionId: mission.id,
      planId: candidate.plan.id,
      planVersion: 1,
      workUnitId: workUnit.id,
      capability,
      intendedJobId: identity.jobId,
      intendedAttemptId: identity.attemptId,
      inputEvidenceId: source.id,
      inputContentDigest: source.contentDigest,
      stack: parameters.subject,
      sourceEvidence: [{ id: source.id, contentDigest: source.contentDigest }],
      outputArtifact: {
        evidenceRef: parameters.artifactEvidenceRef,
        mediaType: "application/vnd.eigengrid.force-field-stack+json",
      },
      parametersDigest: digestCanonical(parameters),
      outputContractDigest: digestCanonical(workUnit.outputContract),
    };
    if (workUnit.protocolFragment.kind !== "scientific_capability")
      throw new Error("Typed unit fragment required");
    const { protocolDigest: _priorProtocolDigest, ...protocolBase } = candidate.plan.protocol;
    const protocol = { ...protocolBase, capabilitySteps: [workUnit.protocolFragment] };
    const plan = {
      ...candidate.plan,
      protocol: { ...protocol, protocolDigest: computeProtocolDigest(protocol) },
    };
    const exactPlan = { ...plan, planDigest: computePlanDigest(plan) };
    const candidateMaterial = { ...candidate, plan: exactPlan, evidence: [evidence, source] };
    candidate = MissionCandidateSchema.parse({
      ...candidateMaterial,
      candidateDigest: computeMissionCandidateDigest(candidateMaterial),
    });
    await imported();
    await approve();
    const mdStore = new MdProjectionStore(database, artifacts);
    const material = new AmberMaterialApplication({
      database,
      store,
      mdStore,
      artifacts,
      authority: { current: async () => context, assertCurrent: async () => {} },
    });
    const base = { ...address, planId: candidate.plan.id };
    const proposed = (await material.apply({
      ...base,
      action: "propose-work-unit",
      workUnit,
      request,
    })) as {
      approval: {
        id: string;
        subjectVersion: number;
        subjectRevision: number;
        payloadDigest: string;
        policyDigest: string;
      };
    };
    await expect(
      material.apply({ ...base, action: "execute", workUnitId: workUnit.id }),
    ).rejects.toThrow();
    expect((await app.read(address)).receipts).toHaveLength(0);
    await material.apply({
      ...base,
      action: "approve",
      approvalRequestId: proposed.approval.id,
      subjectVersion: proposed.approval.subjectVersion,
      subjectRevision: proposed.approval.subjectRevision,
      payloadDigest: proposed.approval.payloadDigest,
      policyDigest: proposed.approval.policyDigest,
      decision: "approved",
      reason: "Exact ephemeral engineering approval, no real pilot evidence",
    });
    await material.apply({ ...base, action: "execute", workUnitId: workUnit.id });
    expect((await store.getWorkUnit(workUnit.id))?.state).toBe("succeeded");
    expect((await mdStore.getForceFieldStack(mission.id, stack.id, 1))?.stackDigest).toBe(
      stack.stackDigest,
    );
    await material.apply({ ...base, action: "execute", workUnitId: workUnit.id });
    expect((await app.read(address)).receipts).toHaveLength(1);
    await expect(material.apply({ ...base, action: "finish-preparation" })).rejects.toThrow();
    await material.apply({ ...base, action: "replan-preparation" });
    expect((await store.getMission(mission.id))?.state).toBe("replanning");
    expect((await app.read(address)).receipts).toHaveLength(1);
  });

  test("provider-free import requests approval, survives CLI recreation, compiles and starts durably twice", async () => {
    const result = await imported();
    expect(result.approval.state).toBe("pending");
    expect((await app.read(address)).workUnits).toHaveLength(0);
    await expect(app.start(exact())).rejects.toThrow();
    app = currentApp();
    expect((await app.review({ ...address, planId: candidate.plan.id })).candidate).toEqual(
      candidate,
    );
    await approve();
    const first = await app.start(exact());
    const second = await app.start(exact());
    expect(first.state).toBe("executing");
    expect(second.revision).toBe(first.revision);
    const state = await app.status(address);
    expect(state.operations).toEqual([]);
    expect(state.workUnits.length).toBeGreaterThan(0);
    expect(state.workUnits.every((work) => work.jobId === null)).toBe(true);
    const replay = await app.importCandidate({
      ...address,
      candidate,
      expectedCandidateDigest: candidate.candidateDigest,
    });
    expect(replay.state).toBe("executing");
    expect(replay.approval.state).toBe("approved");
  });
  test("two humans cannot read, review, approve or start one another's mission", async () => {
    await imported();
    await database.createUser({ id: "other-human", username: "other-human" });
    await database.addProjectMember(address.projectId, "other-human", "member");
    context.authenticatedActor = { ...actor, id: "other-human" };
    await expect(app.read(address)).rejects.toThrow();
    await expect(app.review({ ...address, planId: candidate.plan.id })).rejects.toThrow();
    await expect(app.start(exact())).rejects.toThrow();
    expect((await store.getMissionProvenance(mission.id)).approvals[0]!.state).toBe("pending");
  });
  test("manifest edits, absent inputs and injected DTO authority fail before plan persistence", async () => {
    await create();
    const changed = structuredClone(candidate);
    changed.plan.normalizedObjective = "Changed after review";
    await expect(
      app.importCandidate({
        ...address,
        candidate: changed,
        expectedCandidateDigest: candidate.candidateDigest,
      }),
    ).rejects.toThrow("digest");
    const missing = structuredClone(candidate);
    missing.evidence[0]!.contentDigest = "f".repeat(64);
    missing.evidence[0]!.uri = `cas://sha256/${"f".repeat(64)}`;
    missing.candidateDigest = computeMissionCandidateDigest(missing);
    await expect(
      app.importCandidate({
        ...address,
        candidate: missing,
        expectedCandidateDigest: missing.candidateDigest,
      }),
    ).rejects.toThrow();
    await expect(
      app.importCandidate({
        ...address,
        candidate,
        expectedCandidateDigest: candidate.candidateDigest,
        authenticatedActor: actor,
      } as never),
    ).rejects.toThrow();
    expect((await store.getMissionProvenance(mission.id)).plans).toHaveLength(0);
    expect(
      MissionCreateRequestSchema.safeParse({ projectId: address.projectId, mission }).success,
    ).toBe(false);
  });
  test("approval binds explicit reviewed digests and cannot revive an expired approval", async () => {
    await imported("2026-09-25T12:01:00.000Z");
    const review = await app.review({ ...address, planId: candidate.plan.id });
    const request = review.approvals[0]!;
    const dto = {
      ...exact(),
      approvalRequestId: request.id,
      subjectVersion: request.subjectVersion,
      subjectRevision: request.subjectRevision,
      payloadDigest: request.payloadDigest,
      policyDigest: request.policyDigest,
      decision: "approved" as const,
      reason: "Exact review",
    };
    await expect(app.approve({ ...dto, payloadDigest: "e".repeat(64) })).rejects.toThrow(
      "reviewed",
    );
    await approve();
    now = "2026-09-25T12:02:00.000Z";
    await expect(app.start(exact())).rejects.toThrow();
    expect((await store.getMission(mission.id))!.state).toBe("awaiting_approval");
    expect((await store.getMissionProvenance(mission.id)).operations).toHaveLength(0);
  });
  test("revoked membership and changed current policy block approval and durable start", async () => {
    await imported();
    await approve();
    context.compilerPolicy.policyDigest = "d".repeat(64);
    await expect(app.start(exact())).rejects.toThrow();
    context = trustedContext();
    await database.removeProjectMember(address.projectId, actor.id);
    await expect(app.read(address)).rejects.toThrow();
    await expect(app.start(exact())).rejects.toThrow();
  });

  test("approval selects only a reviewer role held by the authenticated human", async () => {
    await imported();
    context.authenticatedActor = { ...actor, role: "scientist" };
    context.authorizedRoles = ["scientist"];
    await expect(approve()).rejects.toThrow("approval role");
    context.authorizedRoles = ["scientist", actor.role];
    const approved = await approve();
    expect(approved.response?.actor.id).toBe(actor.id);
    expect(approved.response?.role).toBe(actor.role);
  });

  test("invalid candidate state cannot pin manifest evidence and prevent a corrected import", async () => {
    await create();
    const invalid = structuredClone(candidate);
    invalid.plan.status = "approved";
    invalid.candidateDigest = computeMissionCandidateDigest(invalid);
    await expect(
      app.importCandidate({
        ...address,
        candidate: invalid,
        expectedCandidateDigest: invalid.candidateDigest,
      }),
    ).rejects.toThrow("under-review");
    expect((await store.getMissionProvenance(mission.id)).evidence).toHaveLength(1);
    expect(
      (
        await app.importCandidate({
          ...address,
          candidate,
          expectedCandidateDigest: candidate.candidateDigest,
        })
      ).approval.state,
    ).toBe("pending");
  });

  test("deleted input bytes after review prevent start without creating an operation", async () => {
    await imported();
    await approve();
    rmSync(join(directory, "sha256", evidence.contentDigest.slice(0, 2), evidence.contentDigest));
    await expect(app.start(exact())).rejects.toThrow();
    expect((await store.getMissionProvenance(mission.id)).operations).toHaveLength(0);
  });

  test("concurrent durable starts preserve a single mission transition", async () => {
    await imported();
    await approve();
    await app.compile(exact());
    const transition = store.transitionMission.bind(store);
    try {
      // A revision error alone is no proof that another start succeeded.
      store.transitionMission = async (input) => {
        if (input.to === "executing")
          throw new ScientificRevisionConflictError(
            "mission",
            input.missionId,
            input.expectedRevision,
            input.expectedRevision + 1,
          );
        return transition(input);
      };
      await expect(app.start(exact())).rejects.toBeInstanceOf(ScientificRevisionConflictError);
      expect((await store.getMission(mission.id))?.state).toBe("ready");
      let attempts = 0;
      let release!: () => void;
      const bothArrived = new Promise<void>((resolve) => {
        release = resolve;
      });
      store.transitionMission = async (input) => {
        if (input.to === "executing") {
          if (++attempts === 2) release();
          // Both independent callers have already read the same ready revision.
          await bothArrived;
        }
        return transition(input);
      };
      const states = await Promise.all([app.start(exact()), currentApp().start(exact())]);
      expect(attempts).toBe(2);
      expect(states.every((state) => state.state === "executing")).toBe(true);
      const provenance = await store.getMissionProvenance(mission.id);
      expect(provenance.transitions.filter((item) => item.toState === "executing")).toHaveLength(1);
      expect(provenance.operations).toHaveLength(0);
    } finally {
      store.transitionMission = transition;
    }
  });

  test("terminal mission import fails before candidate evidence is pinned", async () => {
    await create();
    await store.transitionMission({
      missionId: mission.id,
      expectedRevision: 1,
      to: "failed",
      reason: "Terminal test fixture",
      actor,
      at: NOW,
    });
    await expect(
      app.importCandidate({
        ...address,
        candidate,
        expectedCandidateDigest: candidate.candidateDigest,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const provenance = await store.getMissionProvenance(mission.id);
    expect(provenance.evidence).toHaveLength(1);
    expect(provenance.plans).toHaveLength(0);
  });

  test("application failures expose stable codes and inaccessible missions share one response", async () => {
    await imported();
    await expect(app.compile(exact())).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    await expect(
      app.compile({ ...exact(), candidateDigest: "e".repeat(64) }),
    ).rejects.toMatchObject({ code: "CANDIDATE_CHANGED" });
    const environmentDigest = context.environment.environmentDigest;
    context.environment.environmentDigest = "d".repeat(64);
    await expect(app.compile(exact())).rejects.toMatchObject({ code: "ENVIRONMENT_CHANGED" });
    context.environment.environmentDigest = environmentDigest;
    context.authenticatedActor = { ...actor, role: "unheld" };
    await expect(app.read(address)).rejects.toMatchObject({ code: "FORBIDDEN" });
    context = trustedContext();
    context.authenticatedActor.id = "another-human";
    const foreign = await app.read(address).catch((error: unknown) => error);
    const absent = await app
      .read({ ...address, missionId: "absent-mission" })
      .catch((error: unknown) => error);
    expect(foreign).toBeInstanceOf(MissionApplicationError);
    expect(absent).toBeInstanceOf(MissionApplicationError);
    expect(foreign).toMatchObject({
      code: "NOT_FOUND",
      message: "Mission was not found or is not accessible",
    });
    expect(absent).toMatchObject({
      code: "NOT_FOUND",
      message: "Mission was not found or is not accessible",
    });
  });
});
