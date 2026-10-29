import {
  EvidenceReferenceSchema,
  ScientificDecisionSchema,
  canonicalJson,
  digestCanonical,
  type ExternalOperation,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import type {
  MdEffectDelivery,
  MissionOperationReconciliation,
  ScientificStore,
} from "@eigengrid/mission-runtime";
import {
  callSubmitter,
  decodeSubmitterResponse,
  type SubmitterSchedulerObservation,
} from "@eigengrid/slurm";
import { parseAmberSlurmDelivery } from "./amber-slurm-delivery";
import type { CanonicalMdExecutionGateway } from "./md-driver-binding";

const DETAILS = {
  gateway_unavailable:
    "MD observation gateway is unavailable; dispatch and recovery remain blocked",
  authority_or_delivery_unavailable:
    "MD observation requires the exact durable delivery and current project/site authority; operator review is required",
  rejected_or_no_claim:
    "Submitter rejected observation; no claim or absence of an effect cannot be inferred; operator review is required",
  transport_unavailable:
    "MD observation transport was interrupted; the existing effect remains uncertain",
  invalid_response:
    "MD observation response did not match the exact operation and binding; operator review is required",
  identity_conflict:
    "Observed Slurm identity conflicts with the recorded acknowledgement; operator review is required",
  conflict: "Scheduler evidence is conflicting; the existing effect requires operator review",
  indeterminate: "Scheduler evidence is indeterminate; the existing effect remains uncertain",
  state_changed:
    "MD operation changed while observation was in flight; its newer durable state was preserved",
  matched:
    "Exact Slurm identity observed; canonical receipt, collection and scientific QC remain pending",
} as const;
type RecoveryOutcome = keyof typeof DETAILS;

function conflictsWithKnownIdentity(
  known: ExternalOperation["externalIdentity"],
  observed: Extract<SubmitterSchedulerObservation, { status: "matched" }>["identity"],
): boolean {
  return (
    [
      ["slurmJobId", observed.jobId],
      ["slurmCluster", observed.cluster],
      ["slurmUid", observed.uid],
      ["slurmSubmittedAt", observed.submittedAt],
    ] as const
  ).some(([field, value]) => known?.[field] !== undefined && known[field] !== value);
}

/** DEC-REC-01: observation grants no submit authority. A rejected wire response
 * cannot distinguish an absent claim from authorization or another rejection.
 * Preserve that uncertainty; never manufacture absence or terminal success. */
export async function reconcileMdDelivery(input: {
  store: ScientificStore;
  operation: ExternalOperation;
  gateway?: CanonicalMdExecutionGateway;
  now: () => Date;
  signal?: AbortSignal;
}): Promise<MissionOperationReconciliation> {
  const { store, operation, gateway } = input;
  if (input.signal?.aborted)
    return {
      status: "waiting",
      operationId: operation.id,
      detail: "MD observation deferred for graceful shutdown",
    };
  const workUnit = await store.getWorkUnit(operation.workUnitId);
  if (!workUnit || workUnit.missionId !== operation.missionId)
    return {
      status: "waiting",
      operationId: operation.id,
      detail: "MD operation lacks its exact durable work unit; no recovery RPC was attempted",
    };
  if (!["effect_started", "acknowledged", "ambiguous"].includes(operation.state))
    return {
      status: "waiting",
      operationId: operation.id,
      detail:
        "MD operation is outside the in-flight observation states; no recovery RPC was attempted",
    };

  let outcome: RecoveryOutcome = "gateway_unavailable";
  let delivery: MdEffectDelivery | undefined;
  let observation: SubmitterSchedulerObservation | undefined;
  if (
    gateway?.database._provider === "postgres" &&
    gateway.siteAuthority.createAmberObservationSession
  ) {
    outcome = "authority_or_delivery_unavailable";
    try {
      const association = await store.getMissionProjectAssociation(operation.missionId);
      const provenance = await store.getMissionProvenance(operation.missionId);
      if (
        !association ||
        provenance.mission.requestedBy.kind !== "human" ||
        provenance.mission.requestedBy.id !== association.ownerUserId
      )
        throw new Error("Missing durable human owner/project association");
      const session = gateway.siteAuthority.createAmberObservationSession(
        gateway.database,
        { subject: association.ownerUserId, projectId: association.projectId },
        input.now,
      );
      const prepared = await session.observe(operation.id);
      if (prepared.action !== "observe") throw new Error("Recovery requires observation authority");
      if (input.signal?.aborted)
        return {
          status: "waiting",
          operationId: operation.id,
          detail: "MD observation deferred for graceful shutdown",
        };
      const target = await session.authorizeObserveRpc({ prepared });
      const body = parseAmberSlurmDelivery(target.delivery);
      if (
        target.delivery.operationId !== operation.id ||
        target.delivery.missionId !== operation.missionId ||
        target.delivery.workUnitId !== workUnit.id ||
        target.delivery.requestDigest !== operation.requestDigest ||
        canonicalJson(body.request) !== canonicalJson(operation.request)
      )
        throw new Error("Recovery delivery differs from its durable operation");
      delivery = target.delivery;
      outcome = "transport_unavailable";
      const raw = await (gateway.callSubmitter ?? callSubmitter)(target.socketPath, target.wire);
      outcome = "invalid_response";
      const response = decodeSubmitterResponse(raw, {
        operationId: operation.id,
        action: "observe",
        binding: body.binding,
      });
      if (response.status === "rejected") outcome = "rejected_or_no_claim";
      else if (response.status === "observation") {
        observation = response.observation;
        outcome = observation.status;
        if (observation.status === "matched") {
          // An ACK is transport evidence too, but it is still an identity we
          // must not overwrite if independent scheduler discovery disagrees.
          const existing = (await store.getExternalOperation(operation.id)) ?? operation;
          if (conflictsWithKnownIdentity(existing.externalIdentity, observation.identity))
            outcome = "identity_conflict";
        }
      }
    } catch {
      // Keep only a closed local classification. Arbitrary backend messages,
      // paths and exception bodies never enter durable diagnostic records.
    }
  }

  if (input.signal?.aborted)
    return {
      status: "waiting",
      operationId: operation.id,
      detail:
        "MD observation interrupted after RPC; durable operation and reservation were preserved",
    };
  try {
    const current = await store.getExternalOperation(operation.id);
    if (!current || current.revision !== operation.revision) outcome = "state_changed";
    if (outcome === "matched" && observation?.status === "matched" && current?.externalIdentity) {
      if (conflictsWithKnownIdentity(current.externalIdentity, observation.identity))
        outcome = "identity_conflict";
    }
    await persistRecoveryDecision(
      store,
      operation,
      workUnit,
      outcome,
      delivery,
      observation,
      input.now().toISOString(),
    );
    if (
      !input.signal?.aborted &&
      outcome !== "state_changed" &&
      current &&
      ["effect_started", "acknowledged", "ambiguous"].includes(current.state)
    ) {
      if (outcome === "matched" && observation?.status === "matched" && delivery) {
        if (current.state !== "acknowledged") {
          await store.transitionExternalOperation({
            operationId: current.id,
            expectedRevision: current.revision,
            to: "acknowledged",
            at: input.now().toISOString(),
            externalIdentity: {
              ...current.externalIdentity,
              schemaVersion: "eigengrid.md-submitter-observation/v1",
              operationId: current.id,
              deliveryDigest: delivery.deliveryDigest,
              transportStatus: "observed",
              slurmJobId: observation.identity.jobId,
              slurmCluster: observation.identity.cluster,
              slurmUid: observation.identity.uid,
              slurmSubmittedAt: observation.identity.submittedAt,
            },
          });
        }
      } else if (current.state !== "acknowledged") {
        // A failed or conflicting observation does not erase a durable ACK.
        // Preserve its identity/state and make the diagnostic visible instead.
        if (current.state === "effect_started")
          await store.transitionExternalOperation({
            operationId: current.id,
            expectedRevision: current.revision,
            to: "ambiguous",
            at: input.now().toISOString(),
          });
        if (current.budgetReservationId) {
          const budget = await store.getMissionBudget(current.missionId);
          if (
            budget.reservations.find((item) => item.id === current.budgetReservationId)?.state !==
            "ambiguous"
          )
            await store.settleBudgetReservation({
              missionId: current.missionId,
              reservationId: current.budgetReservationId,
              expectedBudgetRevision: budget.revision,
              state: "ambiguous",
              at: input.now().toISOString(),
            });
        }
      }
    }
  } catch {
    return {
      status: "waiting",
      operationId: operation.id,
      detail: `${DETAILS[outcome]}; durable diagnostic/state update unavailable, no resubmission is permitted`,
    };
  }
  return { status: "waiting", operationId: operation.id, detail: DETAILS[outcome] };
}

async function persistRecoveryDecision(
  store: ScientificStore,
  operation: ExternalOperation,
  workUnit: WorkUnit,
  outcome: RecoveryOutcome,
  delivery: MdEffectDelivery | undefined,
  observation: SubmitterSchedulerObservation | undefined,
  at: string,
): Promise<void> {
  const diagnostic = {
    schemaVersion: "eigengrid.md-delivery-recovery/v1",
    operationId: operation.id,
    workUnitId: workUnit.id,
    requestDigest: operation.requestDigest,
    deliveryDigest: delivery?.deliveryDigest ?? null,
    outcome,
    // No poll timestamp, capability nonce, remote reason or unbounded logs:
    // unchanged observations must not grow the ledger on every Head tick.
    identity: observation?.status === "matched" ? observation.identity : null,
    markerEvidence: observation?.status === "matched" ? observation.markerEvidence : null,
    resubmitAllowed: false,
    scientificCompletion: false,
  };
  const rationale = canonicalJson(diagnostic);
  const id = `decision-md-recovery-${digestCanonical(diagnostic)}`;
  const previous = (await store.getMissionProvenance(operation.missionId)).decisions.find(
    (item) => item.id === id,
  );
  if (previous) {
    if (previous.rationale !== rationale) throw new Error("Recovery diagnostic identity conflict");
    return;
  }
  const evidenceRefs: string[] = [];
  if (delivery) {
    const evidenceId = `evidence-md-delivery-${delivery.deliveryDigest}`;
    await store.createEvidence(
      EvidenceReferenceSchema.parse({
        id: evidenceId,
        missionId: operation.missionId,
        workUnitId: workUnit.id,
        kind: "source_snapshot",
        uri: `eigengrid-md-delivery://${delivery.operationId}/${delivery.deliveryDigest}`,
        contentDigest: delivery.deliveryDigest,
        immutable: true,
        sourceId: operation.id,
        mediaType: "application/vnd.eigengrid.md-effect-delivery+json",
        createdAt: delivery.createdAt,
      }),
    );
    evidenceRefs.push(evidenceId);
  }
  const decision = ScientificDecisionSchema.parse({
    id,
    missionId: operation.missionId,
    planId: workUnit.planId,
    category: "operational",
    question:
      "How can the existing MD delivery proceed without risking a duplicate external effect?",
    selectedOption:
      outcome === "matched"
        ? "observe_only_pending_canonical_collection"
        : "observe_only_operator_review",
    alternatives: [
      {
        option: "resubmit",
        reasonNotSelected:
          "No independent proof permits another submit for this immutable operation",
      },
    ],
    rationale,
    skillRefs: [],
    evidenceRefs,
    confidence: {
      level: "high",
      basis:
        "This records a transport recovery boundary, not effect absence or scientific completion",
    },
    riskClass: 0,
    requiresApproval: false,
    actor: { id: "eigengrid-md-recovery", kind: "service", role: "transport_observer" },
    createdAt: at,
  });
  try {
    await store.createDecision(decision);
  } catch (error) {
    // Two independent observers may first record the same diagnostic with
    // different clocks. Accept only the exact existing semantic snapshot.
    const concurrent = (await store.getMissionProvenance(operation.missionId)).decisions.find(
      (item) => item.id === id,
    );
    if (!concurrent || concurrent.rationale !== rationale) throw error;
  }
}
