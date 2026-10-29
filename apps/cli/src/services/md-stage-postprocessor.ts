/** Internal deterministic Head continuation. No request-supplied path, command,
 * approver, policy, engine or observed interval is accepted by this service. */
import {
  ContentAddressedArtifactStore,
  ScientificStore,
  MdProjectionStore,
  MdResultCollectionStore,
  MdStageLifecycleStore,
  mdPostprocessingIds,
  type ScientificDatabase,
  type MdReplicaVerifier,
  type MdStageFinalizationInput,
} from "@eigengrid/mission-runtime";
import {
  MdExecutionBindingParametersSchema,
  MdStageOperationRequestSchema,
  MdStageResultSchema,
  MdStageAssessmentSchema,
  TrajectorySegmentSchema,
  computeMdStageResultDigest,
  computeMdStageAssessmentDigest,
  computeTrajectorySegmentDigest,
  canonicalJson,
  digestCanonical,
  type MdStageResult,
  type MdStageSpec,
  type MdAcceptanceEvaluation,
  type MdEnvironmentCapabilitySnapshot,
  type MdExecutionBindingParameters,
  type MdArtifactReference,
} from "@eigengrid/scientific-schema";
import {
  parseAmberMdTelemetry,
  AmberTelemetryUnits,
  type AmberTelemetryParseResult,
  type AmberByteInspection,
} from "@eigengrid/md-analysis";
import type { MdCompilerPolicy } from "@eigengrid/protocol-core";
import {
  CanonicalAmberArtifactInspector,
  type CanonicalAmberStageInspection,
} from "./amber-artifact-inspector";
import { AmberWorkerReceiptSchema } from "./amber-slurm-runner";

export type MdPostprocessingOutcome =
  | { status: "advanced"; workUnitIds: string[]; detail: string }
  | { status: "waiting" | "review_required"; detail: string };

function timestamp(ns: string): string {
  const milliseconds = BigInt(ns) / 1_000_000n;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Engine timestamp is outside the supported range");
  return new Date(Number(milliseconds)).toISOString();
}
function timeMatches(actual: number | null, expected: number, precision: number | null): boolean {
  return (
    actual !== null &&
    precision !== null &&
    Number.isFinite(actual) &&
    Math.abs(actual - expected) <= Math.max(precision * 4, 1e-8, Math.abs(expected) * 1e-9)
  );
}

/** Only these declared criterion semantics are automatic. Unimplemented physics
 * is inconclusive, NEVER a blanket PASS based on successful process termination. */
