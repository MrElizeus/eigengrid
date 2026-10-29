import { parseSha256Digest, type Sha256Digest } from "./digest";

export interface EvidenceReference {
  readonly evidenceId: string;
  readonly digest: Sha256Digest;
}

export interface ScientificProposal<TKind extends string, TPayload> {
  readonly proposalId: string;
  readonly revision: number;
  readonly kind: TKind;
  readonly status: "proposed";
  readonly approvalRequired: true;
  readonly evidenceRefs: readonly EvidenceReference[];
  readonly rationale: string;
  readonly alternatives: readonly string[];
  readonly warnings: readonly string[];
  readonly payload: Readonly<TPayload>;
}

export interface ScientificDecision<TKind extends string> {
  readonly decisionId: string;
  readonly proposalId: string;
  readonly expectedProposalRevision: number;
  readonly kind: TKind;
  readonly disposition: "approved" | "rejected" | "changes_requested";
  readonly actorRef: string;
  readonly decidedAt: string;
  readonly evidenceRefs: readonly EvidenceReference[];
  readonly comment?: string;
}

export interface ConstructComponentPolicy {
  readonly componentId: string;
  readonly action: "preserve" | "remove" | "restore";
  readonly reason: string;
}

export interface ConstructPolicy {
  readonly sourceConstructRef: EvidenceReference;
  readonly components: readonly ConstructComponentPolicy[];
  readonly mutations: readonly {
    readonly chainId: string;
    readonly sequenceNumber: string;
    readonly observedResidue: string;
    readonly proposedResidue: string;
    readonly action: "preserve" | "restore";
    readonly reason: string;
  }[];
  readonly gaps: readonly {
    readonly chainId: string;
    readonly start: string;
    readonly end: string;
    readonly action: "model" | "cap" | "leave_unresolved";
    readonly reason: string;
  }[];
  readonly termini: readonly {
    readonly chainId: string;
    readonly terminus: "n" | "c";
    readonly action: "preserve" | "cap" | "restore";
    readonly reason: string;
  }[];
}

export type ConstructPolicyProposal = ScientificProposal<"construct_policy", ConstructPolicy>;
export type ConstructPolicyDecision = ScientificDecision<"construct_policy">;

export interface ProtonationSiteProposal {
  readonly componentId: string;
  readonly siteId: string;
  readonly proposedState: string;
  readonly alternatives: readonly string[];
  readonly confidence: "low" | "medium" | "high";
  readonly rationale: string;
}

export interface ProtonationPlan {
  readonly targetPH: number;
  readonly method: string;
  readonly methodVersion: string;
  readonly sites: readonly ProtonationSiteProposal[];
  readonly totalChargeCandidates: readonly number[];
}

export type ProtonationPlanProposal = ScientificProposal<"protonation_plan", ProtonationPlan>;
export type ProtonationPlanDecision = ScientificDecision<"protonation_plan">;

export interface MicrostateCandidate {
  readonly microstateId: string;
  readonly representation: string;
  readonly formalCharge: number;
  readonly rank?: number;
  readonly estimatedPopulation?: number;
  readonly uncertainty: string;
  readonly evidenceRefs: readonly EvidenceReference[];
}

export interface MicrostatePlan {
  readonly componentId: string;
  readonly targetPH: number;
  readonly candidates: readonly MicrostateCandidate[];
  readonly recommendedMicrostateId?: string;
}

export type MicrostatePlanProposal = ScientificProposal<"microstate_plan", MicrostatePlan>;
export type MicrostatePlanDecision = ScientificDecision<"microstate_plan">;

export interface ConformerGenerationSpec {
  readonly componentId: string;
  readonly algorithm: string;
  readonly software: string;
  readonly softwareVersion: string;
  readonly seed: number;
  readonly requestedConformerCount: number;
  readonly inputMicrostateRef: EvidenceReference;
}

export function validateConformerGenerationSpec(spec: ConformerGenerationSpec): readonly string[] {
  const errors: string[] = [];
  if (spec.componentId.trim() === "") errors.push("componentId must not be empty");
  if (spec.algorithm.trim() === "") errors.push("algorithm must not be empty");
  if (spec.software.trim() === "" || spec.softwareVersion.trim() === "") {
    errors.push("software and softwareVersion must be explicit");
  }
  if (!Number.isSafeInteger(spec.seed)) errors.push("seed must be a safe integer");
  if (!Number.isSafeInteger(spec.requestedConformerCount) || spec.requestedConformerCount < 1) {
    errors.push("requestedConformerCount must be a positive integer");
  }
  return errors;
}

export function createScientificProposal<TKind extends string, TPayload>(input: {
  readonly proposalId: string;
  readonly revision: number;
  readonly kind: TKind;
  readonly evidenceRefs: readonly { readonly evidenceId: string; readonly digest: string }[];
  readonly rationale: string;
  readonly alternatives?: readonly string[];
  readonly warnings?: readonly string[];
  readonly payload: TPayload;
}): ScientificProposal<TKind, TPayload> {
  if (input.proposalId.trim() === "") throw new TypeError("proposalId must not be empty");
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new TypeError("proposal revision must be a positive integer");
  }
  if (input.rationale.trim() === "") throw new TypeError("proposal rationale must not be empty");
  const evidenceRefs = input.evidenceRefs.map((reference) => {
    if (reference.evidenceId.trim() === "") throw new TypeError("evidenceId must not be empty");
    return { evidenceId: reference.evidenceId, digest: parseSha256Digest(reference.digest) };
  });
  return {
    proposalId: input.proposalId,
    revision: input.revision,
    kind: input.kind,
    status: "proposed",
    approvalRequired: true,
    evidenceRefs,
    rationale: input.rationale,
    alternatives: [...(input.alternatives ?? [])],
    warnings: [...(input.warnings ?? [])],
    payload: input.payload,
  };
}
