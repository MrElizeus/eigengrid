import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  ApprovalRequestSchema,
  ApprovalResponseSchema,
  AtomMapPublicationRequestSchema,
  BiomolecularSystemBuildRequestSchema,
  BiomolecularMaterialPublicationBindingSchema,
  BiomolecularSystemBuildWorkUnitParametersSchema,
  EvidenceReferenceSchema,
  ExternalOperationSchema,
  ForceFieldStackPublicationRequestSchema,
  OperationReceiptSchema,
  ScientificObservationSchema,
  WorkUnitSchema,
  assertAtomMapDigest,
  assertBiomolecularDecisionDigest,
  assertForceFieldStackDigest,
  canonicalJson,
  computeBiomolecularSystemManifestDigest,
  digestCanonical,
  type ExternalOperation,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import {
  ScientificStore,
  MdProjectionStore,
  ContentAddressedArtifactStore,
  ScientificEffectReconciliationStore,
  resolveLinkedLigandMaterialDigests,
  type ScientificDatabase,
  type ScientificMissionWorkDriver,
  type MissionWorkExecution,
  type MissionOperationReconciliation,
} from "@eigengrid/mission-runtime";
import {
  assertAmberPreparedSystemPackage,
  assertPreparedSystemFileBytes,
} from "@eigengrid/amber-adapter";
import type { MissionApplicationAuthority, MissionApplicationContext } from "./mission-application";
import { systemPreparationEffectIdentity } from "./system-preparation-binding";
import {
  AmberFrozenSystemDraftSchema,
  assertAtomMapPackageMaterial,
} from "./amber-frozen-material";
export { AmberFrozenSystemDraftSchema } from "./amber-frozen-material";

const address = z
  .object({ projectId: z.string().min(1), missionId: z.string().min(1), planId: z.string().min(1) })
  .strict();
const effectRequest = z.union([
  ForceFieldStackPublicationRequestSchema,
  BiomolecularSystemBuildRequestSchema,
  AtomMapPublicationRequestSchema,
]);
export const AmberMaterialRequestSchema = z.discriminatedUnion("action", [
  address.extend({ action: z.literal("propose-decision"), decision: z.unknown() }).strict(),
  address
    .extend({
      action: z.literal("propose-work-unit"),
      workUnit: WorkUnitSchema,
      request: effectRequest,
    })
    .strict(),
  address
    .extend({
      action: z.literal("approve"),
      approvalRequestId: z.string().min(1),
      subjectVersion: z.number().int().positive(),
      subjectRevision: z.number().int().positive(),
      payloadDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      policyDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      decision: z.enum(["approved", "rejected"]),
      reason: z.string().trim().min(1),
    })
    .strict(),
  address.extend({ action: z.literal("execute"), workUnitId: z.string().min(1) }).strict(),
  address.extend({ action: z.literal("finish-preparation") }).strict(),
  address.extend({ action: z.literal("replan-preparation") }).strict(),
]);

const ownerId = "eigengrid-amber-material-publication";
const supported = new Set([
  "biomolecular.build-system",
  "amber.force-field-stack",
  "amber.topology-coordinate-validation",
]);
export function amberMaterialCapability(id: string) {
  if (!supported.has(id)) throw new Error("Unsupported material-publication capability");
  const requestSchema =
    id === "biomolecular.build-system"
      ? BiomolecularSystemBuildRequestSchema
      : id === "amber.force-field-stack"
        ? ForceFieldStackPublicationRequestSchema
        : AtomMapPublicationRequestSchema;
  return {
    id,
    version: "1.0.0",
    contractDigest: digestCanonical({
      id,
      version: "1.0.0",
      publisher: "eigengrid-frozen-amber-material-adoption/v1",
      request: zodToJsonSchema(requestSchema, { $refStrategy: "none" }),
      parameters: zodToJsonSchema(
        id === "biomolecular.build-system"
          ? BiomolecularSystemBuildWorkUnitParametersSchema
          : BiomolecularMaterialPublicationBindingSchema,
        { $refStrategy: "none" },
      ),
    }),
  };
}
const isSupported = (unit: WorkUnit) =>
  unit.kind === "scientific_capability" &&
  unit.protocolFragment.kind === "scientific_capability" &&
  supported.has(unit.protocolFragment.capability.id) &&
  canonicalJson(unit.protocolFragment.capability) ===
    canonicalJson(amberMaterialCapability(unit.protocolFragment.capability.id)) &&
  unit.protocolFragment.capability.id === unit.executionPolicy.capability &&
  unit.executionPolicy.riskClass === 3 &&
  unit.protocolFragment.riskClass === 3 &&
  unit.approvalPolicy.required;

export function materialOperationIdentity(unit: WorkUnit) {
  if (!isSupported(unit)) throw new Error("Unsupported material-publication capability");
  if (unit.executionPolicy.capability === "biomolecular.build-system")
    return systemPreparationEffectIdentity(unit);
  const token = digestCanonical({
    missionId: unit.missionId,
    planId: unit.planId,
    planVersion: unit.planVersion,
    workUnitId: unit.id,
    parameters: unit.protocolFragment.parameters,
    outputContract: unit.outputContract,
  }).slice(0, 32);
  return {
    operationId: `operation-material-${token}`,
    jobId: `job-material-${token}`,
    attemptId: `attempt-material-${token}-1`,
    reservationId: `reservation-material-${token}`,
    idempotencyKey: `amber-material/${unit.missionId}/${unit.id}/${token}`,
  };
}

/** Check v2 coordinator identity and all scientific fields before any intent,
 * admission, output evidence or receipt can be created. */