export function evaluateCollectedMdCriteria(input: {
  stage: MdStageSpec;
  result: MdStageResult;
  telemetry: AmberTelemetryParseResult | null;
  normalTermination: boolean;
  integrity: boolean;
  continuity: boolean;
  evidenceId: string;
}): MdAcceptanceEvaluation[] {
  const { stage, result, telemetry } = input;
  return stage.acceptanceCriteria.map((criterion) => {
    const base = {
      criterionId: criterion.id,
      criterionDigest: criterion.criterionDigest,
      required: criterion.required,
      evidenceRefs: [input.evidenceId],
    };
    const unknown = () => ({
      ...base,
      status: "inconclusive" as const,
      summary:
        "This exact criterion/version has no qualified deterministic evaluator; scientific review required",
    });
    if (criterion.evaluatorVersion !== "1.0.0") return unknown();
    const facts = {
      normal_termination: input.normalTermination,
      artifact_integrity: input.integrity,
      restart_continuity: input.continuity,
    };
    if (criterion.kind in facts) {
      const value = facts[criterion.kind as keyof typeof facts];
      return {
        ...base,
        status: value ? ("passed" as const) : ("failed" as const),
        summary: `Observed ${criterion.kind} from authenticated collection, decoded bytes and the approved stage`,
      };
    }
    // Explicitly named mean_* observables only; 'temperature' alone would be
    // ambiguous between an instantaneous, mean, RMS or range criterion.
    if (
      criterion.kind === "thermodynamic_range" &&
      telemetry?.status === "completed" &&
      criterion.observable?.startsWith("mean_")
    ) {
      const metric = criterion.observable.slice(5) as keyof typeof AmberTelemetryUnits;
      const cadence = stage.outputs.find((o) => o.role === "mdout")?.cadenceSteps;
      if (
        !(metric in AmberTelemetryUnits) ||
        criterion.unit !== AmberTelemetryUnits[metric] ||
        !cadence ||
        !stage.timeStepPs
      )
        return unknown();
      const window = criterion.windowFraction ?? { start: 0, end: 1 };
      const samples = telemetry.samples.filter(
        (s) =>
          s.step !== undefined &&
          s.step > 0 &&
          s.step >= stage.steps * window.start &&
          s.step <= stage.steps * window.end,
      );
      const first = Math.max(1, Math.ceil((stage.steps * window.start) / cadence)) * cadence;
      const last = Math.floor((stage.steps * window.end) / cadence) * cadence;
      const count = last >= first ? (last - first) / cadence + 1 : 0;
      if (
        count < 2 ||
        samples.length !== count ||
        samples.some(
          (s, i) =>
            s.step !== first + i * cadence ||
            s.timePs === undefined ||
            !timeMatches(s.timePs, result.startTimePs + s.step * stage.timeStepPs!, 1e-8) ||
            s.values[metric] === undefined,
        )
      )
        return unknown();
      const mean = samples.reduce((sum, s) => sum + s.values[metric]! / samples.length, 0);
      if (!Number.isFinite(mean)) return unknown();
      const accepted =
        (criterion.lowerBound === undefined || mean >= criterion.lowerBound) &&
        (criterion.upperBound === undefined || mean <= criterion.upperBound);
      return {
        ...base,
        status: accepted ? ("passed" as const) : ("failed" as const),
        observedValue: mean,
        observedUnit: criterion.unit,
        summary:
          "Predeclared regular-window arithmetic mean; not convergence or an independent-sample uncertainty estimate",
      };
    }
    return unknown();
  });
}

export class CanonicalMdStagePostprocessor {
  private readonly store: ScientificStore;
  private readonly md: MdProjectionStore;
  private readonly collections: MdResultCollectionStore;
  private readonly lifecycle: MdStageLifecycleStore;
  private readonly clock: () => Date;
  constructor(
    private readonly input: {
      database: ScientificDatabase;
      objects: ContentAddressedArtifactStore;
      /** Protected service configuration, NOT a tool/model/user payload. */
      policy: MdCompilerPolicy;
      environment: MdEnvironmentCapabilitySnapshot;
      assertAuthorityCurrent?: () => unknown;
      pythonExecutable: string;
      replicaVerifier?: MdReplicaVerifier;
      now?: () => Date;
    },
  ) {
    this.store = new ScientificStore(input.database);
    this.md = new MdProjectionStore(input.database, input.objects);
    this.collections = new MdResultCollectionStore(input.database, input.objects);
    this.lifecycle = new MdStageLifecycleStore(input.database, input.objects, {
      replicaVerifier: input.replicaVerifier,
    });
    this.clock = input.now ?? (() => new Date());
  }

