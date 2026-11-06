import { MdStageSkillBindingSchema } from "@eigengrid/scientific-agent";
import {
  BiomolecularDecisionReferenceSchema,
  BiomolecularSystemManifestSchema,
  DigestSchema,
  EvidenceReferenceSchema,
  MdWorkflowProtocolSchema,
  MissionBudgetSchema,
  ScientificDecisionSchema,
  ScientificMissionSchema,
  ScientificPlanSchema,
  digestCanonical,
  type ModelInvocationIntent,
} from "@eigengrid/scientific-schema";
import { z } from "zod";

export const MissionCandidateSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.mission-candidate/v1"),
    plan: ScientificPlanSchema,
    decisions: z.array(ScientificDecisionSchema),
    evidence: z.array(EvidenceReferenceSchema),
    md: z
      .object({
        system: BiomolecularSystemManifestSchema,
        protocol: MdWorkflowProtocolSchema,
        decisionRefs: z.array(BiomolecularDecisionReferenceSchema),
        stageSkillBindings: z.array(MdStageSkillBindingSchema),
      })
      .strict()
      .optional(),
    candidateDigest: DigestSchema,
  })
  .strict();

export type MissionCandidate = z.infer<typeof MissionCandidateSchema>;

export function computeMissionCandidateDigest(
  candidate: Omit<MissionCandidate, "candidateDigest"> | MissionCandidate,
): string {
  const { candidateDigest: _digest, ...material } = candidate as MissionCandidate;
  return digestCanonical(material);
}

export const Address = z
  .object({ projectId: z.string().min(1), missionId: z.string().min(1) })
  .strict();

export const PlanAddress = Address.extend({ planId: z.string().min(1) }).strict();

export const ExactCandidate = PlanAddress.extend({ candidateDigest: DigestSchema }).strict();

export const Create = z
  .object({
    projectId: z.string().min(1),
    mission: ScientificMissionSchema.omit({ requestedBy: true, policyProfile: true }).strict(),
    budget: MissionBudgetSchema,
    objectiveEvidence: z.array(EvidenceReferenceSchema).min(1),
  })
  .strict();

export const Import = Address.extend({
  candidate: MissionCandidateSchema,
  expectedCandidateDigest: DigestSchema,
  approvalExpiresAt: z.string().datetime().optional(),
}).strict();

export const ReplanUnstarted = ExactCandidate.extend({ reason: z.string().trim().min(1) }).strict();

export const Cancel = Address.extend({
  schemaVersion: z.literal("eigengrid.mission-cancel/v1"),
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2048),
}).strict();

export const AgentInferenceAdmission = Address.extend({
  sessionId: z.string().uuid(),
  step: z.number().int().positive().safe(),
  requestDigest: DigestSchema,
  contextDigest: DigestSchema,
  provider: z.string().min(1).max(256),
  model: z.string().min(1).max(256),
  maximumInputTokens: z.number().int().positive().safe(),
  maximumOutputTokens: z.number().int().positive().safe(),
  maximumCost: z.number().finite().nonnegative(),
  timeoutMilliseconds: z.number().int().positive().safe(),
}).strict();

export interface AgentInferenceLease {
  readonly intent: ModelInvocationIntent;
  readonly remainingBudget: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cost: number;
  };
}

export const Approve = ExactCandidate.extend({
  approvalRequestId: z.string().min(1),
  subjectVersion: z.number().int().positive(),
  subjectRevision: z.number().int().positive(),
  payloadDigest: DigestSchema,
  policyDigest: DigestSchema,
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().min(1),
}).strict();