export function assertMaterialPublicationRequest(unit: WorkUnit, value: unknown) {
  if (!isSupported(unit) || unit.protocolFragment.kind !== "scientific_capability")
    throw new Error("Material publication requires its closed risk-3 capability WorkUnit");
  const request = effectRequest.parse(value);
  const identity = materialOperationIdentity(unit);
  if (
    !("missionId" in request) ||
    request.missionId !== unit.missionId ||
    request.planId !== unit.planId ||
    request.planVersion !== unit.planVersion ||
    request.workUnitId !== unit.id ||
    request.intendedJobId !== identity.jobId ||
    request.intendedAttemptId !== identity.attemptId ||
    canonicalJson(request.capability) !== canonicalJson(unit.protocolFragment.capability) ||
    request.parametersDigest !== digestCanonical(unit.protocolFragment.parameters) ||
    request.outputContractDigest !== digestCanonical(unit.outputContract)
  )
    throw new Error("Material request differs from its exact v2 WorkUnit/coordinator binding");
  if (unit.executionPolicy.capability === "biomolecular.build-system") {
    const build = BiomolecularSystemBuildRequestSchema.parse(request);
    const parameters = BiomolecularSystemBuildWorkUnitParametersSchema.parse(
      unit.protocolFragment.parameters,
    );
    const b = parameters.systemBuild;
    if (
      !("missionId" in build) ||
      build.systemManifest.id !== parameters.manifestId ||
      build.systemManifest.revision !== parameters.manifestRevision ||
      canonicalJson(build.decisionRefs) !==
        canonicalJson([...b.decisionRefs].sort((a, c) => a.id.localeCompare(c.id))) ||
      canonicalJson(build.forceFieldStack) !== canonicalJson(b.forceFieldStack) ||
      canonicalJson(build.outputArtifacts) !== canonicalJson(b.outputArtifacts) ||
      build.inputEvidenceId !== b.primaryInputEvidenceId ||
      canonicalJson([...unit.inputRefs].sort()) !==
        canonicalJson([...b.sourceEvidenceRefs, b.forceFieldStackEvidenceRef].sort()) ||
      canonicalJson(build.sourceEvidence.map((x) => x.id).sort()) !==
        canonicalJson([...b.sourceEvidenceRefs].sort())
    )
      throw new Error("System-build request differs from its approved material binding");
  } else {
    const binding = BiomolecularMaterialPublicationBindingSchema.parse(
      unit.protocolFragment.parameters,
    );
    if (binding.subjectKind === "force_field_stack") {
      const stack = ForceFieldStackPublicationRequestSchema.parse(request);
      if (
        unit.executionPolicy.capability !== "amber.force-field-stack" ||
        canonicalJson(stack.stack) !== canonicalJson(binding.subject) ||
        stack.outputArtifact.evidenceRef !== binding.artifactEvidenceRef ||
        canonicalJson(stack.sourceEvidence.map((x) => x.id).sort()) !==
          canonicalJson([...binding.sourceEvidenceRefs].sort())
      )
        throw new Error("Force-field publication differs from its approved material binding");
    } else {
      const map = AtomMapPublicationRequestSchema.parse(request);
      if (
        unit.executionPolicy.capability !== "amber.topology-coordinate-validation" ||
        canonicalJson(map.atomMap) !== canonicalJson(binding.subject) ||
        canonicalJson(map.systemManifest) !== canonicalJson(binding.systemManifest) ||
        map.sourceArtifact.evidenceRef !== binding.artifactEvidenceRef
      )
        throw new Error("AtomMap publication differs from its approved material binding");
    }
  }
  return request;
}

interface Ports {
  database: ScientificDatabase;
  store: ScientificStore;
  mdStore: MdProjectionStore;
  artifacts: ContentAddressedArtifactStore;
  authority: MissionApplicationAuthority;
}

/** Human-only typed preparation facade. There is no shell, runner or scheduler
 * input and this facade cannot dispatch a molecular-dynamics WorkUnit. */
export class AmberMaterialApplication {
  constructor(private readonly ports: Ports) {}

  private async awaitApproval(
    input: z.infer<typeof address>,
    context: MissionApplicationContext,
    at: string,
  ) {
    let mission = await this.ports.store.getMission(input.missionId);
    if (!mission) throw new Error("Material mission absent");
    if (mission.state === "executing" || mission.state === "observing")
      mission = await this.ports.store.transitionMission({
        missionId: mission.id,
        expectedRevision: mission.revision,
        to: "paused",
        reason: "material_effect_waits_for_separate_exact_human_approval",
        actor: context.authenticatedActor,
        at,
      });
    if (mission.state === "paused")
      mission = await this.ports.store.transitionMission({
        missionId: mission.id,
        expectedRevision: mission.revision,
        to: "awaiting_approval",
        reason: "exact_material_approval_requested",
        actor: context.authenticatedActor,
        at,
      });
    if (mission.state !== "awaiting_approval")
      throw new Error("Material approval requires the canonical awaiting-approval state");
  }

  private async resumeApprovedEffect(
    input: z.infer<typeof address>,
    context: MissionApplicationContext,
    at: string,
  ) {
    const provenance = await this.ports.store.getMissionProvenance(input.missionId);
    if (provenance.approvals.some((x) => x.state === "pending"))
      throw new Error("Material mission has pending exact human approvals");
    let mission = provenance.mission;
    if (mission.activePlanId !== input.planId) throw new Error("Material plan is no longer active");
    if (mission.state === "awaiting_approval")
      mission = await this.ports.store.transitionMission({
        missionId: mission.id,
        expectedRevision: mission.revision,
        to: "ready",
        reason: "separate_material_approvals_completed",
        actor: context.authenticatedActor,
        at,
      });
    if (mission.state === "ready")
      mission = await this.ports.store.transitionMission({
        missionId: mission.id,
        expectedRevision: mission.revision,
        to: "executing",
        reason: "exact_approved_material_effect_requested",
        actor: context.authenticatedActor,
        at,
      });
    if (mission.state !== "executing") throw new Error("Material effect mission is not executable");
  }