  async process(
    operationId: string,
    ownerId: string,
    signal?: AbortSignal,
  ): Promise<MdPostprocessingOutcome> {
    if (signal?.aborted)
      return { status: "waiting", detail: "MD postprocessing interrupted before admission" };
    const authority = await this.collections.readAuthority(operationId),
      prior = await this.lifecycle.get(operationId);
    if (authority.workUnit.state === "succeeded")
      return {
        status: "advanced",
        workUnitIds: [],
        detail: "Canonical MD completion already committed; no engine resubmission",
      };
    if (prior && prior.status !== "accepted")
      return {
        status: "review_required",
        detail: "Immutable MD assessment requires scientific review",
      };
    const now = this.clock();
    const claim = await this.lifecycle.acquire({
      operationId,
      ownerId,
      now: now.toISOString(),
      expiresAt: new Date(now.getTime() + 120_000).toISOString(),
    });
    if (!claim.acquired) return { status: "waiting", detail: `MD postprocessing ${claim.reason}` };
    let leaseLost: unknown,
      heartbeat = Promise.resolve();
    const timer = setInterval(() => {
      heartbeat = heartbeat
        .then(async () => {
          if (leaseLost || signal?.aborted) return;
          const at = this.clock();
          await this.lifecycle.renew(
            claim.lease,
            at.toISOString(),
            new Date(at.getTime() + 120_000).toISOString(),
          );
        })
        .catch((error) => {
          leaseLost = error;
        });
    }, 30_000);
    const check = () => {
      this.input.assertAuthorityCurrent?.();
      if (leaseLost) throw leaseLost;
      if (signal?.aborted) throw new Error("MD postprocessing interrupted; evidence not admitted");
    };
    try {
      if (!prior) {
        const finalized = await this.inspect(operationId, claim.lease);
        check();
        await this.lifecycle.finalize(finalized, {
          now: this.clock().toISOString(),
          currentPolicyDigest: this.input.policy.policyDigest,
        });
      }
      check();
      const advanced = await this.lifecycle.advance({
        lease: claim.lease,
        now: this.clock().toISOString(),
        policy: this.input.policy,
        environment: this.input.environment,
      });
      if (advanced.status === "advanced")
        return {
          status: "advanced",
          workUnitIds: advanced.workUnitIds,
          detail:
            "Exact MD result and approved successor committed atomically after verified artifact replica; no site/RPO0 qualification implied",
        };
      if (advanced.status === "pending_replication")
        return {
          status: "waiting",
          detail:
            "MD result preserved; independent signed artifact readback acknowledgement pending",
        };
      return {
        status: "review_required",
        detail: "MD scientific criteria are rejected or indeterminate; no successor admitted",
      };
    } finally {
      clearInterval(timer);
      await heartbeat;
      // A stale lease may never release another owner's replacement claim.
      await this.lifecycle.release(claim.lease, this.clock().toISOString()).catch(() => undefined);
    }
  }

