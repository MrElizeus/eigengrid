/**
 * Provenance levels carried by agent context. These labels describe where a
 * value came from; they never grant permission to mutate tools or policy.
 */
export const AgentAuthorityLevel = {
  SYSTEM_POLICY: "SYSTEM_POLICY",
  CANONICAL_SKILL: "CANONICAL_SKILL",
  AUTHENTICATED_EVIDENCE: "AUTHENTICATED_EVIDENCE",
  OPERATOR_MESSAGE: "OPERATOR_MESSAGE",
  RETRIEVED_MEMORY: "RETRIEVED_MEMORY",
  MODEL_OUTPUT: "MODEL_OUTPUT",
} as const;

export type AgentAuthorityLevel = (typeof AgentAuthorityLevel)[keyof typeof AgentAuthorityLevel];

export interface AgentContextBlock {
  readonly authority: AgentAuthorityLevel;
  readonly source: "canonical-skill" | "retrieved-memory";
  readonly name: string;
  readonly content: string;
}
