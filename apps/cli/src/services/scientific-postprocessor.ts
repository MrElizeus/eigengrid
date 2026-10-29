import {
  EvidenceReferenceSchema,
  ScientificObservationSchema,
  digestCanonical,
  type EvidenceReference,
  type ScientificObservation,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import { ScientificStore, type MissionWorkExecution } from "@eigengrid/mission-runtime";
import type { ExecutionService } from "./execution-coordinator";
import type {
  ScientificArtifactSnapshot,
  ScientificExecutionInspector,
  ScientificExecutionSnapshot,
} from "./scientific-execution-inspector";

export interface ScientificExternalPostprocessingContext {
  ownerId: string;
  now: string;
  signal?: AbortSignal;
}

export interface ScientificExternalWorkUnitPostprocessor {
  continueExternalWorkUnit(
    workUnit: WorkUnit,
    context: ScientificExternalPostprocessingContext,
  ): Promise<MissionWorkExecution>;
}

export interface CanonicalScientificPostprocessorOptions {
  store: ScientificStore;
  execution: ExecutionService;
  inspector: ScientificExecutionInspector;
  parserVersion?: string;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function sourceTimestamp(epochMilliseconds: number): string {
  const value = new Date(epochMilliseconds);
  if (!Number.isFinite(value.getTime()))
    throw new Error("Scientific evidence has an invalid timestamp");
  return value.toISOString();
}

function artifactEvidenceId(workUnit: WorkUnit, snapshot: ScientificArtifactSnapshot): string {
  return `evidence-artifact-${digestCanonical({
    missionId: workUnit.missionId,
    workUnitId: workUnit.id,
    artifactId: snapshot.artifact.id,
    digest: snapshot.contentDigest,
  }).slice(0, 28)}`;
}

function parserEvidenceId(
  workUnit: WorkUnit,
  snapshot: ScientificExecutionSnapshot,
  parserVersion: string,
): string {
  if (!snapshot.result) throw new Error("Parser evidence requires a parsed result");
  return `evidence-parser-${digestCanonical({
    missionId: workUnit.missionId,
    workUnitId: workUnit.id,
    resultId: snapshot.result.record.id,
    digest: snapshot.result.contentDigest,
    parserVersion,
  }).slice(0, 28)}`;
}

function observationId(
  workUnit: WorkUnit,
  type: ScientificObservation["type"],
  payload: Record<string, unknown>,
  evidenceRefs: readonly string[],
): string {
  return `observation-${digestCanonical({
    missionId: workUnit.missionId,
    workUnitId: workUnit.id,
    type,
    payload,
    evidenceRefs: [...evidenceRefs].sort(),
  }).slice(0, 28)}`;
}

function rawBoolean(raw: Record<string, unknown> | null, keys: readonly string[]): boolean | null {
  if (!raw) return null;
  for (const key of keys) {
    if (typeof raw[key] === "boolean") return raw[key] as boolean;
  }
  return null;
}

/**
 * Fixture status is authority-bearing protocol material, not an executable-name
 * heuristic. A real engine and a deterministic fixture may intentionally share
 * the same parser and software identifier.
 */
function approvedFixtureEvidenceOnly(workUnit: WorkUnit): boolean {
  const parameters = asRecord(workUnit.protocolFragment.parameters);
  const execution = asRecord(parameters.execution);
  return execution.fixtureEvidenceOnly === true || parameters.fixtureEvidenceOnly === true;
}

/**
 * Idempotent collect → integrity → parse → observation continuation for an
 * external chemistry WorkUnit. All process and parser lifecycle actions remain
 * owned by ExecutionCoordinator; this component receives only typed services.
 */
export class CanonicalScientificPostprocessor implements ScientificExternalWorkUnitPostprocessor {
  private readonly store: ScientificStore;
  private readonly execution: ExecutionService;
  private readonly inspector: ScientificExecutionInspector;
  private readonly parserVersion: string;

  constructor(options: CanonicalScientificPostprocessorOptions) {
    this.store = options.store;
    this.execution = options.execution;
    this.inspector = options.inspector;
    const parserVersion = options.parserVersion ?? "controlled-alpha-parser-bridge/1";
    if (!parserVersion.trim()) {
      throw new Error("Scientific postprocessing requires a non-empty parserVersion");
    }
    this.parserVersion = parserVersion;
  }

  async continueExternalWorkUnit(
    workUnitInput: WorkUnit,
    context: ScientificExternalPostprocessingContext,
  ): Promise<MissionWorkExecution> {
    const current = (await this.store.getWorkUnit(workUnitInput.id)) ?? workUnitInput;
    if (current.state === "succeeded") {
      return {
        status: "completed",
        workUnitId: current.id,
        detail: "Scientific postprocessing was already completed",
      };
    }
    if (current.state !== "observing") {
      return {
        status: "failed",
        workUnitId: current.id,
        detail: `Scientific postprocessing requires observing state, found ${current.state}`,
        retryable: false,
      };
    }
    if (!current.jobId || !current.attemptId) {
      return this.failWorkUnit(
        current,
        context,
        "missing_effect_identity",
        "Observing WorkUnit has no canonical job/attempt identity",
        [],
      );
    }
    if (context.signal?.aborted) {
      return {
        status: "waiting",
        workUnitId: current.id,
        detail: "Scientific postprocessing deferred for graceful shutdown",
      };
    }

    const executionEvidence = await this.executionEvidence(current);
    const collect = await this.execution.collectLocal(current.jobId);
    if (!collect.ok) {
      return this.failWorkUnit(
        current,
        context,
        "artifact_collection_failed",
        collect.message ?? "Canonical artifact collection failed",
        executionEvidence.map((reference) => reference.id),
      );
    }

    let collected: ScientificExecutionSnapshot;
    try {
      collected = await this.inspector.inspect({
        jobId: current.jobId,
        attemptId: current.attemptId,
        requireOutputArtifact: true,
      });
    } catch (error) {
      return this.failWorkUnit(
        current,
        context,
        "artifact_inspection_failed",
        error instanceof Error ? error.message : String(error),
        executionEvidence.map((reference) => reference.id),
        "artifact_integrity",
      );
    }

    const artifactEvidence = await this.persistArtifactEvidence(current, collected);
    const corrupt = collected.artifacts.filter(
      (artifact) => artifact.integrity.status === "corrupt",
    );
    await this.persistArtifactIntegrityObservations(current, collected, artifactEvidence);
    if (corrupt.length > 0) {
      return this.failWorkUnit(
        current,
        context,
        "artifact_corruption",
        corrupt
          .map(
            (artifact) =>
              `${artifact.artifact.id}: ${artifact.integrity.status === "corrupt" ? artifact.integrity.reasons.join("; ") : "unknown"}`,
          )
          .join(" | "),
        artifactEvidence.map((reference) => reference.id),
        "artifact_integrity",
      );
    }

    const parsed = await this.execution.parseJob(current.jobId);
    if (!parsed.ok) {
      return this.failWorkUnit(
        current,
        context,
        "parser_failure",
        parsed.message ?? "Canonical parser failed",
        artifactEvidence.map((reference) => reference.id),
      );
    }

    let snapshot: ScientificExecutionSnapshot;
    try {
      snapshot = await this.inspector.inspect({
        jobId: current.jobId,
        attemptId: current.attemptId,
        requireOutputArtifact: true,
        requireResult: true,
      });
    } catch (error) {
      return this.failWorkUnit(
        current,
        context,
        "parser_result_missing",
        error instanceof Error ? error.message : String(error),
        artifactEvidence.map((reference) => reference.id),
      );
    }
    if (!snapshot.result) {
      return this.failWorkUnit(
        current,
        context,
        "parser_result_missing",
        "Parser reported success without a durable typed result",
        artifactEvidence.map((reference) => reference.id),
      );
    }

    const parserEvidence = EvidenceReferenceSchema.parse({
      id: parserEvidenceId(current, snapshot, this.parserVersion),
      missionId: current.missionId,
      workUnitId: current.id,
      kind: "parser_output",
      uri: `eigengrid-parser-result://${snapshot.result.record.id}?parserVersion=${encodeURIComponent(this.parserVersion)}`,
      contentDigest: digestCanonical({
        resultDigest: snapshot.result.contentDigest,
        parserVersion: this.parserVersion,
      }),
      mediaType: "application/vnd.eigengrid.chemistry-result+json",
      immutable: true,
      sourceId: snapshot.result.record.id,
      createdAt: sourceTimestamp(snapshot.result.record.createdAt),
    });
    await this.store.createEvidence(parserEvidence);
    const evidenceRefs = [
      ...new Set([
        ...executionEvidence.map((reference) => reference.id),
        ...artifactEvidence.map((reference) => reference.id),
        parserEvidence.id,
      ]),
    ].sort();
    await this.persistResultObservations(current, snapshot, evidenceRefs);

    const provenance = await this.store.getMissionProvenance(current.missionId);
    const persistedEvidenceKinds = new Set<string>(
      provenance.evidence
        .filter((reference) => reference.workUnitId === current.id && reference.immutable)
        .map((reference) => reference.kind),
    );
    const missingEvidenceKinds = current.outputContract.requiredEvidenceKinds.filter(
      (kind) => !persistedEvidenceKinds.has(kind),
    );
    const requiredTypes = new Set(current.outputContract.requiredObservationKinds);
    const observedTypes = new Set<string>(
      provenance.observations
        .filter((observation) => observation.workUnitId === current.id)
        .map((observation) => observation.type),
    );
    const missingTypes = [...requiredTypes].filter((type) => !observedTypes.has(type));
    if (missingEvidenceKinds.length > 0 || missingTypes.length > 0) {
      const missing = [
        ...(missingEvidenceKinds.length > 0
          ? [`evidence: ${missingEvidenceKinds.sort().join(", ")}`]
          : []),
        ...(missingTypes.length > 0 ? [`observations: ${missingTypes.sort().join(", ")}`] : []),
      ];
      return this.failWorkUnit(
        current,
        context,
        "output_contract_incomplete",
        `Missing required ${missing.join("; ")}`,
        evidenceRefs,
      );
    }

    const latest = await this.store.getWorkUnit(current.id);
    if (!latest) throw new Error(`Work unit ${current.id} disappeared during postprocessing`);
    if (latest.state === "succeeded") {
      return {
        status: "completed",
        workUnitId: latest.id,
        detail: "Scientific postprocessing was already completed",
      };
    }
    const succeeded = await this.store.transitionWorkUnit({
      workUnitId: latest.id,
      expectedRevision: latest.revision,
      to: "succeeded",
      at: context.now,
      claimOwner: context.ownerId,
    });
    return {
      status: "completed",
      workUnitId: succeeded.id,
      detail: `Collected ${artifactEvidence.length} artifacts and satisfied the evidence/observation contract with ${this.parserVersion}`,
    };
  }

  private async persistArtifactEvidence(
    workUnit: WorkUnit,
    snapshot: ScientificExecutionSnapshot,
  ): Promise<EvidenceReference[]> {
    const references: EvidenceReference[] = [];
    for (const artifact of snapshot.artifacts) {
      const reference = EvidenceReferenceSchema.parse({
        id: artifactEvidenceId(workUnit, artifact),
        missionId: workUnit.missionId,
        workUnitId: workUnit.id,
        kind: "artifact",
        uri: `file://${artifact.canonicalPath}`,
        contentDigest: artifact.contentDigest,
        sizeBytes: artifact.actualSizeBytes,
        mediaType: artifact.artifact.mimeType ?? "application/octet-stream",
        immutable: true,
        sourceId: artifact.artifact.id,
        createdAt: sourceTimestamp(artifact.artifact.createdAt),
      });
      references.push(await this.store.createEvidence(reference));
    }
    return references;
  }

  private async persistArtifactIntegrityObservations(
    workUnit: WorkUnit,
    snapshot: ScientificExecutionSnapshot,
    evidence: readonly EvidenceReference[],
  ): Promise<void> {
    const evidenceByArtifact = new Map(
      evidence
        .filter(
          (reference): reference is EvidenceReference & { sourceId: string } =>
            typeof reference.sourceId === "string",
        )
        .map((reference) => [reference.sourceId, reference]),
    );
    for (const artifact of snapshot.artifacts) {
      const reference = evidenceByArtifact.get(artifact.artifact.id);
      if (!reference)
        throw new Error(`Artifact evidence mapping failed for ${artifact.artifact.id}`);
      const payload = {
        artifactId: artifact.artifact.id,
        kind: artifact.artifact.kind,
        status: artifact.integrity.status,
        contentDigest: artifact.contentDigest,
        actualSizeBytes: artifact.actualSizeBytes,
        declaredSizeBytes: artifact.artifact.sizeBytes ?? null,
        reasons: artifact.integrity.status === "corrupt" ? artifact.integrity.reasons : [],
      };
      await this.store.createObservation(
        ScientificObservationSchema.parse({
          id: observationId(workUnit, "artifact_integrity", payload, [reference.id]),
          missionId: workUnit.missionId,
          workUnitId: workUnit.id,
          type: "artifact_integrity",
          payload,
          source: { kind: "runtime", id: artifact.artifact.id },
          evidenceRefs: [reference.id],
          qualityFlags:
            artifact.integrity.status === "verified"
              ? ["checksum_computed", "regular_file", "job_directory_confined"]
              : ["corrupt"],
          observedAt: sourceTimestamp(artifact.artifact.createdAt),
        }),
      );
    }
  }

  private async persistResultObservations(
    workUnit: WorkUnit,
    snapshot: ScientificExecutionSnapshot,
    evidenceRefs: readonly string[],
  ): Promise<void> {
    if (!snapshot.result) throw new Error("Result observations require a durable parsed result");
    const result = snapshot.result.record;
    const observedAt = sourceTimestamp(result.createdAt);
    const qualityFlags = [
      "parser_backed",
      ...(approvedFixtureEvidenceOnly(workUnit) ? ["deterministic_fixture"] : []),
      ...(result.status === "partial" ? ["partial_result"] : []),
    ];
    const create = async (
      type: ScientificObservation["type"],
      payload: Record<string, unknown>,
    ): Promise<void> => {
      const versionedPayload = {
        ...payload,
        parser: result.parser,
        parserVersion: this.parserVersion,
      };
      await this.store.createObservation(
        ScientificObservationSchema.parse({
          id: observationId(workUnit, type, versionedPayload, evidenceRefs),
          missionId: workUnit.missionId,
          workUnitId: workUnit.id,
          type,
          payload: versionedPayload,
          source: { kind: "parser", id: result.id },
          evidenceRefs: [...evidenceRefs],
          qualityFlags,
          observedAt,
        }),
      );
    };

    if (result.normalTermination !== null) {
      await create("normal_termination", {
        value: result.normalTermination,
        parser: result.parser,
        status: result.status,
      });
    }
    if (result.scfConverged !== null) {
      await create("electronic_convergence", {
        value: result.scfConverged,
        parser: result.parser,
      });
    }
    const parserPayload = asRecord(result.raw);
    const parserSpecific = asRecord(parserPayload.raw);
    const geometryConvergenceKeys = [
      "geometryConverged",
      "geometry_converged",
      "optimizationConverged",
      "optimization_converged",
    ] as const;
    const geometryConverged =
      rawBoolean(parserSpecific, geometryConvergenceKeys) ??
      rawBoolean(parserPayload, geometryConvergenceKeys);
    if (geometryConverged !== null) {
      await create("geometry_convergence", { value: geometryConverged, parser: result.parser });
    }
    if (result.imaginaryFrequencies !== null) {
      await create("imaginary_frequencies", {
        count: result.imaginaryFrequencies,
        parser: result.parser,
      });
    }
    if (result.energyHartree !== null) {
      await create("energy", {
        value: result.energyHartree,
        unit: "hartree",
        parser: result.parser,
      });
    }
    if (result.errors.length > 0 || result.status === "failed") {
      await create("failure_signature", {
        status: result.status,
        errors: result.errors,
        warnings: result.warnings,
      });
    }
  }

  private async executionEvidence(workUnit: WorkUnit): Promise<EvidenceReference[]> {
    const provenance = await this.store.getMissionProvenance(workUnit.missionId);
    return provenance.evidence.filter(
      (reference) =>
        reference.workUnitId === workUnit.id &&
        (reference.kind === "rendered_input" || reference.kind === "operation_receipt"),
    );
  }

  private async failWorkUnit(
    workUnit: WorkUnit,
    context: ScientificExternalPostprocessingContext,
    code: string,
    detail: string,
    evidenceRefs: string[],
    observationType: ScientificObservation["type"] = "failure_signature",
  ): Promise<MissionWorkExecution> {
    const references = evidenceRefs.length > 0 ? [...new Set(evidenceRefs)].sort() : [];
    if (references.length > 0) {
      const payload = { code, detail };
      await this.store.createObservation(
        ScientificObservationSchema.parse({
          id: observationId(workUnit, observationType, payload, references),
          missionId: workUnit.missionId,
          workUnitId: workUnit.id,
          type: observationType,
          payload,
          source: { kind: "runtime", id: workUnit.id },
          evidenceRefs: references,
          qualityFlags: ["postprocessing_failure"],
          observedAt: context.now,
        }),
      );
    }
    const latest = await this.store.getWorkUnit(workUnit.id);
    if (latest && latest.state === "observing") {
      await this.store.transitionWorkUnit({
        workUnitId: latest.id,
        expectedRevision: latest.revision,
        to: "failed",
        at: context.now,
        claimOwner: context.ownerId,
      });
    }
    return {
      status: "failed",
      workUnitId: workUnit.id,
      detail: `${code}: ${detail}`,
      retryable: false,
    };
  }
}