  private async access(input: z.infer<typeof address>): Promise<MissionApplicationContext> {
    const context = await this.ports.authority.current();
    await this.ports.authority.assertCurrent(context);
    if (context.authenticatedActor.kind !== "human")
      throw new Error("Human material owner required");
    await this.ports.store.assertProductionMissionPlanningAccess({
      ...input,
      ownerUserId: context.authenticatedActor.id,
    });
    const provenance = await this.ports.store.getMissionProvenance(input.missionId);
    const plan = provenance.plans.find((x) => x.id === input.planId);
    if (
      !plan ||
      plan.status !== "approved" ||
      plan.requiredApprovals.length !== 1 ||
      plan.requiredApprovals[0] !== context.compilerPolicy.minimumApprovalRole
    )
      throw new Error("Material publication requires an exact approved plan and current role");
    const approvals = provenance.approvals.filter(
      (x) =>
        x.subjectType === "plan" &&
        x.subjectId === plan.id &&
        x.subjectVersion === plan.version &&
        x.subjectRevision === plan.revision &&
        x.payloadDigest === plan.planDigest &&
        x.policyDigest === context.compilerPolicy.policyDigest &&
        x.state === "approved",
    );
    if (approvals.length !== 1)
      throw new Error("Exact current material-plan approval missing or ambiguous");
    await this.ports.store.assertApprovalValid(approvals[0]!.id, {
      now: new Date().toISOString(),
      currentPolicyDigest: context.compilerPolicy.policyDigest,
    });
    return context;
  }

