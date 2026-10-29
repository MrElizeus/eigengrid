import { expect } from "bun:test";
import {
  ScientificStore,
  mdStageEffectIdentity,
  RestartSafeScientificMissionHeadStore,
  ScientificEffectReconciliationStore,
  type ScientificDatabase,
} from "@eigengrid/mission-runtime";
import {
  canonicalJson,
  digestCanonical,
  OperationReceiptSchema,
  type ExternalOperation,
} from "@eigengrid/scientific-schema";
import { slurmSubmissionJobName, slurmSubmissionMarker } from "@eigengrid/slurm";
import { CanonicalScientificExecutionDriver } from "../../../apps/cli/src/services/scientific-mission-driver";
import {
  HeadMdDeliverySigner,
  type HeadMdSubmitterGrant,
  type PreparedMdCapability,
} from "../../../apps/cli/src/services/md-delivery-signer";
import { parseAmberSlurmDelivery } from "../../../apps/cli/src/services/amber-slurm-delivery";

/** Test seam: real PostgreSQL, durable delivery and Ed25519 signer; a counted
 * socket replacement supplies scheduler evidence. Protected session file/key/
 * fencing behavior is covered separately by head-md-site-authority.test.ts. */
export async function exerciseMdDeliveryRecovery(input: {
  database: ScientificDatabase;
  grant: HeadMdSubmitterGrant;
  privateKey: string;
  lostAck: ExternalOperation;
  lostCommit: ExternalOperation;
  at: string;
}) {
  const store = new ScientificStore(input.database);
  const at = new Date(Date.parse(input.at) + 120_000).toISOString();
  let rpcCalls = 0;
  let responseKind: "matched" | "rejected" | "conflict" | "invalid" = "matched";
  const createDriver = (failSettlement = false) => {
    // Each driver gets a new store and signer to exercise restart/concurrency.
    const restartedStore = new ScientificStore(input.database);
    if (failSettlement)
      restartedStore.settleBudgetReservation = async () => {
        throw new Error("simulated crash before MD budget settlement");
      };
    let prepared: PreparedMdCapability | undefined;
    return new CanonicalScientificExecutionDriver({
      store: restartedStore,
      execution: {} as never,
      effectPersistence: new ScientificEffectReconciliationStore(input.database),
      currentPolicyDigestFor: () => input.grant.currentPolicyDigest,
      md: {
        database: input.database,
        prepareBundle: async () => {
          throw new Error("Recovery must not access CAS");
        },
        siteAuthority: {
          createAmberDeliverySession: () => {
            throw new Error("Recovery must not create a delivery");
          },
          createAmberObservationSession(database, association) {
            expect(association).toEqual({
              subject: input.grant.principal.subject,
              projectId: input.grant.principal.projectId,
            });
            const signer = new HeadMdDeliverySigner(
              database,
              () => input.grant,
              () => {
                throw new Error("Observe-only signer builder must not execute");
              },
              input.privateKey,
              () => new Date(at),
            );
            return {
              async observe(operationId) {
                prepared = await signer.observe(operationId);
                return prepared;
              },
              async authorizeObserveRpc(value) {
                expect(value.prepared.action).toBe("observe");
                const delivery = await new ScientificEffectReconciliationStore(
                  database,
                ).readMdSubmissionDelivery(
                  value.prepared.delivery.operationId,
                  input.grant.principal,
                );
                expect(canonicalJson(delivery)).toBe(canonicalJson(value.prepared.delivery));
                return {
                  socketPath: "/run/eigengrid/fixture.sock",
                  wire: new Uint8Array(value.prepared.wire),
                  delivery: structuredClone(value.prepared.delivery),
                  capabilityRequestId: value.prepared.capability.requestId,
                };
              },
            };
          },
        },
        async callSubmitter(_path, wire) {
          rpcCalls++;
          if (!prepared) throw new Error("No observation capability");
          expect(prepared.action).toBe("observe");
          expect(wire).toEqual(prepared.wire);
          if (responseKind === "rejected") return { status: "rejected", resubmitAllowed: false };
          if (responseKind === "invalid") return { status: "confirmed", exitCode: 0 };
          const binding = parseAmberSlurmDelivery(prepared.delivery).binding;
          if (responseKind === "conflict")
            return {
              status: "observation",
              operationId: binding.operationId,
              resubmitAllowed: false,
              observation: {
                status: "conflict",
                resubmitAllowed: false,
                reason: "SECRET ignored remote text",
                observations: [],
              },
            };
          const identity = {
            jobId: "9002",
            cluster: binding.cluster,
            uid: binding.uid,
            submittedAt: new Date(binding.notBefore).toISOString().replace(".000Z", "Z"),
          };
          return {
            status: "observation",
            operationId: binding.operationId,
            resubmitAllowed: false,
            observation: {
              status: "matched",
              resubmitAllowed: false,
              reason: "Exact scheduler match",
              identity,
              markerEvidence: "accounting_comment",
              observations: [
                {
                  ...identity,
                  source: "sacct",
                  jobName: slurmSubmissionJobName(binding),
                  marker: slurmSubmissionMarker(binding),
                },
              ],
            },
          };
        },
      },
      now: () => new Date(at),
    });
  };
  const reconcile = async (operation: ExternalOperation) =>
    createDriver().reconcileOperation(operation, { ownerId: "restarted-head", now: at });
  const diagnostics = async (operationId: string) =>
    (await store.getMissionProvenance(input.lostAck.missionId)).decisions.filter(
      (item) =>
        item.id.startsWith("decision-md-recovery-") &&
        JSON.parse(item.rationale).operationId === operationId,
    );

  responseKind = "rejected";
  await reconcile(input.lostCommit);
  await reconcile(input.lostCommit);
  const blocked = await store.getExternalOperation(input.lostCommit.id);
  expect(blocked?.state).toBe("ambiguous");
  expect(blocked?.receiptId).toBeUndefined();
  expect(await diagnostics(input.lostCommit.id)).toHaveLength(1);
  expect(JSON.parse((await diagnostics(input.lostCommit.id))[0]!.rationale).outcome).toBe(
    "rejected_or_no_claim",
  );

  responseKind = "matched";
  await Promise.all([reconcile(input.lostAck), reconcile(input.lostAck)]);
  const acknowledged = await store.getExternalOperation(input.lostAck.id);
  expect(acknowledged).toMatchObject({
    state: "acknowledged",
    externalIdentity: { transportStatus: "observed", slurmJobId: "9002" },
  });
  expect(acknowledged?.receiptId).toBeUndefined();
  expect(await store.getWorkUnit(input.lostAck.workUnitId)).toMatchObject({ state: "executing" });
  const budget = await store.getMissionBudget(input.lostAck.missionId);
  expect(
    budget.reservations.find((entry) => entry.id === input.lostAck.budgetReservationId)?.state,
  ).toBe("ambiguous");
  expect(
    budget.reservations.find((entry) => entry.id === input.lostCommit.budgetReservationId)?.state,
  ).toBe("ambiguous");
  const matchingDecisions = (await diagnostics(input.lostAck.id)).filter(
    (entry) => JSON.parse(entry.rationale).outcome === "matched",
  );
  expect(matchingDecisions).toHaveLength(1);
  await reconcile(acknowledged!);
  expect(
    (await diagnostics(input.lostAck.id)).filter(
      (entry) => JSON.parse(entry.rationale).outcome === "matched",
    ),
  ).toHaveLength(1);

  for (const kind of ["conflict", "invalid", "rejected"] as const) {
    responseKind = kind;
    await reconcile(acknowledged!);
    expect(await store.getExternalOperation(input.lostAck.id)).toMatchObject({
      state: "acknowledged",
      externalIdentity: { slurmJobId: "9002" },
    });
  }
  expect(JSON.stringify(await diagnostics(input.lostAck.id))).not.toContain("SECRET");
  expect(await store.getMissionBudget(input.lostAck.missionId)).toEqual(budget);

  return {
    verifyRevoked: async () => {
      const before = rpcCalls;
      await reconcile(acknowledged!);
      expect(rpcCalls).toBe(before);
      expect(await store.getExternalOperation(input.lostAck.id)).toMatchObject({
        state: "acknowledged",
        externalIdentity: { slurmJobId: "9002" },
      });
      expect(
        (await diagnostics(input.lostAck.id)).some(
          (entry) => JSON.parse(entry.rationale).outcome === "authority_or_delivery_unavailable",
        ),
      ).toBe(true);
    },
    verifyLateReceipts: async () => {
      for (const [source, status] of [
        [input.lostAck, "confirmed"],
        [input.lostCommit, "failed"],
      ] as const) {
        const current = (await store.getExternalOperation(source.id))!;
        const receipt = OperationReceiptSchema.parse({
          id: `late-${source.id}`,
          operationId: source.id,
          requestDigest: source.requestDigest,
          status,
          ...mdStageEffectIdentity(source),
          detailDigest: digestCanonical({ fixture: "late-canonical-receipt", status }),
          recordedAt: at,
        });
        await expect(
          store.finalizeOperationReceipt(source.id, current.revision, {
            ...receipt,
            requestDigest: "0".repeat(64),
          }),
        ).rejects.toThrow();
        await store.finalizeOperationReceipt(source.id, current.revision, receipt);
        const scanner = new RestartSafeScientificMissionHeadStore(store, input.database);
        expect(
          (await scanner.listOperationsForReconciliation(source.missionId)).some(
            (item) => item.id === source.id,
          ),
        ).toBe(true);
        const reservationBefore = (
          await store.getMissionBudget(source.missionId)
        ).reservations.find((entry) => entry.id === source.budgetReservationId);
        const tamperTx = await input.database.beginTransaction();
        await tamperTx.query(
          "UPDATE scientific_operation_receipts SET payload_json = $1 WHERE id = $2",
          [canonicalJson({ ...receipt, jobId: "forged-job" }), receipt.id],
        );
        await tamperTx.commit();
        try {
          await expect(reconcile(source)).rejects.toThrow("exact receipt identity");
          expect(
            (await store.getMissionBudget(source.missionId)).reservations.find(
              (entry) => entry.id === source.budgetReservationId,
            ),
          ).toEqual(reservationBefore);
        } finally {
          const restoreTx = await input.database.beginTransaction();
          await restoreTx.query(
            "UPDATE scientific_operation_receipts SET payload_json = $1 WHERE id = $2",
            [canonicalJson(receipt), receipt.id],
          );
          await restoreTx.commit();
        }
        if (status === "failed") {
          await expect(
            createDriver(true).reconcileOperation(source, { ownerId: "restarted-head", now: at }),
          ).rejects.toThrow("simulated crash before MD budget settlement");
          expect(await store.getWorkUnit(source.workUnitId)).toMatchObject({ state: "failed" });
          expect(
            (await store.getMissionBudget(source.missionId)).reservations.find(
              (entry) => entry.id === source.budgetReservationId,
            )?.state,
          ).toBe("ambiguous");
          expect(
            (await scanner.listOperationsForReconciliation(source.missionId)).some(
              (item) => item.id === source.id,
            ),
          ).toBe(true);
        }
        const before = rpcCalls;
        const result = await reconcile(source);
        expect(result.status).toBe(status === "confirmed" ? "waiting" : "reconciled");
        expect(await store.getWorkUnit(source.workUnitId)).toMatchObject({
          state: status === "confirmed" ? "observing" : "failed",
        });
        const settled = await store.getWorkUnit(source.workUnitId);
        await reconcile(source);
        expect(await store.getWorkUnit(source.workUnitId)).toEqual(settled);
        expect(rpcCalls).toBe(before);
        expect(
          (await store.getMissionBudget(source.missionId)).reservations.find(
            (entry) => entry.id === source.budgetReservationId,
          )?.state,
        ).toBe("consumed");
        if (status === "failed")
          expect(
            (await scanner.listOperationsForReconciliation(source.missionId)).some(
              (item) => item.id === source.id,
            ),
          ).toBe(false);
      }
    },
  };
}
