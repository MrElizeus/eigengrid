/** Bind compiled work units to exact approved material and protocol projections. */
import {
  BiomolecularMaterialPublicationBindingSchema,
  BiomolecularSystemBuildWorkUnitParametersSchema,
  EvidenceReferenceSchema,
  MdExecutionBindingParametersSchema,
  ReplicaSetSchema,
  ScientificPlanSchema,
  assertBiomolecularDecisionDigest,
  assertForceFieldStackDigest,
  assertMdStageSpecDigest,
  assertMdWorkflowProtocolDigest,
  assertPublishedBiomolecularSystemManifestDigest,
  canonicalJson,
  resolveMdReplicaSegmentSeed,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import { ScientificEntityNotFoundError, ScientificIntegrityError } from "./errors";
import {
  assertAnExactApprovalExists,
  assertBiomolecularMaterialPublicationWorkUnit,
  assertExactApprovedSubject,
  resolveDecisionRequirements,
} from "./md-store-authority";
import { JsonRow, one, parseJson } from "./md-store-queries";
import {
  assertCanonicalSetEqual,
  computeMdReplicaSetPayloadDigest,
  mdEvidenceKindByArtifactRole,
} from "./md-store-validation";
import type { ScientificTransaction } from "./types";

/**
 * Authorizes a generic scientific-capability WorkUnit against the exact MD
 * projections. The legacy QC plan fragment is deliberately not treated as an
 * MD protocol owner: the approved MdWorkflowProtocol and its embedded stage are.
 */
export async function assertMdWorkUnitProjectionBinding(
  tx: ScientificTransaction,
  workUnit: WorkUnit,
): Promise<void> {
  if (
    workUnit.kind !== "scientific_capability" ||
    workUnit.protocolFragment.kind !== "scientific_capability"
  ) {
    throw new ScientificIntegrityError("MD projection binding requires a capability WorkUnit", {
      workUnitId: workUnit.id,
    });
  }
  if (workUnit.protocolFragment.capability.id === "biomolecular.build-system") {
    await assertSystemBuildWorkUnitProjection(tx, workUnit);
    return;
  }
  const materialBinding = BiomolecularMaterialPublicationBindingSchema.safeParse(
    workUnit.protocolFragment.parameters,
  );
  if (materialBinding.success) {
    await assertBiomolecularMaterialPublicationWorkUnit(tx, workUnit, materialBinding.data);
    return;
  }
  const binding = MdExecutionBindingParametersSchema.parse(workUnit.protocolFragment.parameters);
  const plan = await one<{
    mission_id: string;
    version: number;
    revision: number;
    status: string;
    plan_digest: string;
  }>(
    tx,
    `SELECT mission_id, version, revision, status, plan_digest
     FROM scientific_plans WHERE id = $1`,
    [binding.plan.id],
  );
  if (
    !plan ||
    workUnit.missionId !== String(plan.mission_id) ||
    workUnit.planId !== binding.plan.id ||
    workUnit.planVersion !== binding.plan.version ||
    Number(plan.version) !== binding.plan.version ||
    Number(plan.revision) !== binding.plan.revision ||
    String(plan.status) !== "approved" ||
    String(plan.plan_digest) !== binding.plan.digest
  ) {
    throw new ScientificIntegrityError("Capability WorkUnit plan binding is stale", {
      workUnitId: workUnit.id,
    });
  }
  await assertExactApprovedSubject(tx, {
    approvalRef: binding.plan.approvalRef,
    missionId: workUnit.missionId,
    subjectType: "plan",
    subjectId: binding.plan.id,
    subjectVersion: binding.plan.version,
    subjectRevision: binding.plan.revision,
    digest: binding.plan.digest,
  });

  const systemRow = await one<JsonRow & { mission_id: string; manifest_digest: string }>(
    tx,
    `SELECT mission_id, manifest_digest, payload_json
     FROM scientific_biomolecular_system_manifests WHERE id = $1 AND revision = $2`,
    [binding.system.id, binding.system.revision],
  );
  if (!systemRow) {
    throw new ScientificEntityNotFoundError("biomolecular system manifest", binding.system.id);
  }
  const system = assertPublishedBiomolecularSystemManifestDigest(
    parseJson(systemRow, "capability system manifest"),
  );
  if (
    system.missionId !== workUnit.missionId ||
    String(systemRow.mission_id) !== workUnit.missionId ||
    system.id !== binding.system.id ||
    system.revision !== binding.system.revision ||
    system.manifestDigest !== binding.system.digest ||
    String(systemRow.manifest_digest) !== binding.system.digest
  ) {
    throw new ScientificIntegrityError("Capability WorkUnit system binding is stale", {
      workUnitId: workUnit.id,
    });
  }
  await assertExactApprovedSubject(tx, {
    approvalRef: binding.system.approvalRef,
    missionId: workUnit.missionId,
    subjectType: "biomolecular_system_manifest",
    subjectId: binding.system.id,
    subjectVersion: binding.system.revision,
    subjectRevision: binding.system.revision,
    digest: binding.system.digest,
  });

  const protocolRow = await one<
    JsonRow & {
      mission_id: string;
      plan_id: string;
      plan_version: number;
      protocol_digest: string;
      review_status: string;
    }
  >(
    tx,
    `SELECT mission_id, plan_id, plan_version, protocol_digest, review_status, payload_json
     FROM scientific_md_protocols WHERE id = $1 AND revision = $2`,
    [binding.protocol.id, binding.protocol.revision],
  );
  if (!protocolRow) {
    throw new ScientificEntityNotFoundError("MD protocol", binding.protocol.id);
  }
  const protocol = assertMdWorkflowProtocolDigest(parseJson(protocolRow, "capability MD protocol"));
  if (
    protocol.missionId !== workUnit.missionId ||
    String(protocolRow.mission_id) !== workUnit.missionId ||
    String(protocolRow.plan_id) !== binding.plan.id ||
    Number(protocolRow.plan_version) !== binding.plan.version ||
    protocol.id !== binding.protocol.id ||
    protocol.revision !== binding.protocol.revision ||
    protocol.protocolDigest !== binding.protocol.digest ||
    String(protocolRow.protocol_digest) !== binding.protocol.digest ||
    protocol.status !== "approved" ||
    String(protocolRow.review_status) !== "approved" ||
    protocol.approvedByRef !== binding.protocol.approvalRef ||
    protocol.system.id !== system.id ||
    protocol.system.revision !== system.revision ||
    protocol.system.manifestDigest !== system.manifestDigest
  ) {
    throw new ScientificIntegrityError("Capability WorkUnit protocol binding is stale", {
      workUnitId: workUnit.id,
    });
  }
  await assertExactApprovedSubject(tx, {
    approvalRef: binding.protocol.approvalRef,
    missionId: workUnit.missionId,
    subjectType: "md_protocol",
    subjectId: binding.protocol.id,
    subjectVersion: binding.protocol.revision,
    subjectRevision: binding.protocol.revision,
    digest: binding.protocol.digest,
  });

  const stageRow = await one<JsonRow & { stage_digest: string }>(
    tx,
    `SELECT stage_digest, payload_json FROM scientific_md_stage_specs
     WHERE id = $1 AND revision = $2 AND protocol_id = $3 AND protocol_revision = $4`,
    [binding.stage.id, binding.stage.revision, binding.protocol.id, binding.protocol.revision],
  );
  if (!stageRow) throw new ScientificEntityNotFoundError("MD stage", binding.stage.id);
  const stage = assertMdStageSpecDigest(parseJson(stageRow, "capability MD stage"));
  const embeddedStage = protocol.stages.find(
    (candidate) =>
      candidate.id === binding.stage.id && candidate.revision === binding.stage.revision,
  );
  if (
    !embeddedStage ||
    embeddedStage.stageDigest !== binding.stage.digest ||
    stage.stageDigest !== binding.stage.digest ||
    String(stageRow.stage_digest) !== binding.stage.digest ||
    stage.sequence !== binding.stage.sequence ||
    stage.kind !== binding.stage.kind ||
    stage.system.id !== system.id ||
    stage.system.revision !== system.revision ||
    stage.system.manifestDigest !== system.manifestDigest
  ) {
    throw new ScientificIntegrityError("Capability WorkUnit stage binding is stale", {
      workUnitId: workUnit.id,
    });
  }

  const capability = workUnit.protocolFragment.capability;
  const declaredCapability = protocol.capabilityRefs.some(
    (candidate) => canonicalJson(candidate) === canonicalJson(capability),
  );
  if (
    !declaredCapability ||
    workUnit.executionPolicy.capability !== capability.id ||
    workUnit.executionPolicy.riskClass !== workUnit.protocolFragment.riskClass
  ) {
    throw new ScientificIntegrityError(
      "Capability WorkUnit is outside the protocol capability contract",
      { workUnitId: workUnit.id, capabilityId: capability.id },
    );
  }

  const requiredDecisionIds = new Set([...protocol.decisionRefs, ...stage.sourceDecisionRefs]);
  const expectedDecisions = system.decisionRefs.filter((decision) =>
    requiredDecisionIds.has(decision.id),
  );
  if (expectedDecisions.length !== requiredDecisionIds.size) {
    throw new ScientificIntegrityError(
      "MD stage decisions are absent from the approved system manifest",
      { workUnitId: workUnit.id },
    );
  }
  assertCanonicalSetEqual(
    "Capability WorkUnit decision binding",
    binding.decisions,
    expectedDecisions,
  );
  const resolvedDecisions = await resolveDecisionRequirements(
    tx,
    workUnit.missionId,
    binding.decisions.map((decision) => decision.id),
  );
  assertCanonicalSetEqual(
    "Capability WorkUnit durable decision approvals",
    resolvedDecisions,
    binding.decisions.map((decision) => ({
      id: decision.id,
      revision: decision.revision,
      digest: decision.decisionDigest,
      approvalRef: decision.approvalRef,
    })),
  );

  assertCanonicalSetEqual(
    "Capability WorkUnit source fragments",
    workUnit.skillRefs,
    workUnit.protocolFragment.sourceFragments,
  );
  const protocolSkillIdentities = new Set(
    protocol.skillRefs.map((skill) =>
      canonicalJson({
        skillId: skill.skillId,
        version: skill.version,
        contentDigest: skill.contentDigest,
      }),
    ),
  );
  for (const skill of workUnit.skillRefs) {
    if (
      !protocolSkillIdentities.has(
        canonicalJson({
          skillId: skill.skillId,
          version: skill.version,
          contentDigest: skill.contentDigest,
        }),
      )
    ) {
      throw new ScientificIntegrityError("Capability WorkUnit cites a skill outside its protocol", {
        workUnitId: workUnit.id,
        skillId: skill.skillId,
      });
    }
  }

  const expectedEvidenceKinds = stage.outputs
    .filter((output) => output.required)
    .map((output) => mdEvidenceKindByArtifactRole[output.role]);
  const expectedObservationKinds = ["artifact_integrity", "stage_completion"];
  if (stage.sequence > 1) expectedObservationKinds.push("restart_continuity");
  if (stage.kind !== "minimization") expectedObservationKinds.push("temperature");
  if (stage.kind === "equilibration" || stage.kind === "production") {
    expectedObservationKinds.push("density", "volume");
  }
  assertCanonicalSetEqual(
    "Capability WorkUnit evidence output contract",
    workUnit.outputContract.requiredEvidenceKinds,
    expectedEvidenceKinds,
  );
  assertCanonicalSetEqual(
    "Capability WorkUnit observation output contract",
    workUnit.outputContract.requiredObservationKinds,
    expectedObservationKinds,
  );

  if (stage.kind === "production") {
    const segment = binding.replicaSegment!;
    const replicaRow = await one<JsonRow & { mission_id: string; payload_digest: string }>(
      tx,
      `SELECT mission_id, payload_digest, payload_json
       FROM scientific_md_replica_set_revisions WHERE id = $1 AND revision = $2`,
      [segment.replicaSetId, segment.replicaSetRevision],
    );
    if (!replicaRow) {
      throw new ScientificEntityNotFoundError("MD replica set", segment.replicaSetId);
    }
    const replicaSet = ReplicaSetSchema.parse(parseJson(replicaRow, "capability replica set"));
    const replicaSetDigest = computeMdReplicaSetPayloadDigest(replicaSet);
    const replica = replicaSet.replicas.find((candidate) => candidate.id === segment.replicaId);
    if (
      String(replicaRow.mission_id) !== workUnit.missionId ||
      replicaSetDigest !== segment.replicaSetDigest ||
      String(replicaRow.payload_digest) !== segment.replicaSetDigest ||
      replicaSet.protocolId !== protocol.id ||
      replicaSet.protocolRevision !== protocol.revision ||
      replicaSet.protocolDigest !== protocol.protocolDigest ||
      replicaSet.systemManifestDigest !== system.manifestDigest ||
      !replica ||
      replica.index !== segment.replicaIndex ||
      replica.seed !== segment.replicaSeed
    ) {
      throw new ScientificIntegrityError("Capability production replica binding is stale", {
        workUnitId: workUnit.id,
      });
    }
    if (
      segment.segmentSeed !==
      resolveMdReplicaSegmentSeed(stage, replicaSet, replica.id, segment.segmentIndex)
    ) {
      throw new ScientificIntegrityError(
        "Capability production segment seed is outside its approved schedule",
        {
          workUnitId: workUnit.id,
        },
      );
    }
    await assertAnExactApprovalExists(tx, {
      missionId: workUnit.missionId,
      subjectType: "replica_set",
      subjectId: replicaSet.id,
      subjectVersion: replicaSet.revision,
      subjectRevision: replicaSet.revision,
      digest: replicaSetDigest,
    });
  }
}

/** A build precedes the published system/MD protocol. Its independent authority
 * is the approved construct/microstates, exact stack publication and CAS inputs;
 * it cannot be parsed as a stage of the system it has not published yet. */
export async function assertSystemBuildWorkUnitProjection(
  tx: ScientificTransaction,
  workUnit: WorkUnit,
): Promise<void> {
  if (
    workUnit.protocolFragment.kind !== "scientific_capability" ||
    workUnit.protocolFragment.capability.id !== "biomolecular.build-system" ||
    workUnit.protocolFragment.capability.version !== "1.0.0" ||
    workUnit.executionPolicy.capability !== "biomolecular.build-system" ||
    workUnit.executionPolicy.riskClass !== 3 ||
    workUnit.protocolFragment.riskClass !== 3 ||
    !workUnit.approvalPolicy.required
  )
    throw new ScientificIntegrityError("System-build WorkUnit capability/risk contract is unsafe");
  const parameters = BiomolecularSystemBuildWorkUnitParametersSchema.parse(
    workUnit.protocolFragment.parameters,
  );
  const binding = parameters.systemBuild;
  assertCanonicalSetEqual("System-build immutable inputs", workUnit.inputRefs, [
    ...binding.sourceEvidenceRefs,
    binding.forceFieldStackEvidenceRef,
  ]);
  for (const kind of ["topology", "coordinates", "atom_map"])
    if (!workUnit.outputContract.requiredEvidenceKinds.includes(kind))
      throw new ScientificIntegrityError("System-build material output contract is incomplete");
  assertCanonicalSetEqual(
    "System-build QC observations",
    workUnit.outputContract.requiredObservationKinds,
    ["artifact_integrity", "topology_integrity"],
  );
  const planRow = await one<JsonRow>(
    tx,
    "SELECT payload_json FROM scientific_plans WHERE id = $1",
    [workUnit.planId],
  );
  if (!planRow) throw new ScientificEntityNotFoundError("system-build plan", workUnit.planId);
  const plan = ScientificPlanSchema.parse(parseJson(planRow, "system-build plan"));
  if (
    plan.missionId !== workUnit.missionId ||
    plan.version !== workUnit.planVersion ||
    plan.status !== "approved"
  )
    throw new ScientificIntegrityError("System-build requires the exact approved plan");
  await assertAnExactApprovalExists(tx, {
    missionId: workUnit.missionId,
    subjectType: "plan",
    subjectId: plan.id,
    subjectVersion: plan.version,
    subjectRevision: plan.revision,
    digest: plan.planDigest,
  });
  for (const id of workUnit.inputRefs) {
    const row = await one<JsonRow>(
      tx,
      "SELECT payload_json FROM scientific_evidence WHERE id = $1",
      [id],
    );
    if (!row) throw new ScientificEntityNotFoundError("system-build source", id);
    const evidence = EvidenceReferenceSchema.parse(parseJson(row, "system-build evidence"));
    if (
      !evidence.immutable ||
      evidence.missionId !== workUnit.missionId ||
      evidence.uri !== `cas://sha256/${evidence.contentDigest}` ||
      (id === binding.forceFieldStackEvidenceRef &&
        (evidence.kind !== "force_field_stack" ||
          evidence.contentDigest !== binding.forceFieldStack.digest))
    )
      throw new ScientificIntegrityError(
        "System-build source is not its exact same-mission CAS evidence",
      );
  }
  for (const ref of binding.decisionRefs) {
    const row = await one<JsonRow>(
      tx,
      "SELECT payload_json FROM scientific_biomolecular_decisions WHERE id = $1 AND revision = $2",
      [ref.id, ref.revision],
    );
    if (!row) throw new ScientificEntityNotFoundError("system-build decision", ref.id);
    const decision = assertBiomolecularDecisionDigest(parseJson(row, "system-build decision"));
    if (
      decision.missionId !== workUnit.missionId ||
      decision.status !== "approved" ||
      decision.kind !== ref.kind ||
      decision.decisionDigest !== ref.decisionDigest ||
      decision.approvalRef !== ref.approvalRef
    )
      throw new ScientificIntegrityError(
        "System-build decision is not its exact approved revision",
      );
    await assertExactApprovedSubject(tx, {
      approvalRef: ref.approvalRef,
      missionId: workUnit.missionId,
      subjectType: "decision",
      subjectId: ref.id,
      subjectVersion: ref.revision,
      subjectRevision: ref.revision,
      digest: ref.decisionDigest,
    });
  }
  const stackRow = await one<
    JsonRow & { mission_id: string; stack_digest: string; artifact_evidence_id: string }
  >(
    tx,
    "SELECT mission_id, stack_digest, artifact_evidence_id, payload_json FROM scientific_force_field_stack_revisions WHERE id = $1 AND revision = $2",
    [binding.forceFieldStack.id, binding.forceFieldStack.revision],
  );
  if (!stackRow)
    throw new ScientificEntityNotFoundError(
      "system-build force-field stack",
      binding.forceFieldStack.id,
    );
  const stack = assertForceFieldStackDigest(parseJson(stackRow, "system-build force-field stack"));
  if (
    String(stackRow.mission_id) !== workUnit.missionId ||
    stack.stackDigest !== binding.forceFieldStack.digest ||
    String(stackRow.stack_digest) !== stack.stackDigest ||
    String(stackRow.artifact_evidence_id) !== binding.forceFieldStackEvidenceRef
  )
    throw new ScientificIntegrityError("System-build force-field publication binding is stale");
}

/** This is only the phase/ownership relation. The caller must first validate
 * the exact durable material-effect dependency via the projection gate. */
export function isCompletedMaterialPhaseDependency(
  workUnit: WorkUnit,
  dependency: WorkUnit,
  plan: ReturnType<typeof ScientificPlanSchema.parse>,
): boolean {
  if (
    workUnit.protocolFragment.kind !== "scientific_capability" ||
    dependency.protocolFragment.kind !== "scientific_capability"
  )
    return false;
  const expected =
    workUnit.executionPolicy.capability === "biomolecular.build-system"
      ? "amber.force-field-stack"
      : workUnit.executionPolicy.capability === "amber.topology-coordinate-validation"
        ? "biomolecular.build-system"
        : undefined;
  return (
    expected !== undefined &&
    dependency.executionPolicy.capability === expected &&
    workUnit.protocolFragment.capability.id === workUnit.executionPolicy.capability &&
    dependency.protocolFragment.capability.id === dependency.executionPolicy.capability &&
    workUnit.executionPolicy.riskClass === 3 &&
    dependency.executionPolicy.riskClass === 3 &&
    workUnit.approvalPolicy.required &&
    dependency.approvalPolicy.required &&
    dependency.state === "succeeded" &&
    workUnit.missionId === dependency.missionId &&
    plan.missionId === workUnit.missionId &&
    plan.id === workUnit.planId &&
    plan.version === workUnit.planVersion &&
    plan.status === "approved" &&
    plan.parentPlanId === dependency.planId &&
    dependency.planVersion + 1 === workUnit.planVersion &&
    workUnit.dependencies.length === 1 &&
    workUnit.dependencies[0] === dependency.id
  );
}
