/** Compatibility facade for typed mission services. Domain repositories own each
 * operation's transaction; forwarding never opens a nested transaction. */
import {
  type AtomMap,
  type BiomolecularSystemManifest,
  type ForceFieldStackManifest,
  type MdMetricSeries,
  type MdStageResult,
  type MdStageSpec,
  type MdWorkflowProtocol,
  type ReplicaSet,
  type TrajectorySegment,
} from "@eigengrid/scientific-schema";
import type { ContentAddressedArtifactStore } from "./content-addressed-store";
import { MdMaterialStore } from "./md-material-store";
import { MdProtocolStore } from "./md-protocol-store";
import { MdResultStore } from "./md-result-store";
import { MdStoreContext } from "./md-store-context";
import {
  BiomolecularDecision,
  BiomolecularMaterialPublicationAuthority,
  MdAssessment,
} from "./md-store-validation";
import type { ScientificDatabase } from "./types";

export {
  MdStageAssessmentOperationRequestSchemaVersion,
  assertBiomolecularSystemDecisionAuthority,
  assertMdStageOperationRequestAuthority,
  computeBiomolecularDecisionMaterialDigest,
  computeMdProtocolMaterialDigest,
  computeMdReplicaSetPayloadDigest,
  createMdStageAssessmentOperationRequest,
  workUnitUsesMdExecutionBinding,
} from "./md-store-validation";
export type {
  BiomolecularMaterialPublicationAuthority,
  CompleteMdWorkUnitAuthority,
  MdStageAssessmentOperationRequest,
} from "./md-store-validation";
export { resolveMdSubjectSnapshot, transitionReviewedMdSubject } from "./md-subjects";
export {
  assertMdWorkUnitProjectionBinding,
  assertSystemBuildWorkUnitProjection,
  isCompletedMaterialPhaseDependency,
} from "./md-work-unit-binding";
export {
  assertMdWorkUnitProjectionDependencies,
  persistMdWorkUnitCompletionGate,
} from "./md-work-unit-completion";
export class MdProjectionStore {
  private readonly materials: MdMaterialStore;
  private readonly results: MdResultStore;
  private readonly protocols: MdProtocolStore;
  constructor(database: ScientificDatabase, artifactStore?: ContentAddressedArtifactStore) {
    const context = new MdStoreContext(database, artifactStore);
    this.materials = new MdMaterialStore(context);
    this.results = new MdResultStore(context);
    this.protocols = new MdProtocolStore(context);
  }

  async putBiomolecularDecision(input: BiomolecularDecision): Promise<BiomolecularDecision> {
    return this.materials.putBiomolecularDecision(input);
  }

  async getBiomolecularDecision(
    id: string,
    revision: number,
  ): Promise<BiomolecularDecision | null> {
    return this.materials.getBiomolecularDecision(id, revision);
  }

  async putForceFieldStack(
    input: ForceFieldStackManifest,
    authority: BiomolecularMaterialPublicationAuthority,
  ): Promise<ForceFieldStackManifest> {
    return this.materials.putForceFieldStack(input, authority);
  }

  async getForceFieldStack(
    missionId: string,
    id: string,
    revision: number,
  ): Promise<ForceFieldStackManifest | null> {
    return this.materials.getForceFieldStack(missionId, id, revision);
  }

  async putSystemManifest(input: BiomolecularSystemManifest): Promise<BiomolecularSystemManifest> {
    return this.materials.putSystemManifest(input);
  }

  async getSystemManifest(
    id: string,
    revision: number,
  ): Promise<BiomolecularSystemManifest | null> {
    return this.materials.getSystemManifest(id, revision);
  }

  async putAtomMap(
    input: AtomMap,
    authority: BiomolecularMaterialPublicationAuthority,
  ): Promise<AtomMap> {
    return this.materials.putAtomMap(input, authority);
  }

  /** Resolve the unique already-published AtomMap, never a caller-invented ID. */
  async findAtomMapForSystem(
    missionId: string,
    systemId: string,
    systemRevision: number,
    mapDigest: string,
  ): Promise<AtomMap> {
    return this.materials.findAtomMapForSystem(missionId, systemId, systemRevision, mapDigest);
  }

  async stageResultsForWorkUnits(
    missionId: string,
    workUnitIds: string[],
  ): Promise<MdStageResult[]> {
    return this.results.stageResultsForWorkUnits(missionId, workUnitIds);
  }

  async getAtomMap(missionId: string, id: string, revision: number): Promise<AtomMap | null> {
    return this.materials.getAtomMap(missionId, id, revision);
  }

  async putProtocol(
    input: MdWorkflowProtocol,
    context: { planId: string; planVersion: number },
  ): Promise<MdWorkflowProtocol> {
    return this.protocols.putProtocol(input, context);
  }

  async getProtocol(id: string, revision: number): Promise<MdWorkflowProtocol | null> {
    return this.protocols.getProtocol(id, revision);
  }

  async getStageSpec(id: string, revision: number): Promise<MdStageSpec | null> {
    return this.protocols.getStageSpec(id, revision);
  }

  async putReplicaSet(input: ReplicaSet): Promise<ReplicaSet> {
    return this.protocols.putReplicaSet(input);
  }

  async getReplicaSet(id: string, revision: number): Promise<ReplicaSet | null> {
    return this.protocols.getReplicaSet(id, revision);
  }

  async putStageResult(input: MdStageResult): Promise<MdStageResult> {
    return this.results.putStageResult(input);
  }

  async getStageResult(id: string): Promise<MdStageResult | null> {
    return this.results.getStageResult(id);
  }

  async putTrajectorySegment(input: TrajectorySegment): Promise<TrajectorySegment> {
    return this.results.putTrajectorySegment(input);
  }

  async putMetricSeries(missionId: string, input: MdMetricSeries): Promise<MdMetricSeries> {
    return this.results.putMetricSeries(missionId, input);
  }

  async putAssessment(
    input: MdAssessment,
    context: { operationId: string; operationReceiptId: string; subjectRevision: number },
  ): Promise<MdAssessment> {
    return this.results.putAssessment(input, context);
  }

  async getAssessment(id: string, revision: number): Promise<MdAssessment | null> {
    return this.results.getAssessment(id, revision);
  }
}
