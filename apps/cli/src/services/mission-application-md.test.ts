import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PostgresDatabase } from "@eigengrid/db";
import { ContentAddressedArtifactStore } from "@eigengrid/mission-runtime";
import {
  ApprovalRequestSchema,
  MdEnvironmentCapabilitySnapshotSchemaVersion,
  MdExecutionBindingParametersSchema,
  digestCanonical,
  computeMdWorkflowProtocolDigest,
} from "@eigengrid/scientific-schema";
import {
  CompilerPolicyProfileSchema,
  ScientificMissionService,
  computeCompilerPolicyDigest,
  computeMdCompilerPolicyDigest,
  computeMdEnvironmentDigest,
} from "@eigengrid/scientific-agent";
import { canRunPostgres, startEphemeralPostgres } from "../../../../tests/ts/helpers/postgres";
import {
  MD_FIXTURE_PROJECT,
  MD_FIXTURE_SUBJECT,
  MD_FIXTURE_NOW,
  seedCanonicalMdAuthority,
} from "../../../../tests/e2e/helpers/canonical-md-authority";
import {
  MissionApplication,
  assertCompletedMdPredecessor,
  MissionCandidateSchema,
  computeMissionCandidateDigest,
  type MissionApplicationContext,
} from "./mission-application";

for (const handoff of [false, true])
  test.skipIf(!canRunPostgres)(
    `MD human facade imports, approves and compiles with real PG (preparation handoff=${handoff})`,
    async () => {
      const cluster = await startEphemeralPostgres();
      const database = new PostgresDatabase(cluster.url);
      const directory = mkdtempSync(join(tmpdir(), "human-md-"));
      const artifacts = new ContentAddressedArtifactStore(directory);
      try {
        await database.init();
        await artifacts.init();
        const capability = {
          id: "amber.production-md",
          version: "1.0.0",
          contractDigest: "3".repeat(64),
        };
        const policyBase = {
          id: "md-human-policy",
          version: "1.0.0",
          minimumApprovalRole: "scientific_reviewer",
          capabilityByStageKind: {
            minimization: capability,
            heating: capability,
            equilibration: capability,
            production: capability,
          },
          riskByStageKind: {
            minimization: 3 as const,
            heating: 3 as const,
            equilibration: 3 as const,
            production: 3 as const,
          },
          retryPolicy: { maximumAttempts: 1, ambiguityRequiresReconciliation: true as const },
        };
        const mdCompilerPolicy = {
          ...policyBase,
          policyDigest: computeMdCompilerPolicyDigest(policyBase),
        };
        const environmentBase = {
          schemaVersion: MdEnvironmentCapabilitySnapshotSchemaVersion,
          id: "human-md-env",
          engine: {
            engine: "amber",
            executable: "pmemd",
            version: "24",
            buildDigest: "f".repeat(64),
            environmentDigest: "0".repeat(64),
            compatibilityVersion: "1.0.0",
          },
          capabilities: [capability],
          targetCompatibility: {
            family: "amber" as const,
            versionRange: ">=24",
            compatible: true as const,
            evaluatorVersion: "1.0.0",
            evidenceDigest: "e".repeat(64),
          },
          observedAt: MD_FIXTURE_NOW,
        };
        const mdEnvironment = {
          ...environmentBase,
          environmentDigest: computeMdEnvironmentDigest(environmentBase),
        };
        const seeded = await seedCanonicalMdAuthority(database, artifacts, [], {
          objectiveContent: "real hashed synthetic MD objective",
          policyDigest: handoff ? "8".repeat(64) : mdCompilerPolicy.policyDigest,
          environmentDigest: mdEnvironment.environmentDigest,
          stopAfterPreparation: true,
        });
        if (handoff) {
          seeded.protocol.purpose = "technical_pilot";
          seeded.protocol.preparationPolicyDigest = "8".repeat(64);
          seeded.protocol.stages = seeded.protocol.stages.slice(0, 1);
          seeded.protocol.protocolDigest = computeMdWorkflowProtocolDigest(seeded.protocol);
          seeded.stageSkillBindings = seeded.stageSkillBindings.slice(0, 1);
        }
        const policy = CompilerPolicyProfileSchema.parse({
          id: "unused-electronic-policy",
          version: "1.0.0",
          policyDigest: "0".repeat(64),
          minimumKnowledgeMaturity: "draft",
          minimumCapabilityMaturity: "plannable",
          automaticApprovalRiskCeiling: 1,
          materialDecisionApproval: "covered_by_plan",
          minimumApprovalRole: "scientific_reviewer",
          requiredDecisionCategories: ["method"],
          defaultRetryPolicy: { maximumAttempts: 1, ambiguityRequiresReconciliation: true },
          capabilityByKind: {},
          retryOverrides: {},
          dependencyMap: {},
        });
        policy.policyDigest = computeCompilerPolicyDigest(policy);
        const context: MissionApplicationContext = {
          authenticatedActor: {
            id: MD_FIXTURE_SUBJECT,
            kind: "human",
            role: "scientific_reviewer",
          },
          authorizedRoles: ["scientific_reviewer"],
          compilerPolicy: policy,
          environment: {
            id: "unused-electronic-env",
            environmentDigest: mdEnvironment.environmentDigest,
            selectedEngine: { id: "fixture", version: "1.0.0", adapterVersion: "1.0.0" },
            capabilities: [],
            skillCompatibility: [],
          },
          mdCompilerPolicy,
          mdEnvironment,
        };
        let currentTime = MD_FIXTURE_NOW;
        const makeApp = () =>
          new MissionApplication({
            store: seeded.store,
            mdStore: seeded.mdStore,
            service: new ScientificMissionService({
              store: seeded.store,
              now: () => new Date(currentTime),
            }),
            artifacts,
            now: () => new Date(currentTime),
            authority: {
              current: async () => structuredClone(context),
              assertCurrent: async (prior) => {
                if (digestCanonical(prior) !== digestCanonical(context))
                  throw new Error("Changed authority");
              },
            },
          });
        let app = makeApp();
        const provenance = await seeded.store.getMissionProvenance(seeded.plan.missionId);
        const material = {
          schemaVersion: "eigengrid.mission-candidate/v1" as const,
          plan: seeded.plan,
          decisions: [],
          evidence: provenance.evidence,
          md: {
            system: seeded.manifest,
            protocol: seeded.protocol,
            decisionRefs: seeded.manifest.decisionRefs,
            stageSkillBindings: seeded.stageSkillBindings,
          },
        };
        const candidate = MissionCandidateSchema.parse({
          ...material,
          candidateDigest: computeMissionCandidateDigest(material),
        });
        const address = { projectId: MD_FIXTURE_PROJECT, missionId: seeded.plan.missionId };
        const exact = {
          ...address,
          planId: seeded.plan.id,
          candidateDigest: candidate.candidateDigest,
        };
        const beforeOperations = provenance.operations.length;
        const imported = await app.importCandidate({
          ...address,
          candidate,
          expectedCandidateDigest: candidate.candidateDigest,
        });
        expect(imported.approval.state).toBe("pending");

        if (!handoff) {
          const preparedProvenance = await seeded.store.getMissionProvenance(seeded.plan.missionId);
          const atomMapOperation = preparedProvenance.operations.find(
            (item) => item.request.schemaVersion === "eigengrid.atom-map-publication-request/v2",
          )!;
          const pendingOperationApproval = ApprovalRequestSchema.parse({
            id: "approval-cli-atom-map-publication",
            missionId: seeded.plan.missionId,
            subjectType: "operation",
            subjectId: atomMapOperation.id,
            subjectVersion: 1,
            subjectRevision: 1,
            state: "pending",
            requestedFromRole: "scientific_reviewer",
            payloadDigest: atomMapOperation.requestDigest,
            policyDigest: atomMapOperation.policyDigest,
            editableFields: [],
            requestedBy: context.authenticatedActor,
            requestedAt: currentTime,
          });
          await seeded.store.createApprovalRequest(pendingOperationApproval);
          const operationReview = await app.review({ ...address, planId: seeded.plan.id });
          expect(
            operationReview.approvals.some((item) => item.id === pendingOperationApproval.id),
          ).toBe(true);
          const operationDecision = await app.approve({
            ...exact,
            approvalRequestId: pendingOperationApproval.id,
            subjectVersion: pendingOperationApproval.subjectVersion,
            subjectRevision: pendingOperationApproval.subjectRevision,
            payloadDigest: pendingOperationApproval.payloadDigest,
            policyDigest: pendingOperationApproval.policyDigest,
            decision: "approved",
            reason: "Approve exact AtomMap publication request through the human facade",
          });
          expect(operationDecision.state).toBe("approved");
        }

        await expect(app.compile(exact)).rejects.toThrow();
        const review = await app.review({ ...address, planId: seeded.plan.id });
        expect(
          review.approvals
            .filter((item) => item.state === "pending")
            .map((item) => item.subjectType)
            .sort(),
        ).toEqual(["biomolecular_system_manifest", "md_protocol", "plan"]);
        // Prerequisite decisions are already reviewed by preparation publication. All new execution approvals are explicit here.
        for (const request of review.approvals.filter((item) => item.state === "pending")) {
          await app.approve({
            ...exact,
            approvalRequestId: request.id,
            subjectVersion: request.subjectVersion,
            subjectRevision: request.subjectRevision,
            payloadDigest: request.payloadDigest,
            policyDigest: request.policyDigest,
            decision: "approved",
            reason: "Review exact synthetic MD candidate; no real engine qualification",
          });
        }
        app = makeApp();
        const compiled = await app.compile(exact);
        expect(compiled.workUnits).toHaveLength(1);
        const binding = MdExecutionBindingParametersSchema.parse(
          compiled.workUnits[0]!.protocolFragment.parameters,
        );
        expect(binding.system.digest).toBe(seeded.manifest.manifestDigest);
        expect(binding.protocol.digest).toBe(seeded.protocol.protocolDigest);
        expect("policyDigest" in compiled && compiled.policyDigest).toBe(
          mdCompilerPolicy.policyDigest,
        );
        expect("deferredStages" in compiled && compiled.deferredStages.length).toBe(
          handoff ? 0 : 1,
        );
        if (handoff) {
          const prepared = await seeded.store.getMissionProvenance(address.missionId);
          for (const work of prepared.workUnits.filter((w) => w.id !== compiled.workUnits[0]!.id))
            await seeded.store.transitionWorkUnit({
              workUnitId: work.id,
              expectedRevision: work.revision,
              to: "succeeded",
              claimOwner: work.claimOwner!,
              at: currentTime,
            });
          await expect(
            app.replanUnstarted({ ...exact, candidateDigest: "f".repeat(64), reason: "invalid" }),
          ).rejects.toThrow();
          expect(
            (
              await app.replanUnstarted({
                ...exact,
                reason: "Correct unsupported output cadence before dispatch",
              })
            ).state,
          ).toBe("replanning");
          expect(
            (await app.replanUnstarted({ ...exact, reason: "Idempotent withdrawal" })).state,
          ).toBe("replanning");
          const result = await seeded.store.getMissionProvenance(address.missionId);
          expect(result.workUnits.find((w) => w.id === compiled.workUnits[0]!.id)?.state).toBe(
            "cancelled",
          );
          expect(result.operations).toHaveLength(beforeOperations);
          return;
        }
        expect((await app.start(exact)).state).toBe("executing");
        await expect(
          app.replanUnstarted({ ...exact, reason: "Must reject live mission" }),
        ).rejects.toThrow("unstarted");
        expect((await app.start(exact)).state).toBe("executing");
        const after = await seeded.store.getMissionProvenance(address.missionId);
        expect(after.operations).toHaveLength(beforeOperations);
        expect(
          after.workUnits.filter((item) => item.id === compiled.workUnits[0]!.id),
        ).toHaveLength(1);
        expect((await app.status(address)).qcPending).toBe(true);
        const originalEnvironmentDigest = context.mdEnvironment!.environmentDigest;
        context.mdEnvironment!.environmentDigest = "9".repeat(64);
        await expect(app.start(exact)).rejects.toThrow("environment");
        context.mdEnvironment!.environmentDigest = originalEnvironmentDigest;
        currentTime = "2026-08-25T00:00:00.000Z";
        await expect(
          app.importCandidate({
            ...address,
            candidate,
            expectedCandidateDigest: candidate.candidateDigest,
          }),
        ).rejects.toThrow("expired");
      } finally {
        await database.close();
        await cluster.cleanup();
        rmSync(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

test("MD successor rejects active, unrelated and incomplete preparation", () => {
  const input = {
    state: "awaiting_approval",
    activePlanId: "preparation",
    parentPlanId: "preparation",
    workUnits: [{ id: "work", planId: "preparation", state: "succeeded" }],
    operations: [{ workUnitId: "work", state: "confirmed" }],
  };
  expect(() => assertCompletedMdPredecessor(input)).not.toThrow();
  expect(() => assertCompletedMdPredecessor({ ...input, state: "executing" })).toThrow("successor");
  expect(() => assertCompletedMdPredecessor({ ...input, parentPlanId: "unrelated" })).toThrow(
    "successor",
  );
  expect(() =>
    assertCompletedMdPredecessor({
      ...input,
      workUnits: [{ ...input.workUnits[0]!, state: "claimed" }],
    }),
  ).toThrow("successor");
  expect(() =>
    assertCompletedMdPredecessor({
      ...input,
      operations: [{ workUnitId: "work", state: "pending" }],
    }),
  ).toThrow("successor");
});

test("MD successor can skip only exact rejected drafts without work units", () => {
  const input = {
    state: "awaiting_approval",
    activePlanId: "prep",
    parentPlanId: "draft",
    workUnits: [{ id: "work", planId: "prep", state: "succeeded" }],
    operations: [{ workUnitId: "work", state: "confirmed" }],
    plans: [{ id: "draft", parentPlanId: "prep", version: 5, revision: 1, planDigest: "digest" }],
    approvals: [
      {
        subjectType: "plan",
        subjectId: "draft",
        subjectVersion: 5,
        subjectRevision: 1,
        payloadDigest: "digest",
        state: "rejected",
      },
    ],
  };
  expect(() => assertCompletedMdPredecessor(input)).not.toThrow();
  expect(() => assertCompletedMdPredecessor({ ...input, approvals: [] })).toThrow("successor");
  expect(() =>
    assertCompletedMdPredecessor({
      ...input,
      approvals: [{ ...input.approvals[0]!, payloadDigest: "other" }],
    }),
  ).toThrow("successor");
  expect(() =>
    assertCompletedMdPredecessor({
      ...input,
      workUnits: [...input.workUnits, { id: "draftwork", planId: "draft", state: "succeeded" }],
    }),
  ).toThrow("successor");
  expect(() =>
    assertCompletedMdPredecessor({
      ...input,
      plans: [{ ...input.plans[0]!, parentPlanId: "draft" }],
    }),
  ).toThrow("successor");
});