  private async inspect(
    operationId: string,
    lease: MdStageFinalizationInput["lease"],
  ): Promise<MdStageFinalizationInput> {
    const authority = await this.collections.readAuthority(operationId),
      collection = await this.collections.get(operationId);
    if (
      !collection ||
      collection.outcome !== "completed" ||
      collection.artifactStatus !== "complete"
    )
      throw new Error("No complete canonical MD collection to inspect");
    const binding = MdExecutionBindingParametersSchema.parse(
      authority.workUnit.protocolFragment.parameters,
    );
    const request = MdStageOperationRequestSchema.parse(authority.operation.request);
    const protocol = await this.md.getProtocol(binding.protocol.id, binding.protocol.revision);
    const system = await this.md.getSystemManifest(binding.system.id, binding.system.revision);
    const stage = protocol?.stages.find(
      (s) => s.id === binding.stage.id && s.revision === binding.stage.revision,
    );
    if (!stage || !system) throw new Error("Collected MD protocol/system/stage unavailable");
    const source = await this.readObject(collection.workerReceiptDigest, 2 * 1024 ** 2);
    const receipt = AmberWorkerReceiptSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.bytes)),
    );
    if (
      receipt.operationId !== operationId ||
      receipt.requestDigest !== authority.operation.requestDigest ||
      receipt.jobId !== collection.slurmJobId ||
      receipt.cluster !== collection.slurmCluster ||
      receipt.uid !== collection.uid ||
      !receipt.inputsIntact ||
      receipt.artifactStatus !== "complete" ||
      receipt.engine.exitCode !== 0 ||
      receipt.engine.signal !== null ||
      receipt.engine.executionError !== null
    )
      throw new Error("Worker receipt conflicts with the exact adopted MD collection");
    for (const output of receipt.outputs) {
      const role = `output_${output.role}`,
        object = collection.artifacts.find((a) => a.role === role);
      if (
        output.status !== "present" ||
        !output.object ||
        !object ||
        object.sha256 !== output.object.sha256 ||
        object.sizeBytes !== output.object.sizeBytes ||
        object.mediaType !== output.mediaType
      )
        throw new Error("Worker output differs from the adopted collection inventory");
    }
    const ids = mdPostprocessingIds(operationId);
    const parent = await this.parentInterval(
      binding,
      stage,
      authority.workUnit.dependencies,
      authority.workUnit.missionId,
    );
    const artifacts: MdArtifactReference[] = stage.outputs.flatMap((definition) => {
      const artifact = collection.artifacts.find(
        (a) => a.role === `output_stage_${definition.role}`,
      );
      if (!artifact) {
        if (definition.required) throw new Error("Required stage output was not collected");
        return [];
      }
      return [
        {
          artifactId: `${ids.resultId}-${definition.role}`,
          role: definition.role,
          contentDigest: artifact.sha256,
          evidenceRef: `evidence-md-${digestCanonical({ operationId, role: artifact.role })}`,
          mediaType: artifact.mediaType,
          sizeBytes: artifact.sizeBytes,
        },
      ];
    });
    const replica = binding.replicaSegment;
    const seed = {
      schemaVersion: "eigengrid.md-stage-result/v1" as const,
      id: ids.resultId,
      revision: 1,
      missionId: authority.workUnit.missionId,
      workUnitId: authority.workUnit.id,
      operationId,
      operationReceiptId: authority.operation.receiptId!,
      protocolId: protocol!.id,
      protocolRevision: protocol!.revision,
      protocolDigest: protocol!.protocolDigest,
      stageId: stage.id,
      stageRevision: stage.revision,
      stageDigest: stage.stageDigest,
      stageKind: stage.kind,
      ...(replica
        ? {
            replicaSetId: replica.replicaSetId,
            replicaSetRevision: replica.replicaSetRevision,
            replicaSetDigest: replica.replicaSetDigest,
            replicaId: replica.replicaId,
            segmentIndex: replica.segmentIndex,
            parentRestartDigest: binding.parentRestart!.contentDigest,
          }
        : {}),
      terminalReason: "ambiguous" as const,
      exitCode: receipt.engine.exitCode,
      signal: null,
      startedAt: timestamp(receipt.engine.startedAtNs),
      finishedAt: timestamp(receipt.engine.finishedAtNs),
      startStep: parent.step,
      endStep: parent.step,
      startTimePs: parent.timePs,
      endTimePs: parent.timePs,
      engine: request.environment.engine,
      artifacts,
      warnings: [],
      errors: [],
      validationStatus: "not_run" as const,
      validationRefs: [],
    };
    // Internal candidate deliberately has no invented progress or successful verdict.
    const candidate = MdStageResultSchema.parse({
      ...seed,
      resultDigest: computeMdStageResultDigest(seed),
    });
    const inspector = new CanonicalAmberArtifactInspector({
      missionId: candidate.missionId,
      workUnitId: candidate.workUnitId,
      store: this.store,
      md: this.md,
      objects: this.input.objects,
      pythonExecutable: this.input.pythonExecutable,
    });
    const atomMap = await this.md.findAtomMapForSystem(
      candidate.missionId,
      system.id,
      system.revision,
      system.atomMapDigest,
    );
    const inspection = await inspector.inspectCollectedCandidate({
      result: candidate,
      atomMapId: atomMap.id,
      atomMapRevision: atomMap.revision,
    });
    const mdout = artifacts.find((a) => a.role === "mdout")!;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      (await this.readObject(mdout.contentDigest, 64 * 1024 ** 2)).bytes,
    );
    const parse = (result: MdStageResult) =>
      parseAmberMdTelemetry(text, {
        schemaVersion: "eigengrid.md-analysis-parse/v1",
        sourceKind: "mdout",
        missionId: result.missionId,
        source: mdout,
        stageResult: result,
        parserVersion: "1.0.0",
        executionCompletion: "confirmed",
        operationReceiptRef: result.operationReceiptId,
        exitCode: result.exitCode,
        signal: result.signal,
      });
    const telemetry = stage.kind === "minimization" ? null : parse(candidate);
    const min = inspection.outputs.find((o) => o.artifact.role === "mdout")?.minimization;
    const restart = inspection.outputs.find((o) => o.artifact.role === "restart")?.observation;
    const localStep =
      stage.kind === "minimization" ? min?.samples.at(-1)?.step : telemetry?.lastStep;
    if (
      localStep === undefined ||
      localStep === null ||
      !Number.isSafeInteger(localStep) ||
      localStep < 0 ||
      localStep > stage.steps ||
      !restart ||
      restart.readStatus !== "complete" ||
      restart.finiteValues !== true
    )
      throw new Error(
        "MD output lacks a verifiable observed endpoint; no fictitious StageResult can be admitted",
      );
    const endStep = parent.step + localStep,
      endTimePs = parent.timePs + (stage.timeStepPs ?? 0) * localStep;
    const diagnostics = [...inspection.diagnostics];
    let continuity = parent.verified;
    if (stage.kind !== "minimization") {
      continuity &&=
        restart.hasVelocities === true &&
        timeMatches(restart.time.lastPs, endTimePs, restart.time.precisionPs);
      if (
        telemetry?.lastTimePs === null ||
        !timeMatches(telemetry?.lastTimePs ?? null, endTimePs, 1e-8)
      )
        diagnostics.push("MDOUT time does not match observed step and parent time");
      if (localStep !== stage.steps)
        diagnostics.push("Engine did not complete its approved MD step count");
      if (!continuity)
        diagnostics.push("Restart velocities or absolute endpoint continuity is not verified");
      diagnostics.push(...trajectoryDiagnostics(stage, parent, endStep, inspection));
    }
    const normal =
      receipt.engine.exitCode === 0 &&
      receipt.engine.signal === null &&
      (stage.kind === "minimization"
        ? min?.status === "completed"
        : telemetry?.status === "completed");
    if (!normal) diagnostics.push("MDOUT does not demonstrate successful normal termination");
    const errors = diagnostics.map((message, i) => ({
      code: `a3_integrity_${i}`,
      severity: "error" as const,
      message,
      sourceEvidenceRefs: artifacts.map((a) => a.evidenceRef),
    }));
    const material = {
      ...seed,
      endStep,
      endTimePs,
      terminalReason: diagnostics.length ? ("validation_failure" as const) : ("completed" as const),
      errors,
      warnings: (telemetry?.diagnostics ?? [])
        .filter((d) => d.severity === "warning")
        .map((d) => ({
          code: d.code,
          severity: "warning" as const,
          message: d.message,
          sourceEvidenceRefs: d.evidenceRefs,
        })),
      validationStatus: diagnostics.length ? ("failed" as const) : ("passed" as const),
      validationRefs: [ids.validationId],
    };
    const result = MdStageResultSchema.parse({
      ...material,
      resultDigest: computeMdStageResultDigest(material),
    });
    const finalTelemetry = telemetry ? parse(result) : null;
    const evaluations = evaluateCollectedMdCriteria({
      stage,
      result,
      telemetry: finalTelemetry,
      normalTermination: normal,
      integrity: !diagnostics.length,
      continuity,
      evidenceId: ids.evidenceId,
    });
    const required = evaluations.filter((v) => v.required);
    const status =
      diagnostics.length || required.some((v) => v.status === "failed")
        ? ("rejected" as const)
        : required.some((v) => v.status !== "passed")
          ? ("indeterminate" as const)
          : ("accepted" as const);
    const recordedAt = collection.collectedAt;
    const unsigned = {
      schemaVersion: "eigengrid.md-assessment/v1" as const,
      id: ids.assessmentId,
      revision: 1,
      missionId: result.missionId,
      stageResultId: result.id,
      stageResultRevision: 1,
      stageResultDigest: result.resultDigest,
      status,
      evaluations,
      nextStageEligible: status === "accepted",
      limitations: [
        "Only predeclared implemented criteria; not publication, GPU or membrane convergence qualification",
      ],
      evidenceRefs: [ids.evidenceId],
      assessor: {
        id: "eigengrid.md-deterministic-evaluator.v1",
        kind: "service" as const,
        role: "deterministic_validator",
      },
      createdAt: recordedAt,
    };
    const assessment = MdStageAssessmentSchema.parse({
      ...unsigned,
      assessmentDigest: computeMdStageAssessmentDigest(unsigned),
    });
    const validation = {
      id: ids.validationId,
      missionId: result.missionId,
      workUnitId: result.workUnitId,
      // Persisted criterion identity from the first public release; retain for exact replay.
      criterionId: "a3-byte-integrity",
      status: result.validationStatus === "passed" ? ("passed" as const) : ("failed" as const),
      summary: diagnostics.length
        ? diagnostics.join("; ")
        : "Authenticated collection, exact immutable inputs and outputs, actual decoded time and atom identity",
      observationRefs: [ids.observationId],
      evidenceRefs: [ids.evidenceId],
      validatorVersion: "1.0.0",
      createdAt: recordedAt,
    };
    const report = {
      schemaVersion: "eigengrid.md-postprocessing-report/v1",
      source: "actual_canonical_collection_bytes",
      collectionDigest: digestCanonical(collection),
      result,
      assessment,
      validation,
      inspection,
      telemetry: finalTelemetry,
    };
    const object = await this.input.objects.put(Buffer.from(canonicalJson(report)));
    const output: MdStageFinalizationInput = {
      lease,
      collectionDigest: digestCanonical(collection),
      result,
      assessment,
      validation,
      inspectionEvidence: {
        id: ids.evidenceId,
        missionId: result.missionId,
        workUnitId: result.workUnitId,
        kind: "analysis_result",
        uri: object.uri,
        contentDigest: object.digest,
        sizeBytes: object.sizeBytes,
        mediaType: "application/vnd.eigengrid.md-postprocessing+json",
        immutable: true,
        sourceId: ids.analysisReceiptId,
        createdAt: recordedAt,
      },
      inspectionObservation: {
        id: ids.observationId,
        missionId: result.missionId,
        workUnitId: result.workUnitId,
        type: "artifact_integrity",
        payload: { reportDigest: object.digest, collectionDigest: digestCanonical(collection) },
        source: { kind: "validator", id: ids.analysisReceiptId },
        evidenceRefs: [ids.evidenceId],
        qualityFlags: ["not_replication_ack", "not_site_qualification"],
        observedAt: recordedAt,
      },
    };
    if (replica && result.validationStatus === "passed") {
      const trajectory = artifacts.find((a) => a.role === "trajectory")!,
        decoded = inspection.outputs.find((a) => a.artifact.role === "trajectory")!.observation!;
      const segment = {
        schemaVersion: "eigengrid.trajectory-segment/v1" as const,
        id: `segment-${digestCanonical({ operationId })}`,
        revision: 1,
        missionId: result.missionId,
        replicaId: replica.replicaId,
        stageResultId: result.id,
        segmentIndex: replica.segmentIndex,
        parentRestart: binding.parentRestart!,
        restart: artifacts.find((a) => a.role === "restart")!,
        trajectory,
        startStep: result.startStep,
        endStep,
        startTimePs: result.startTimePs,
        endTimePs,
        frameCount: decoded.frameCount!,
        netcdf: {
          convention: "AMBER",
          atomCount: decoded.atomCount!,
          frameCount: decoded.frameCount!,
          hasPeriodicBox: decoded.hasPeriodicBox!,
        },
        continuity: {
          status: "verified" as const,
          expectedParentRestartDigest: binding.parentRestart!.contentDigest,
          observedParentRestartDigest: binding.parentRestart!.contentDigest,
          expectedStartStep: parent.step,
          observedStartStep: parent.step,
          expectedStartTimePs: parent.timePs,
          observedStartTimePs: parent.timePs,
          reason:
            "Exact accepted parent restart, collector-verified unchanged engine inputs and decoded output times",
        },
        createdAt: recordedAt,
      };
      output.trajectorySegment = TrajectorySegmentSchema.parse({
        ...segment,
        segmentDigest: computeTrajectorySegmentDigest(segment),
      });
    }
    return output;
  }

  private async readObject(digest: string, limit: number) {
    await this.input.objects.verify(digest, { maxBytes: limit });
    return this.input.objects.get(digest);
  }

  private async parentInterval(
    binding: MdExecutionBindingParameters,
    stage: MdStageSpec,
    dependencies: string[],
    missionId: string,
  ) {
    if (!binding.parentRestart) {
      if (stage.parentStageId !== null)
        throw new Error("MD continuation has no bound parent restart");
      return { step: 0, timePs: 0, verified: true };
    }
    const provenance = await this.store.getMissionProvenance(missionId);
    const all = await this.md.stageResultsForWorkUnits(missionId, dependencies);
    const candidates = all.filter(
      (r) =>
        dependencies.includes(r.workUnitId) &&
        r.artifacts.some(
          (a) =>
            a.role === "restart" && digestCanonical(a) === digestCanonical(binding.parentRestart),
        ) &&
        r.validationStatus === "passed" &&
        r.terminalReason === "completed" &&
        r.errors.length === 0,
    );
    if (candidates.length !== 1)
      throw new Error("MD interval requires one exact accepted parent projection");
    const parent = candidates[0]!;
    if (!provenance.workUnits.some((w) => w.id === parent.workUnitId && w.state === "succeeded"))
      throw new Error("MD parent has not durably completed");
    await this.input.objects.verify(binding.parentRestart.contentDigest, {
      maxBytes: binding.parentRestart.sizeBytes,
    });
    return { step: parent.endStep, timePs: parent.endTimePs, verified: true };
  }
}

