import type { EvidenceReference } from "./decisions";
import type { Sha256Digest } from "./digest";

export type PoseMethod = "imported" | "reference_pharmacophore" | "docking";

export interface PoseProviderRequest {
  readonly requestId: string;
  readonly expectedSystemRevision: number;
  readonly receptorRef: EvidenceReference;
  readonly ligandConformerRefs: readonly EvidenceReference[];
  readonly pocketDefinitionRef: EvidenceReference;
  readonly seed?: number;
  readonly maximumCandidates: number;
}

export interface PoseCandidate {
  readonly candidateId: string;
  readonly method: PoseMethod;
  readonly coordinateDigest: Sha256Digest;
  readonly atomMapDigest: Sha256Digest;
  readonly parentRefs: readonly EvidenceReference[];
  readonly scoreClaims: Readonly<Record<string, number>>;
  readonly warnings: readonly string[];
}

export interface PoseCandidateSet {
  readonly requestId: string;
  readonly providerId: string;
  readonly providerVersion: string;
  readonly candidates: readonly PoseCandidate[];
  readonly selectionRequiresApproval: true;
}

interface BasePoseProvider<TMethod extends PoseMethod> {
  readonly method: TMethod;
  readonly providerId: string;
  readonly providerVersion: string;
  propose(request: PoseProviderRequest): Promise<PoseCandidateSet>;
}

export interface ImportedPoseProvider extends BasePoseProvider<"imported"> {}

export interface ReferencePharmacophorePoseProvider extends BasePoseProvider<"reference_pharmacophore"> {}

/** Interface only. Implementations must use a separately authorized typed adapter. */
export interface DockingPoseProvider extends BasePoseProvider<"docking"> {}

export type PoseProvider =
  | ImportedPoseProvider
  | ReferencePharmacophorePoseProvider
  | DockingPoseProvider;

export type MembraneOrientationMethod = "opm" | "ppm" | "imported";

export interface MembraneOrientationRequest {
  readonly requestId: string;
  readonly expectedSystemRevision: number;
  readonly receptorRef: EvidenceReference;
  readonly method: MembraneOrientationMethod;
  readonly sourceEvidenceRefs: readonly EvidenceReference[];
}

export interface MembraneOrientationResult {
  readonly requestId: string;
  readonly method: MembraneOrientationMethod;
  readonly providerId: string;
  readonly providerVersion: string;
  readonly orientedCoordinateDigest: Sha256Digest;
  readonly orientationMetadataDigest: Sha256Digest;
  readonly hydrophobicThicknessAngstrom?: number;
  readonly warnings: readonly string[];
  readonly approvalRequired: true;
}

/** Interface only; OPM/PPM transport or local imports live behind typed implementations. */
export interface MembraneOrientationProvider {
  readonly method: MembraneOrientationMethod;
  readonly providerId: string;
  readonly providerVersion: string;
  orient(request: MembraneOrientationRequest): Promise<MembraneOrientationResult>;
}