  async apply(value: unknown): Promise<unknown> {
    const input = AmberMaterialRequestSchema.parse(value);
    const context = await this.access(input);
    const at = new Date().toISOString();
    const store = this.ports.store;
    if (input.action === "replan-preparation") {
      const provenance = await store.getMissionProvenance(input.missionId);
      const units = provenance.workUnits.filter((x) => x.planId === input.planId);
      if (
        units.length !== 1 ||
        !isSupported(units[0]!) ||
        provenance.approvals.some((x) => x.state === "pending")
      )
        throw new Error("Material replanning requires one closed phase and no pending approvals");
      let unit = units[0]!;
      const operation = provenance.operations.find(
        (x) => x.id === materialOperationIdentity(unit).operationId,
      );
      if (unit.state !== "succeeded") {
        if (
          !operation ||
          !["intent", "abandoned"].includes(operation.state) ||
          operation.receiptId ||
          !operation.budgetReservationId ||
          !["created", "ready", "claimed", "blocked", "cancel_requested", "cancelled"].includes(
            unit.state,
          )
        )
          throw new Error(
            "Only an unstarted material intent may be abandoned for a new exact plan",
          );
        if (operation.state === "intent")
          await store.transitionExternalOperation({
            operationId: operation.id,
            expectedRevision: operation.revision,
            to: "abandoned",
            at,
          });
        const budget = await store.getMissionBudget(input.missionId);
        if (
          budget.reservations.find((x) => x.id === operation.budgetReservationId)?.state !==
          "released"
        )
          await store.settleBudgetReservation({
            missionId: input.missionId,
            reservationId: operation.budgetReservationId,
            expectedBudgetRevision: budget.revision,
            state: "released",
            at,
          });
        if (!["cancel_requested", "cancelled"].includes(unit.state))
          unit = await store.transitionWorkUnit({
            workUnitId: unit.id,
            expectedRevision: unit.revision,
            to: "cancel_requested",
            claimOwner: unit.claimOwner ?? undefined,
            at,
          });
        if (unit.state !== "cancelled")
          await store.transitionWorkUnit({
            workUnitId: unit.id,
            expectedRevision: unit.revision,
            to: "cancelled",
            at,
          });
      } else if (
        !operation ||
        operation.state !== "confirmed" ||
        !provenance.receipts.some((x) => x.id === operation.receiptId && x.status === "confirmed")
      )
        throw new Error("Completed material phase lacks its real receipt");
      await this.ports.authority.assertCurrent(context);
      let mission = (await store.getMission(input.missionId))!;
      if (mission.activePlanId !== input.planId)
        throw new Error("Material phase is no longer active");
      if (mission.state === "awaiting_approval" || mission.state === "ready") {
        await this.resumeApprovedEffect(input, context, at);
        mission = (await store.getMission(input.missionId))!;
      }
      if (mission.state === "executing" || mission.state === "observing")
        mission = await store.transitionMission({
          missionId: mission.id,
          expectedRevision: mission.revision,
          to: "diagnosing",
          reason: "material_phase_review_before_exact_successor_plan",
          actor: context.authenticatedActor,
          at,
        });
      if (mission.state === "diagnosing" || mission.state === "paused")
        mission = await store.transitionMission({
          missionId: mission.id,
          expectedRevision: mission.revision,
          to: "replanning",
          reason: "separate_material_authority_phase_requested",
          actor: context.authenticatedActor,
          at,
        });
      if (mission.state !== "replanning")
        throw new Error("Material phase cannot replan from this state");
      return {
        missionId: mission.id,
        state: mission.state,
        priorWorkUnitId: unit.id,
        mdDispatched: false,
      };
    }
    if (input.action === "finish-preparation") {
      const provenance = await store.getMissionProvenance(input.missionId);
      const units = provenance.workUnits.filter((x) => isSupported(x) && x.state === "succeeded");
      if (
        units.length !== 3 ||
        units.some((x) => !isSupported(x) || x.state !== "succeeded") ||
        new Set(units.map((x) => x.executionPolicy.capability)).size !== 3
      )
        throw new Error(
          "Preparation phase requires all three exact successful material publications",
        );
      for (const unit of units) {
        const operation = provenance.operations.find(
          (x) => x.id === materialOperationIdentity(unit).operationId,
        );
        if (
          !operation ||
          operation.state !== "confirmed" ||
          !provenance.receipts.some((x) => x.id === operation.receiptId && x.status === "confirmed")
        )
          throw new Error("Preparation phase lacks its confirmed material receipt");
      }
      const build = units.find(
        (x) => x.executionPolicy.capability === "biomolecular.build-system",
      )!;
      const evidence = provenance.evidence.find((x) => x.id === `prepared-package-${build.id}`);
      if (!evidence || !evidence.immutable) throw new Error("Published prepared package absent");
      const bytes = await this.ports.artifacts.get(evidence.contentDigest);
      const packageValue = assertAmberPreparedSystemPackage(
        JSON.parse(new TextDecoder().decode(bytes.bytes)),
      );
      const manifest = await this.ports.mdStore.getSystemManifest(
        packageValue.systemManifest.id,
        packageValue.systemManifest.revision,
      );
      const map = await this.ports.mdStore.getAtomMap(
        input.missionId,
        packageValue.atomMap.id,
        packageValue.atomMap.revision,
      );
      if (
        !manifest ||
        manifest.manifestDigest !== packageValue.systemManifest.manifestDigest ||
        !map ||
        map.mapDigest !== packageValue.atomMap.mapDigest
      )
        throw new Error("Preparation phase has incomplete system/AtomMap projections");
      await this.ports.authority.assertCurrent(context);
      let mission = provenance.mission;
      if (mission.activePlanId !== input.planId)
        throw new Error("Preparation plan is no longer active");
      if (mission.state === "executing" || mission.state === "observing")
        mission = await store.transitionMission({
          missionId: mission.id,
          expectedRevision: mission.revision,
          to: "diagnosing",
          reason: "prepared_material_phase_completed_before_separate_md_plan",
          actor: context.authenticatedActor,
          at,
        });
      if (mission.state === "diagnosing")
        mission = await store.transitionMission({
          missionId: mission.id,
          expectedRevision: mission.revision,
          to: "replanning",
          reason: "prepared_material_verified_md_dispatch_not_yet_authorized_by_this_plan",
          actor: context.authenticatedActor,
          at,
        });
      if (mission.state !== "replanning")
        throw new Error("Material phase cannot close from this mission state");
      return {
        missionId: mission.id,
        status: "prepared",
        state: mission.state,
        packageDigest: packageValue.packageDigest,
        mdDispatched: false,
      };
    }
    if (input.action === "propose-decision") {
      const decision = assertBiomolecularDecisionDigest(input.decision);
      if (
        decision.missionId !== input.missionId ||
        decision.status !== "proposed" ||
        decision.decidedBy.id !== context.authenticatedActor.id ||
        decision.decidedBy.kind !== "human"
      )
        throw new Error("Decision must be proposed by the authenticated owner in this mission");
      await this.ports.mdStore.putBiomolecularDecision(decision);
      const approval = ApprovalRequestSchema.parse({
        id: `approval-material-decision-${digestCanonical({
          id: decision.id,
          revision: decision.revision,
          digest: decision.decisionDigest,
        }).slice(0, 32)}`,
        missionId: input.missionId,
        subjectType: "decision",
        subjectId: decision.id,
        subjectVersion: decision.revision,
        subjectRevision: decision.revision,
        payloadDigest: decision.decisionDigest,
        policyDigest: context.compilerPolicy.policyDigest,
        riskClass: 3,
        requestedFromRole: context.compilerPolicy.minimumApprovalRole,
        state: "pending",
        requestedAt: at,
        editableFields: [],
        requestedBy: context.authenticatedActor,
      });
      await this.ports.authority.assertCurrent(context);
      await this.awaitApproval(input, context, at);
      await store.createApprovalRequest(approval);
      return { decision, approval };
    }
    if (input.action === "approve") {
      const provenance = await store.getMissionProvenance(input.missionId);
      const approval = provenance.approvals.find((x) => x.id === input.approvalRequestId);
      if (
        !approval ||
        approval.subjectVersion !== input.subjectVersion ||
        approval.subjectRevision !== input.subjectRevision ||
        approval.payloadDigest !== input.payloadDigest ||
        approval.policyDigest !== input.policyDigest ||
        input.policyDigest !== context.compilerPolicy.policyDigest ||
        !context.authorizedRoles.includes(approval.requestedFromRole)
      )
        throw new Error("Exact current approval and authenticated reviewer role required");
      if (approval.subjectType === "decision") {
        const decision = await this.ports.mdStore.getBiomolecularDecision(
          approval.subjectId,
          approval.subjectRevision,
        );
        if (
          !decision ||
          decision.missionId !== input.missionId ||
          decision.decisionDigest !== input.payloadDigest
        )
          throw new Error("Decision approval is outside this material mission");
      } else if (approval.subjectType === "operation") {
        const operation = provenance.operations.find((x) => x.id === approval.subjectId);
        const unit = operation && provenance.workUnits.find((x) => x.id === operation.workUnitId);
        if (
          !operation ||
          !unit ||
          unit.planId !== input.planId ||
          operation.kind !== "system_preparation"
        )
          throw new Error("Operation approval is outside the exact material plan");
        assertMaterialPublicationRequest(unit, operation.request);
        for (const ref of unit.inputRefs) {
          const evidence = provenance.evidence.find((x) => x.id === ref);
          if (!evidence || !evidence.immutable)
            throw new Error("Approved material source evidence missing");
          await this.ports.artifacts.verify(evidence.contentDigest);
        }
      } else
        throw new Error(
          "This preparation facade only reviews exact material decisions or operations",
        );
      await this.ports.authority.assertCurrent(context);
      const actor = { ...context.authenticatedActor, role: approval.requestedFromRole };
      return store.respondToApproval(
        approval.id,
        ApprovalResponseSchema.parse({
          id: `response-material-${digestCanonical({ requestId: approval.id, actor: actor.id, at }).slice(0, 32)}`,
          approvalRequestId: approval.id,
          decision: input.decision,
          actor,
          role: actor.role,
          reason: input.reason,
          subjectVersion: input.subjectVersion,
          subjectRevision: input.subjectRevision,
          payloadDigest: input.payloadDigest,
          policyDigest: input.policyDigest,
          decidedAt: at,
        }),
        {
          now: at,
          currentPolicyDigest: context.compilerPolicy.policyDigest,
          authenticatedActor: actor,
          authorizedRoles: [...context.authorizedRoles],
        },
      );
    }
    if (input.action === "propose-work-unit") {
      const unit = input.workUnit;
      if (
        unit.missionId !== input.missionId ||
        unit.planId !== input.planId ||
        unit.state !== "created" ||
        unit.approvalPolicy.minimumRole !== context.compilerPolicy.minimumApprovalRole
      )
        throw new Error("Material WorkUnit is outside this approved mission plan");
      const request = assertMaterialPublicationRequest(unit, input.request);
      const provenance = await store.getMissionProvenance(input.missionId);
      const plan = provenance.plans.find((x) => x.id === input.planId);
      if (
        !plan ||
        ![...plan.protocol.engineAgnosticSteps, ...(plan.protocol.capabilitySteps ?? [])].some(
          (x) => canonicalJson(x) === canonicalJson(unit.protocolFragment),
        )
      )
        throw new Error("Material WorkUnit fragment is outside the exact approved plan");
      for (const ref of unit.inputRefs) {
        const evidence = provenance.evidence.find((x) => x.id === ref);
        if (!evidence || !evidence.immutable || evidence.missionId !== input.missionId)
          throw new Error("Material WorkUnit requires immutable same-mission CAS inputs");
        await this.ports.artifacts.verify(evidence.contentDigest);
      }
      if (!("missionId" in request))
        throw new Error("New material operations require v2 authority");
      const primary = provenance.evidence.find((x) => x.id === request.inputEvidenceId);
      if (!primary || primary.contentDigest !== request.inputContentDigest)
        throw new Error("Material coordinator input digest mismatch");
      await this.ports.authority.assertCurrent(context);
      if (!provenance.workUnits.some((x) => x.id === unit.id)) await store.createWorkUnits([unit]);
      let mission = await store.getMission(input.missionId);
      if (!mission) throw new Error("Material mission absent");
      if (mission.activePlanId !== input.planId && mission.state === "awaiting_approval")
        mission = await store.activatePlan({
          missionId: mission.id,
          planId: input.planId,
          expectedMissionRevision: mission.revision,
          actor: context.authenticatedActor,
          at,
        });
      if (mission.activePlanId !== input.planId)
        throw new Error("Material plan is no longer active");
      if (mission.state === "awaiting_approval")
        mission = await store.transitionMission({
          missionId: mission.id,
          expectedRevision: mission.revision,
          to: "ready",
          reason: "exact_approved_material_work_unit_compiled",
          actor: context.authenticatedActor,
          at,
        });
      if (mission.state === "ready")
        mission = await store.transitionMission({
          missionId: mission.id,
          expectedRevision: mission.revision,
          to: "executing",
          reason: "typed_material_publication_started",
          actor: context.authenticatedActor,
          at,
        });
      if (mission.state !== "executing") throw new Error("Material mission is not executable");
      let current = (await store.getWorkUnit(unit.id))!;
      if (current.state === "created")
        current = await store.transitionWorkUnit({
          workUnitId: unit.id,
          expectedRevision: current.revision,
          to: "ready",
          at,
        });
      if (current.state === "ready") {
        const claim = await store.claimWorkUnit({
          workUnitId: unit.id,
          ownerId,
          now: at,
          expiresAt: new Date(Date.parse(at) + 3_600_000).toISOString(),
          policyDigest: context.compilerPolicy.policyDigest,
        });
        if (!claim.claimed) throw new Error(claim.message);
        current = claim.workUnit;
      }
      if (current.state !== "claimed" || current.claimOwner !== ownerId)
        throw new Error("Material WorkUnit is owned by a different active execution");
      const identity = materialOperationIdentity(unit);
      let operation = await store.getExternalOperation(identity.operationId);
      if (!operation) {
        const budget = await store.getMissionBudget(input.missionId);
        await store.reserveBudget({
          missionId: input.missionId,
          expectedBudgetRevision: budget.revision,
          reservation: {
            id: identity.reservationId,
            workUnitId: unit.id,
            operationId: identity.operationId,
            kind: "external_operation",
            amount: 1,
            state: "reserved",
            createdAt: at,
            updatedAt: at,
          },
        });
        operation = ExternalOperationSchema.parse({
          id: identity.operationId,
          missionId: input.missionId,
          workUnitId: unit.id,
          idempotencyKey: identity.idempotencyKey,
          kind: "system_preparation",
          state: "intent",
          request,
          requestDigest: digestCanonical(request),
          policyDigest: context.compilerPolicy.policyDigest,
          budgetReservationId: identity.reservationId,
          revision: 1,
          createdAt: at,
          updatedAt: at,
        });
        await store.createOperationIntent(operation, { claimOwner: ownerId, now: at });
      } else if (operation.requestDigest !== digestCanonical(request))
        throw new Error("Material intent drift");
      const approval = ApprovalRequestSchema.parse({
        id: `approval-${identity.operationId}`,
        missionId: input.missionId,
        subjectType: "operation",
        subjectId: operation.id,
        subjectVersion: 1,
        subjectRevision: 1,
        payloadDigest: operation.requestDigest,
        policyDigest: context.compilerPolicy.policyDigest,
        riskClass: 3,
        requestedFromRole: context.compilerPolicy.minimumApprovalRole,
        state: "pending",
        requestedAt: operation.createdAt,
        editableFields: [],
        requestedBy: context.authenticatedActor,
      });
      await this.awaitApproval(input, context, at);
      await store.createApprovalRequest(approval);
      return { workUnit: current, operation, approval };
    }
    const unit = await store.getWorkUnit(input.workUnitId);
    if (
      !unit ||
      unit.missionId !== input.missionId ||
      unit.planId !== input.planId ||
      !isSupported(unit)
    )
      throw new Error(
        "Exact material WorkUnit required; molecular dynamics is not an allowed action",
      );
    await this.ports.authority.assertCurrent(context);
    const driver = new AmberMaterialPublicationDriver(
      this.ports,
      () => context.compilerPolicy.policyDigest,
      async () => {
        await this.access(input);
        await this.ports.authority.assertCurrent(context);
      },
    );
    if (unit.state === "claimed") {
      const identity = materialOperationIdentity(unit);
      await store.assertApprovalValid(`approval-${identity.operationId}`, {
        now: at,
        currentPolicyDigest: context.compilerPolicy.policyDigest,
      });
      await this.resumeApprovedEffect(input, context, at);
      return driver.executeClaimedWorkUnit(unit, { ownerId, claimOwner: ownerId, now: at });
    }
    const operation = await store.getExternalOperation(materialOperationIdentity(unit).operationId);
    if (!operation) throw new Error("Material operation not proposed");
    return driver.reconcileOperation(operation, { ownerId, now: at });
  }
}