function trajectoryDiagnostics(
  stage: MdStageSpec,
  parent: { step: number; timePs: number },
  endStep: number,
  inspected: CanonicalAmberStageInspection,
): string[] {
  const errors: string[] = [];
  for (const output of inspected.outputs.filter((o) => o.artifact.role === "trajectory")) {
    const observation: AmberByteInspection | undefined = output.observation;
    const cadence = stage.outputs.find((o) => o.role === "trajectory")?.cadenceSteps;
    if (!cadence || !stage.timeStepPs || !observation) {
      errors.push("Missing exact trajectory cadence/byte observation");
      continue;
    }
    const frames = Math.floor((endStep - parent.step) / cadence),
      dt = cadence * stage.timeStepPs;
    if (
      frames < 1 ||
      observation.frameCount !== frames ||
      observation.time.count !== frames ||
      !timeMatches(observation.time.firstPs, parent.timePs + dt, observation.time.precisionPs) ||
      !timeMatches(
        observation.time.lastPs,
        parent.timePs + frames * dt,
        observation.time.precisionPs,
      ) ||
      (frames > 1 &&
        (!timeMatches(observation.time.minDeltaPs, dt, observation.time.precisionPs) ||
          !timeMatches(observation.time.maxDeltaPs, dt, observation.time.precisionPs)))
    )
      errors.push(
        "Decoded trajectory frame count/time differ from exact observed segment and approved cadence",
      );
  }
  return errors;
}
