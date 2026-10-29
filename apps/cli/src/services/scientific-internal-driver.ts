import {
  ScientificAssessmentSchema,
  ScientificObservationSchema,
  ValidationResultSchema,
  digestCanonical,
  type AcceptanceCriterion,
  type ActorIdentity,
  type EvidenceReference,
  type ScientificMission,
  type ScientificObservation,
  type ValidationResult,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import {
  ScientificStore,
  workUnitUsesMdExecutionBinding,
  type MissionOperationReconciliation,
  type MissionWorkExecution,
  type ScientificInternalWorkUnitPersistence,
  type ScientificMissionWorkDriver,
} from "@eigengrid/mission-runtime";
import type { ExternalOperation } from "@eigengrid/scientific-schema";

export interface ScientificInternalDriverOptions {
  store: ScientificStore;
  persistence: ScientificInternalWorkUnitPersistence;
  externalDriver: ScientificMissionWorkDriver;
  /** Separate closed route for approved Amber system-build effects. It is never
   * inferred from the generic execution service or local runner. */
  systemPreparationDriver?: Pick<
    ScientificMissionWorkDriver,
    "executeClaimedWorkUnit" | "reconcileOperation"
  >;
  actor?: ActorIdentity;
}

const defaultActor: ActorIdentity = {
  id: "eigengrid-scientific-internal-runtime",
  kind: "service",
  role: "scientific-mission-owner",
  displayName: "EigenGrid Scientific Internal Runtime",
};

function preparationCapability(workUnit: WorkUnit): boolean {
  return (
    workUnit.kind === "scientific_capability" &&
    workUnit.protocolFragment.kind === "scientific_capability" &&
    [
      "biomolecular.build-system",
      "amber.force-field-stack",
      "amber.topology-coordinate-validation",
    ].includes(workUnit.protocolFragment.capability.id) &&
    workUnit.executionPolicy.capability === workUnit.protocolFragment.capability.id
  );
}

function payloadBoolean(observation: ScientificObservation): boolean | undefined {
  const value = observation.payload.value;
  return typeof value === "boolean" ? value : undefined;
}

function payloadCount(observation: ScientificObservation): number | undefined {
  const value = observation.payload.count;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function evaluationTimestamp(
  workUnit: WorkUnit,
  observations: readonly ScientificObservation[],
): string {
  return (
    [...observations]
      .map((observation) => observation.observedAt)
      .sort()
      .at(-1) ?? workUnit.createdAt
  );
}

function criterionObservationType(
  criterion: AcceptanceCriterion,
): ScientificObservation["type"] | undefined {
  switch (criterion.kind) {
    case "normal_termination":
      return "normal_termination";
    case "electronic_convergence":
      return "electronic_convergence";
    case "geometry_convergence":
      return "geometry_convergence";
    case "minimum_frequency":
    case "transition_state":
      return "imaginary_frequencies";
    case "uncertainty":
    case "custom":
      return undefined;
  }
}

function evaluateCriterion(
  criterion: AcceptanceCriterion,
  observations: readonly ScientificObservation[],
): {
  status: ValidationResult["status"];
  message: string;
  observationRefs: string[];
  evidenceRefs: string[];
} {
  const expectedType = criterionObservationType(criterion);
  if (!expectedType) {
    return {
      status: "inconclusive",
      message: `Criterion ${criterion.kind} requires a workflow-specific validator not present in this bounded molecular slice`,
      observationRefs: [],
      evidenceRefs: [],
    };
  }
  const applicable = observations.filter((observation) => observation.type === expectedType);
  const evidenceRefs = [
    ...new Set(applicable.flatMap((observation) => observation.evidenceRefs)),
  ].sort();
  const observationRefs = applicable.map((observation) => observation.id).sort();
  if (applicable.length === 0) {
    return {
      status: "inconclusive",
      message: `No ${expectedType} observation was available for ${criterion.id}`,
      observationRefs,
      evidenceRefs,
    };
  }

  if (
    criterion.kind === "normal_termination" ||
    criterion.kind === "electronic_convergence" ||
    criterion.kind === "geometry_convergence"
  ) {
    const values = applicable
      .map(payloadBoolean)
      .filter((value): value is boolean => value !== undefined);
    if (values.length !== applicable.length) {
      return {
        status: "inconclusive",
        message: `${expectedType} observations were present but not boolean-valued`,
        observationRefs,
        evidenceRefs,
      };
    }
    const passed = values.every(Boolean);
    return {
      status: passed ? "passed" : "failed",
      message: passed
        ? `All ${expectedType} observations are true`
        : `At least one ${expectedType} observation is false`,
      observationRefs,
      evidenceRefs,
    };
  }

  const counts = applicable
    .map(payloadCount)
    .filter((value): value is number => value !== undefined);
  if (counts.length !== applicable.length) {
    return {
      status: "inconclusive",
      message: "Imaginary-frequency observations were present but not numeric",
      observationRefs,
      evidenceRefs,
    };
  }
  const maximum = Math.max(...counts);
  if (criterion.kind === "minimum_frequency") {
    const threshold = criterion.threshold ?? 0;
    const passed = maximum <= threshold;
    return {
      status: passed ? "passed" : "failed",
      message: passed
        ? `Maximum imaginary-frequency count ${maximum} is within threshold ${threshold}`
        : `Maximum imaginary-frequency count ${maximum} exceeds threshold ${threshold}`,
      observationRefs,
      evidenceRefs,
    };
  }
  const expected = criterion.threshold ?? 1;
  const passed = maximum === expected;
  return {
    status: passed ? "passed" : "failed",
    message: passed
      ? `Imaginary-frequency count ${maximum} matches transition-state target ${expected}`
      : `Imaginary-frequency count ${maximum} does not match transition-state target ${expected}`,
    observationRefs,
    evidenceRefs,
  };
}

function missingOutputContract(
  workUnit: WorkUnit,
  evidence: readonly EvidenceReference[],
  observations: readonly ScientificObservation[],
): { evidenceKinds: string[]; observationKinds: string[] } {
  const evidenceKinds = new Set(evidence.map((reference) => reference.kind));
  const observationKinds = new Set(observations.map((observation) => observation.type));
  return {
    evidenceKinds: workUnit.outputContract.requiredEvidenceKinds
      .filter((kind) => !evidenceKinds.has(kind as EvidenceReference["kind"]))
      .sort(),
    observationKinds: workUnit.outputContract.requiredObservationKinds
      .filter((kind) => !observationKinds.has(kind as ScientificObservation["type"]))
      .sort(),
  };
}

function incompleteOutputContractDetail(missing: {
  evidenceKinds: readonly string[];
  observationKinds: readonly string[];
}): string | undefined {
  const parts = [
    ...(missing.evidenceKinds.length > 0 ? [`evidence: ${missing.evidenceKinds.join(", ")}`] : []),
    ...(missing.observationKinds.length > 0
      ? [`observations: ${missing.observationKinds.join(", ")}`]
      : []),
  ];
  return parts.length > 0 ? `Output contract incomplete; missing ${parts.join("; ")}` : undefined;
}

function evidenceForIds(
  workUnit: WorkUnit,
  evidence: readonly EvidenceReference[],
  evidenceIds: ReadonlySet<string>,
): EvidenceReference[] {
  const skillEvidenceDigests = new Set(
    workUnit.skillRefs.map((fragment) => fragment.fragmentDigest),
  );
  return evidence.filter(
    (reference) =>
      evidenceIds.has(reference.id) ||
      (reference.kind === "skill_fragment" && skillEvidenceDigests.has(reference.contentDigest)),
  );
}

/**
 * Routes external chemistry WorkUnits to the canonical execution driver and
 * executes deterministic validation/assessment WorkUnits through typed mission
 * services. It exposes no runner, parser, SQL, shell, or model capability.
 */
export class ScientificMissionDriverRouter implements ScientificMissionWorkDriver {
  private readonly actor: ActorIdentity;

  constructor(private readonly options: ScientificInternalDriverOptions) {
    this.actor = options.actor ?? defaultActor;
  }

  async reconcileOperation(
    operation: ExternalOperation,
    context: { ownerId: string; now: string; signal?: AbortSignal },
  ): Promise<MissionOperationReconciliation> {
    if (operation.kind === "system_preparation") {
      const workUnit = await this.options.store.getWorkUnit(operation.workUnitId);
      if (workUnit && preparationCapability(workUnit)) {
        if (this.options.systemPreparationDriver) {
          return this.options.systemPreparationDriver.reconcileOperation(operation, context);
        }
        return {
          status: "waiting",
          operationId: operation.id,
          detail:
            "Amber system-preparation gateway is not configured; no local reconciliation was attempted",
        };
      }
    }
    return this.options.externalDriver.reconcileOperation(operation, context);
  }

  async executeClaimedWorkUnit(
    workUnit: WorkUnit,
    context: {
      ownerId: string;
      claimOwner: string;
      now: string;
      signal?: AbortSignal;
    },
  ): Promise<MissionWorkExecution> {
    switch (workUnit.kind) {
      case "optimization":
      case "frequency":
        return this.options.externalDriver.executeClaimedWorkUnit(workUnit, context);
      case "structure_validation":
        return this.executeStructureValidation(workUnit, context);
      case "validation":
        return this.executeValidation(workUnit, context);
      case "assessment":
        return this.executeAssessment(workUnit, context);
      case "collection":
      case "parsing":
        return this.failInternal(
          workUnit,
          context,
          `${workUnit.kind} is owned by the receipt-triggered external postprocessor`,
        );
      case "diagnosis":
        return this.failInternal(
          workUnit,
          context,
          "Diagnosis requires the skill-backed remediation service",
        );
      case "scientific_capability":
        if (preparationCapability(workUnit)) {
          if (this.options.systemPreparationDriver) {
            return this.options.systemPreparationDriver.executeClaimedWorkUnit(workUnit, context);
          }
          return {
            status: "waiting",
            workUnitId: workUnit.id,
            detail:
              "Amber system-preparation gateway is not configured; no local execution was attempted",
          };
        }
        if (workUnitUsesMdExecutionBinding(workUnit)) {
          return this.options.externalDriver.executeClaimedWorkUnit(workUnit, context);
        }
        return this.failInternal(
          workUnit,
          context,
          `Capability ${workUnit.executionPolicy.capability} has no typed application driver in this runtime snapshot`,
        );
    }
  }

  private async executeStructureValidation(
    workUnit: WorkUnit,
    context: { ownerId: string; claimOwner: string; now: string; signal?: AbortSignal },
  ): Promise<MissionWorkExecution> {
    const provenance = await this.options.store.getMissionProvenance(workUnit.missionId);
    const system = provenance.mission.objective.system;
    const evidence = provenance.evidence.find((reference) => reference.id === system.evidenceId);
    if (!evidence || !evidence.immutable || evidence.contentDigest !== system.contentDigest) {
      return this.failInternal(
        workUnit,
        context,
        "Molecular-system evidence is missing, mutable, or digest-mismatched",
      );
    }
    const payload = {
      status: "verified",
      evidenceId: evidence.id,
      contentDigest: evidence.contentDigest,
      format: system.format,
      atomCount: system.atomCount,
      charge: system.charge,
      multiplicity: system.multiplicity,
    };
    const observation = await this.options.store.createObservation(
      ScientificObservationSchema.parse({
        id: `observation-${digestCanonical({ workUnitId: workUnit.id, payload }).slice(0, 28)}`,
        missionId: workUnit.missionId,
        workUnitId: workUnit.id,
        type: "structure_validity",
        payload,
        source: { kind: "runtime", id: evidence.id },
        evidenceRefs: [evidence.id],
        qualityFlags: ["immutable", "digest_exact", "structure_reference"],
        observedAt: evidence.createdAt,
      }),
    );
    const incomplete = incompleteOutputContractDetail(
      missingOutputContract(workUnit, [evidence], [observation]),
    );
    if (incomplete) return this.failInternal(workUnit, context, incomplete);
    return this.completeInternal(workUnit, context, "Molecular-system evidence is digest-exact");
  }

  private async executeValidation(
    workUnit: WorkUnit,
    context: { ownerId: string; claimOwner: string; now: string; signal?: AbortSignal },
  ): Promise<MissionWorkExecution> {
    if (context.signal?.aborted) {
      return {
        status: "waiting",
        workUnitId: workUnit.id,
        detail: "Validation deferred for shutdown",
      };
    }
    await this.ensureMissionValidating(workUnit.missionId, context.now);
    const provenance = await this.options.store.getMissionProvenance(workUnit.missionId);
    const plan = provenance.plans.find(
      (candidate) => candidate.id === workUnit.planId && candidate.version === workUnit.planVersion,
    );
    if (!plan) return this.failInternal(workUnit, context, "Validation plan is missing");
    const criteria = provenance.mission.acceptanceCriteria.filter((criterion) =>
      plan.protocol.acceptanceCriteria.includes(criterion.id),
    );
    if (criteria.length === 0) {
      return this.failInternal(workUnit, context, "Approved protocol has no acceptance criteria");
    }
    const upstreamIds = new Set(workUnit.dependencies);
    const observations = provenance.observations.filter(
      (observation) =>
        observation.workUnitId !== workUnit.id &&
        (upstreamIds.size === 0 || upstreamIds.has(observation.workUnitId)),
    );
    const citedEvidenceIds = new Set(
      observations.flatMap((observation) => observation.evidenceRefs),
    );
    const contractEvidence = evidenceForIds(workUnit, provenance.evidence, citedEvidenceIds);
    const incomplete = incompleteOutputContractDetail(
      missingOutputContract(workUnit, contractEvidence, observations),
    );
    if (incomplete) return this.failInternal(workUnit, context, incomplete);
    const skillEvidenceRefs = contractEvidence
      .filter((reference) => reference.kind === "skill_fragment")
      .map((reference) => reference.id);
    for (const criterion of criteria) {
      const evaluation = evaluateCriterion(criterion, observations);
      const evidenceRefs = [...new Set([...evaluation.evidenceRefs, ...skillEvidenceRefs])].sort();
      await this.options.store.createValidationResult(
        ValidationResultSchema.parse({
          id: `validation-${digestCanonical({
            workUnitId: workUnit.id,
            criterionId: criterion.id,
            status: evaluation.status,
            observationRefs: evaluation.observationRefs,
            evidenceRefs,
          }).slice(0, 28)}`,
          missionId: workUnit.missionId,
          workUnitId: workUnit.id,
          criterionId: criterion.id,
          status: evaluation.status,
          summary: evaluation.message,
          observationRefs: evaluation.observationRefs,
          evidenceRefs,
          validatorVersion: "1.0.0",
          createdAt: evaluationTimestamp(workUnit, observations),
        }),
      );
    }
    return this.completeInternal(
      workUnit,
      context,
      `Evaluated ${criteria.length} exact acceptance criteria`,
    );
  }

  private async executeAssessment(
    workUnit: WorkUnit,
    context: { ownerId: string; claimOwner: string; now: string; signal?: AbortSignal },
  ): Promise<MissionWorkExecution> {
    if (context.signal?.aborted) {
      return {
        status: "waiting",
        workUnitId: workUnit.id,
        detail: "Assessment deferred for shutdown",
      };
    }
    await this.ensureMissionValidating(workUnit.missionId, context.now);
    const provenance = await this.options.store.getMissionProvenance(workUnit.missionId);
    const plan = provenance.plans.find(
      (candidate) => candidate.id === workUnit.planId && candidate.version === workUnit.planVersion,
    );
    if (!plan) return this.failInternal(workUnit, context, "Assessment plan is missing");
    const validationWorkIds = new Set(workUnit.dependencies);
    const validations = provenance.validations.filter(
      (validation) => validationWorkIds.size === 0 || validationWorkIds.has(validation.workUnitId),
    );
    if (validations.length === 0) {
      return this.failInternal(workUnit, context, "Assessment has no durable validation results");
    }
    const validationObservationIds = new Set(
      validations.flatMap((validation) => validation.observationRefs),
    );
    const validationEvidenceIds = new Set(
      validations.flatMap((validation) => validation.evidenceRefs),
    );
    const citedObservations = provenance.observations.filter((observation) =>
      validationObservationIds.has(observation.id),
    );
    const contractEvidence = evidenceForIds(workUnit, provenance.evidence, validationEvidenceIds);
    const incomplete = incompleteOutputContractDetail(
      missingOutputContract(workUnit, contractEvidence, citedObservations),
    );
    if (incomplete) return this.failInternal(workUnit, context, incomplete);
    const requiredCriteria = new Set(
      provenance.mission.acceptanceCriteria
        .filter((criterion) => criterion.required)
        .map((criterion) => criterion.id),
    );
    const validatedCriteria = new Set(validations.map((validation) => validation.criterionId));
    const missingRequiredCriteria = [...requiredCriteria]
      .filter((criterionId) => !validatedCriteria.has(criterionId))
      .sort();
    if (missingRequiredCriteria.length > 0) {
      return this.failInternal(
        workUnit,
        context,
        `Assessment is missing required validation results: ${missingRequiredCriteria.join(", ")}`,
      );
    }
    const required = validations.filter((validation) =>
      requiredCriteria.has(validation.criterionId),
    );
    const passed = required.filter((validation) => validation.status === "passed");
    const failed = required.filter((validation) => validation.status === "failed");
    const inconclusive = required.filter(
      (validation) =>
        validation.status === "inconclusive" || validation.status === "not_applicable",
    );
    const status =
      failed.length > 0
        ? passed.length > 0
          ? "partially_supported"
          : "refuted"
        : inconclusive.length > 0
          ? passed.length > 0
            ? "partially_supported"
            : "inconclusive"
          : "supported";
    const evidenceRefs = [
      ...new Set([
        ...validations.flatMap((validation) => validation.evidenceRefs),
        ...contractEvidence.map((reference) => reference.id),
        ...provenance.evidence
          .filter((reference) => reference.kind === "objective" || reference.kind === "structure")
          .map((reference) => reference.id),
      ]),
    ].sort();
    if (evidenceRefs.length === 0) {
      return this.failInternal(
        workUnit,
        context,
        "Assessment has no authoritative evidence references",
      );
    }
    const parserBackedObservations = citedObservations.filter(
      (observation) => observation.source.kind === "parser",
    );
    const unversionedParserObservations = parserBackedObservations.filter(
      (observation) =>
        typeof observation.payload.parserVersion !== "string" ||
        observation.payload.parserVersion.length === 0,
    );
    if (unversionedParserObservations.length > 0) {
      return this.failInternal(
        workUnit,
        context,
        `Assessment refuses parser-backed observations without parserVersion: ${unversionedParserObservations
          .map((observation) => observation.id)
          .sort()
          .join(", ")}`,
      );
    }
    const parserVersions = [
      ...new Set(
        parserBackedObservations
          .map((observation) => observation.payload.parserVersion)
          .filter((value): value is string => typeof value === "string" && value.length > 0),
      ),
    ].sort();
    if (
      workUnit.outputContract.requiredEvidenceKinds.includes("parser_output") &&
      parserVersions.length === 0
    ) {
      return this.failInternal(
        workUnit,
        context,
        "Assessment requires parser_output evidence but has no versioned parser observation",
      );
    }
    const fixtureEvidence = citedObservations.some((observation) =>
      observation.qualityFlags.includes("deterministic_fixture"),
    );
    const validationRefs = validations.map((validation) => validation.id).sort();
    const decisionRefs = provenance.decisions
      .filter((decision) => decision.planId === plan.id)
      .map((decision) => decision.id)
      .sort();
    const assessmentIdentity = {
      missionId: workUnit.missionId,
      planId: plan.id,
      planVersion: plan.version,
      validationRefs,
      evidenceRefs,
      status,
      parserVersions,
    };
    const assessmentId = `assessment-${digestCanonical(assessmentIdentity).slice(0, 28)}`;
    const existing = provenance.assessments.find((assessment) => assessment.id === assessmentId);
    const revision =
      existing?.revision ??
      Math.max(0, ...provenance.assessments.map((assessment) => assessment.revision)) + 1;
    const createdAt =
      validations
        .map((validation) => validation.createdAt)
        .sort()
        .at(-1) ?? workUnit.createdAt;
    await this.options.store.createAssessment(
      ScientificAssessmentSchema.parse({
        id: assessmentId,
        missionId: workUnit.missionId,
        revision,
        status,
        claims: validations.map((validation) => ({
          statement:
            validation.status === "passed"
              ? `Exact recorded evidence satisfies acceptance criterion ${validation.criterionId}`
              : `Acceptance criterion ${validation.criterionId} is ${validation.status}: ${validation.summary}`,
          support:
            validation.status === "passed"
              ? "supported"
              : validation.status === "failed"
                ? "unsupported"
                : "limited",
        })),
        limitations: [
          ...plan.limitations,
          "The assessment applies only to the exact approved protocol revision and recorded evidence.",
          ...(fixtureEvidence
            ? [
                "Deterministic executable-fixture evidence proves orchestration and provenance, not real-engine scientific accuracy.",
              ]
            : []),
        ],
        uncertainty: {
          level:
            failed.length === 0 && inconclusive.length === 0
              ? "low"
              : passed.length > 0
                ? "medium"
                : "high",
          sources: [
            "Method, basis, physical model, numerical settings, parser coverage, and available evidence bound this conclusion.",
            ...(failed.length > 0 || inconclusive.length > 0
              ? ["One or more required acceptance criteria remain failed or inconclusive."]
              : []),
          ],
        },
        unresolvedQuestions: inconclusive.map(
          (validation) =>
            `Acceptance criterion ${validation.criterionId} requires conclusive validation evidence.`,
        ),
        decisionRefs,
        skillRefs: plan.skillResolution.selectedFragments,
        evidenceRefs,
        validationRefs,
        protocolVersion: `${plan.protocol.schemaVersion}+compiler.${plan.protocol.compilerVersion}`,
        parserVersion: parserVersions.join(",") || "unknown",
        fixtureEvidence,
        generatedBy: this.actor,
        createdAt,
      }),
    );
    const completed = await this.completeInternal(
      workUnit,
      context,
      `Created assessment ${assessmentId} with status ${status}`,
    );
    await this.completeMission(workUnit.missionId, context.now);
    return completed;
  }

  private async completeInternal(
    workUnit: WorkUnit,
    context: { claimOwner: string; now: string },
    detail: string,
  ): Promise<MissionWorkExecution> {
    const latest = await this.options.store.getWorkUnit(workUnit.id);
    if (!latest) throw new Error(`Internal work unit ${workUnit.id} disappeared`);
    const settled = await this.options.persistence.settleInternalWorkUnit({
      workUnitId: latest.id,
      expectedRevision: latest.revision,
      claimOwner: context.claimOwner,
      outcome: "succeeded",
      at: context.now,
    });
    return {
      status: "completed",
      workUnitId: settled.workUnit.id,
      detail,
    };
  }

  private async failInternal(
    workUnit: WorkUnit,
    context: { claimOwner: string; now: string },
    detail: string,
  ): Promise<MissionWorkExecution> {
    const latest = await this.options.store.getWorkUnit(workUnit.id);
    if (latest && latest.claimOwner === context.claimOwner) {
      await this.options.persistence.settleInternalWorkUnit({
        workUnitId: latest.id,
        expectedRevision: latest.revision,
        claimOwner: context.claimOwner,
        outcome: "failed",
        at: context.now,
      });
    }
    return { status: "failed", workUnitId: workUnit.id, detail, retryable: false };
  }

  private async ensureMissionValidating(missionId: string, at: string): Promise<ScientificMission> {
    const mission = await this.options.store.getMission(missionId);
    if (!mission) throw new Error(`Mission ${missionId} was not found`);
    if (mission.state === "validating") return mission;
    if (mission.state !== "executing" && mission.state !== "observing") {
      throw new Error(`Mission ${mission.id} cannot enter validation from ${mission.state}`);
    }
    return this.options.store.transitionMission({
      missionId: mission.id,
      expectedRevision: mission.revision,
      to: "validating",
      reason: "deterministic_validation_started",
      actor: this.actor,
      at,
    });
  }

  private async completeMission(missionId: string, at: string): Promise<void> {
    const mission = await this.options.store.getMission(missionId);
    if (!mission) throw new Error(`Mission ${missionId} was not found`);
    if (mission.state === "completed") return;
    if (mission.state !== "validating") {
      throw new Error(`Mission ${mission.id} cannot complete from ${mission.state}`);
    }
    await this.options.store.transitionMission({
      missionId: mission.id,
      expectedRevision: mission.revision,
      to: "completed",
      reason: "scientific_assessment_persisted",
      actor: this.actor,
      at,
    });
  }
}