/** Bounded source-material adoption, not a local MD engine or rerun of LEaP.
 * A confirmed receipt attests the bytes actually checked and published here. */
export class AmberMaterialPublicationDriver implements ScientificMissionWorkDriver {
  constructor(
    private readonly ports: Omit<Ports, "authority">,
    private readonly currentPolicy: () => string,
    private readonly beforeEffect?: () => Promise<void>,
  ) {}

  async executeClaimedWorkUnit(
    unit: WorkUnit,
    context: { ownerId: string; claimOwner: string; now: string; signal?: AbortSignal },
  ): Promise<MissionWorkExecution> {
    const identity = materialOperationIdentity(unit);
    const operation = await this.ports.store.getExternalOperation(identity.operationId);
    if (!operation || operation.state !== "intent")
      throw new Error("Exact proposed material intent required");
    const request = assertMaterialPublicationRequest(unit, operation.request);
    // Preflight verifies every byte before crossing the durable effect boundary.
    await this.preflight(unit, request);
    await this.beforeEffect?.();
    const effects = new ScientificEffectReconciliationStore(this.ports.database);
    const begun = await effects.beginWorkUnitEffect({
      operationId: operation.id,
      expectedOperationRevision: operation.revision,
      workUnitId: unit.id,
      expectedWorkUnitRevision: unit.revision,
      claimOwner: context.claimOwner,
      jobId: identity.jobId,
      attemptId: identity.attemptId,
      currentPolicyDigest: this.currentPolicy(),
      at: new Date().toISOString(),
    });
    await this.complete(begun.workUnit, begun.operation);
    return {
      status: "completed",
      workUnitId: unit.id,
      detail: "Frozen material verified and durably published; no MD executed",
    };
  }

  async reconcileOperation(
    operation: ExternalOperation,
    _context: { ownerId: string; now: string; signal?: AbortSignal },
  ): Promise<MissionOperationReconciliation> {
    const current = await this.ports.store.getExternalOperation(operation.id);
    const unit = current && (await this.ports.store.getWorkUnit(current.workUnitId));
    if (!current || !unit || !isSupported(unit)) throw new Error("Exact material effect absent");
    assertMaterialPublicationRequest(unit, current.request);
    if (current.state === "intent")
      return {
        status: "waiting",
        operationId: current.id,
        detail: "Material effect has not crossed admission",
      };
    if (!["effect_started", "acknowledged", "confirmed"].includes(current.state))
      throw new Error("Material effect cannot be safely reconciled from this state");
    await this.complete(unit, current);
    return {
      status: "reconciled",
      operationId: current.id,
      detail: "Exact immutable material publication recovered without rerunning chemistry or MD",
    };
  }

  private async json(digest: string): Promise<unknown> {
    const content = await this.ports.artifacts.get(digest);
    if (content.bytes.byteLength > 64 * 1024 ** 2)
      throw new Error("Material JSON exceeds its bounded contract");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content.bytes));
  }

  private async preflight(unit: WorkUnit, request: ReturnType<typeof effectRequest.parse>) {
    const provenance = await this.ports.store.getMissionProvenance(unit.missionId);
    const association = await this.ports.store.getMissionProjectAssociation(unit.missionId);
    if (
      !association ||
      provenance.mission.requestedBy.kind !== "human" ||
      provenance.mission.requestedBy.id !== association.ownerUserId
    )
      throw new Error(
        "Material publication requires its genuine human mission/project association",
      );
    await this.ports.store.assertProductionMissionPlanningAccess({
      missionId: unit.missionId,
      projectId: association.projectId,
      ownerUserId: association.ownerUserId,
    });
    for (const id of unit.inputRefs) {
      const evidence = provenance.evidence.find((x) => x.id === id);
      if (!evidence || !evidence.immutable || evidence.missionId !== unit.missionId)
        throw new Error("Material source evidence unavailable");
      await this.ports.artifacts.verify(evidence.contentDigest);
    }
    if (unit.executionPolicy.capability === "amber.force-field-stack") {
      const r = ForceFieldStackPublicationRequestSchema.parse(request);
      const raw = await this.json(r.stack.digest);
      const stack = assertForceFieldStackDigest({
        ...(raw as object),
        stackDigest: r.stack.digest,
      });
      if (stack.id !== r.stack.id || stack.revision !== r.stack.revision)
        throw new Error("Force-field revision drift");
      const sets = [
        stack.protein,
        stack.lipid,
        stack.water.parameterSet,
        stack.ions,
        ...stack.ligands.map((x) => x.parameterSet),
        ...stack.cofactors.map((x) => x.parameterSet),
      ];
      const expectedRefs = [
        ...new Set([
          ...sets.flatMap((x) => x.sourceEvidenceRefs),
          ...stack.compatibilityEvidenceRefs,
        ]),
      ].sort();
      if (canonicalJson(r.sourceEvidence.map((x) => x.id).sort()) !== canonicalJson(expectedRefs))
        throw new Error("Force-field sources differ from the exact frozen stack");
      for (const source of r.sourceEvidence) {
        const evidence = provenance.evidence.find((x) => x.id === source.id);
        if (
          !evidence ||
          !evidence.immutable ||
          evidence.missionId !== unit.missionId ||
          evidence.contentDigest !== source.contentDigest ||
          !evidence.mediaType
        )
          throw new Error("Force-field source revision/digest mismatch");
      }
      for (const set of sets)
        if (
          !set.sourceEvidenceRefs.some((id) =>
            r.sourceEvidence.some((x) => x.id === id && x.contentDigest === set.parameterDigest),
          )
        )
          throw new Error("Force-field parameter digest lacks its exact immutable source");
      await resolveLinkedLigandMaterialDigests({
        stack,
        evidenceDigests: new Map(r.sourceEvidence.map((x) => [x.id, x.contentDigest])),
        load: async (digest) => (await this.ports.artifacts.get(digest)).bytes,
        verifyEvidence: async (digest, sizeBytes) => {
          const evidence = provenance.evidence.find(
            (x) => x.contentDigest === digest && x.immutable && x.missionId === unit.missionId,
          );
          if (!evidence || evidence.sizeBytes !== sizeBytes)
            throw new Error("Linked force-field byte evidence missing");
          await this.ports.artifacts.verify(digest);
        },
      });
      return;
    }
    if (unit.executionPolicy.capability === "amber.topology-coordinate-validation") {
      const r = AtomMapPublicationRequestSchema.parse(request);
      const raw = await this.json(r.atomMap.digest);
      const map = assertAtomMapDigest({ ...(raw as object), mapDigest: r.atomMap.digest });
      if (
        map.id !== r.atomMap.id ||
        map.revision !== r.atomMap.revision ||
        map.systemManifestId !== r.systemManifest.id
      )
        throw new Error("AtomMap identity drift");
      const manifest = await this.ports.mdStore.getSystemManifest(
        r.systemManifest.id,
        r.systemManifest.revision,
      );
      const source = provenance.evidence.find((x) => x.id === r.sourceArtifact.evidenceRef);
      if (
        !manifest ||
        manifest.missionId !== unit.missionId ||
        manifest.manifestDigest !== r.systemManifest.digest ||
        !source ||
        source.contentDigest !== map.mapDigest ||
        source.kind !== "atom_map"
      )
        throw new Error("AtomMap lacks its exact published system/source artifact");
      return;
    }
    const r = BiomolecularSystemBuildRequestSchema.parse(request);
    if (!("inputContentDigest" in r)) throw new Error("System publication requires v2 authority");
    const draft = AmberFrozenSystemDraftSchema.parse(await this.json(r.inputContentDigest));
    if (
      draft.system.id !== r.systemManifest.id ||
      draft.system.revision !== r.systemManifest.revision ||
      draft.system.missionId !== unit.missionId ||
      canonicalJson(draft.system.forceFieldStack) !== canonicalJson(r.forceFieldStack) ||
      canonicalJson([...draft.system.decisionRefs].sort((a, b) => a.id.localeCompare(b.id))) !==
        canonicalJson(r.decisionRefs)
    )
      throw new Error("Frozen system draft differs from its exact operation authority");
    const packageValue = this.packageFor(unit, draft, {
      operationId: materialOperationIdentity(unit).operationId,
      receiptId: `receipt-${materialOperationIdentity(unit).operationId}`,
      at: unit.createdAt,
    });
    const files: Record<string, Uint8Array> = {};
    for (const binding of Object.values(packageValue.artifacts))
      files[binding.fileName] = (await this.ports.artifacts.get(binding.sha256)).bytes;
    assertPreparedSystemFileBytes(packageValue, files);
  }

  private packageFor(
    unit: WorkUnit,
    draft: z.infer<typeof AmberFrozenSystemDraftSchema>,
    publication: { operationId: string; receiptId: string; at: string },
  ) {
    const manifestBase = {
      ...draft.system,
      schemaVersion: "eigengrid.biomolecular-system-manifest/v2",
      provenance: {
        operationId: publication.operationId,
        operationReceiptId: publication.receiptId,
        builder: { name: "eigengrid-frozen-amber-material-adoption", version: "1.0.0" },
        createdBy: { id: ownerId, kind: "service", role: "scientific-mission-owner" },
        createdAt: publication.at,
      },
    };
    const systemManifest = {
      ...manifestBase,
      manifestDigest: computeBiomolecularSystemManifestDigest(manifestBase),
    };
    const material = {
      schemaVersion: "eigengrid.amber-prepared-system-package/v1",
      missionId: unit.missionId,
      workUnitId: unit.id,
      systemManifest,
      atomMap: draft.atomMap,
      forceFieldStack: draft.forceFieldStack,
      parameterDigests: draft.parameterDigests,
      artifacts: draft.artifacts,
      qc: draft.qc,
    };
    return assertAmberPreparedSystemPackage({
      ...material,
      packageDigest: digestCanonical(material),
    });
  }

  private async complete(unit: WorkUnit, operation: ExternalOperation): Promise<void> {
    const request = assertMaterialPublicationRequest(unit, operation.request);
    await this.preflight(unit, request);
    const identity = materialOperationIdentity(unit);
    const store = this.ports.store;
    let current = operation;
    const externalIdentity = {
      publisher: "eigengrid-frozen-amber-material-adoption/v1",
      requestDigest: operation.requestDigest,
    };
    if (current.state === "effect_started")
      current = await store.transitionExternalOperation({
        operationId: current.id,
        expectedRevision: current.revision,
        to: "acknowledged",
        externalIdentity,
        at: new Date().toISOString(),
      });
    const receiptId = `receipt-${operation.id}`;
    if (current.state === "acknowledged") {
      const receipt = OperationReceiptSchema.parse({
        id: receiptId,
        operationId: current.id,
        requestDigest: current.requestDigest,
        status: "confirmed",
        externalIdentity,
        jobId: identity.jobId,
        attemptId: identity.attemptId,
        detailDigest: digestCanonical({
          request,
          verifiedInputs: unit.inputRefs,
          publisher: "eigengrid-frozen-amber-material-adoption/v1",
        }),
        recordedAt: new Date().toISOString(),
      });
      await store.finalizeOperationReceipt(current.id, current.revision, receipt);
      current = (await store.getExternalOperation(current.id))!;
    }
    if (current.state !== "confirmed" || current.receiptId !== receiptId)
      throw new Error("Material publication lacks its actual confirmed receipt");
    const provenance = await store.getMissionProvenance(unit.missionId);
    const receipt = provenance.receipts.find((x) => x.id === receiptId);
    if (!receipt) throw new Error("Confirmed material receipt is unavailable");
    const at = receipt.recordedAt;
    const authority = {
      missionId: unit.missionId,
      operationId: current.id,
      operationReceiptId: receipt.id,
    };
    const publishEvidence = async (id: string, kind: string, digest: string, mediaType: string) => {
      const bytes = await this.ports.artifacts.get(digest);
      await store.createEvidence(
        EvidenceReferenceSchema.parse({
          id,
          missionId: unit.missionId,
          workUnitId: unit.id,
          kind,
          uri: bytes.uri,
          contentDigest: digest,
          sizeBytes: bytes.sizeBytes,
          mediaType,
          immutable: true,
          sourceId: receipt.id,
          createdAt: at,
        }),
      );
    };
    let packageValue: ReturnType<typeof assertAmberPreparedSystemPackage> | undefined;
    if (unit.executionPolicy.capability === "amber.force-field-stack") {
      const r = ForceFieldStackPublicationRequestSchema.parse(request);
      const stack = assertForceFieldStackDigest({
        ...((await this.json(r.stack.digest)) as object),
        stackDigest: r.stack.digest,
      });
      await publishEvidence(
        r.outputArtifact.evidenceRef,
        "force_field_stack",
        stack.stackDigest,
        r.outputArtifact.mediaType,
      );
      await this.ports.mdStore.putForceFieldStack(stack, authority);
    } else if (unit.executionPolicy.capability === "amber.topology-coordinate-validation") {
      const r = AtomMapPublicationRequestSchema.parse(request);
      const map = assertAtomMapDigest({
        ...((await this.json(r.atomMap.digest)) as object),
        mapDigest: r.atomMap.digest,
      });
      await this.ports.mdStore.putAtomMap(map, authority);
      const manifest = await this.ports.mdStore.getSystemManifest(
        r.systemManifest.id,
        r.systemManifest.revision,
      );
      const provenance = await store.getMissionProvenance(unit.missionId);
      const build =
        manifest &&
        provenance.operations.find(
          (x) => x.id === manifest.provenance.operationId && x.state === "confirmed",
        );
      const source =
        build &&
        provenance.evidence.find(
          (x) =>
            x.id === `prepared-package-${build.workUnitId}` &&
            x.immutable &&
            x.missionId === unit.missionId &&
            x.sourceId === build.receiptId,
        );
      if (!manifest || !source)
        throw new Error("AtomMap validation requires its actually published prepared package");
      packageValue = assertAtomMapPackageMaterial(
        await this.json(source.contentDigest),
        manifest,
        map,
      );
      const files: Record<string, Uint8Array> = {};
      for (const binding of Object.values(packageValue.artifacts))
        files[binding.fileName] = (await this.ports.artifacts.get(binding.sha256)).bytes;
      assertPreparedSystemFileBytes(packageValue, files);
    } else {
      const r = BiomolecularSystemBuildRequestSchema.parse(request);
      if (!("inputContentDigest" in r)) throw new Error("v2 build authority required");
      const draft = AmberFrozenSystemDraftSchema.parse(await this.json(r.inputContentDigest));
      packageValue = this.packageFor(unit, draft, {
        operationId: current.id,
        receiptId: receipt.id,
        at,
      });
      for (const [role, binding] of Object.entries(packageValue.artifacts)) {
        const kind =
          role === "topology"
            ? "topology"
            : role === "coordinates"
              ? "coordinates"
              : role === "atomMap"
                ? "atom_map"
                : role === "snapshotPdb"
                  ? "source_snapshot"
                  : "parser_output";
        await publishEvidence(binding.evidenceRef, kind, binding.sha256, binding.mediaType);
      }
      await this.ports.mdStore.putSystemManifest(packageValue.systemManifest);
      const packageBytes = await this.ports.artifacts.put(
        new TextEncoder().encode(canonicalJson(packageValue)),
      );
      await publishEvidence(
        `prepared-package-${unit.id}`,
        "artifact",
        packageBytes.digest,
        "application/vnd.eigengrid.amber-prepared-system-package+json",
      );
    }
    const priorObservations =
      unit.executionPolicy.capability === "amber.topology-coordinate-validation"
        ? (await store.getMissionProvenance(unit.missionId)).observations
        : [];
    for (const type of unit.outputContract.requiredObservationKinds) {
      if (type !== "artifact_integrity" && type !== "topology_integrity")
        throw new Error("Unsupported material observation kind");
      const payload = packageValue
        ? {
            schemaVersion: "eigengrid.amber-prepared-system-qc-observation/v1",
            packageDigest: packageValue.packageDigest,
            qcReportDigest: packageValue.artifacts.qcReport.sha256,
            topologyDigest: packageValue.qc.topologyDigest,
            coordinatesDigest: packageValue.qc.coordinatesDigest,
            atomMapDigest: packageValue.qc.atomMapDigest,
            forceFieldStackDigest: packageValue.qc.forceFieldStackDigest,
            validatorId: packageValue.qc.validatorId,
            validatorVersion: packageValue.qc.validatorVersion,
            status: "passed",
          }
        : { status: "passed", requestDigest: current.requestDigest };
      const preparedMapQc =
        unit.executionPolicy.capability === "amber.topology-coordinate-validation" && packageValue;
      const observationId = preparedMapQc
        ? `observation-${unit.id}-${type}-prepared-${packageValue!.packageDigest.slice(0, 16)}`
        : `observation-${unit.id}-${type}`;
      if (priorObservations.some((x) => x.id === observationId)) continue;
      await store.createObservation(
        ScientificObservationSchema.parse({
          id: observationId,
          missionId: unit.missionId,
          workUnitId: unit.id,
          type,
          payload,
          source: {
            kind: "validator",
            id: packageValue?.qc.validatorId ?? "eigengrid-frozen-amber-material-adoption@1.0.0",
          },
          evidenceRefs: packageValue
            ? Object.values(packageValue.artifacts).map((x) => x.evidenceRef)
            : unit.executionPolicy.capability === "amber.force-field-stack"
              ? [ForceFieldStackPublicationRequestSchema.parse(request).outputArtifact.evidenceRef]
              : unit.inputRefs,
          qualityFlags: packageValue ? [] : ["frozen-material-adoption-no-md"],
          observedAt: preparedMapQc ? new Date().toISOString() : at,
        }),
      );
    }
    const effects = new ScientificEffectReconciliationStore(this.ports.database);
    await effects.reconcileWorkUnitEffect({
      operationId: current.id,
      workUnitId: unit.id,
      jobId: identity.jobId,
      attemptId: identity.attemptId,
      outcome: "completed",
      at: new Date().toISOString(),
    });
    const latest = (await store.getWorkUnit(unit.id))!;
    if (latest.state === "observing")
      await store.transitionWorkUnit({
        workUnitId: latest.id,
        expectedRevision: latest.revision,
        to: "succeeded",
        claimOwner: unit.claimOwner ?? undefined,
        at: new Date().toISOString(),
      });
  }
}
