import { z } from "zod";

const text = z.string().trim().min(1).max(4000);
const identifier = z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/);
export const PlanningQuestionsSchema = z
  .object({
    questions: z
      .array(
        z
          .object({
            id: identifier,
            question: text,
            options: z
              .array(
                z
                  .object({
                    label: z.string().trim().min(1).max(100),
                    description: z.string().trim().min(1).max(600),
                    recommended: z.boolean(),
                  })
                  .strict(),
              )
              .min(2)
              .max(3)
              .optional(),
            recommendationReason: z.string().trim().min(1).max(600).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(3),
  })
  .strict()
  .superRefine(({ questions }, ctx) => {
    if (new Set(questions.map((q) => q.id)).size !== questions.length)
      ctx.addIssue({ code: "custom", message: "Question IDs must be unique" });
    for (const q of questions) {
      const recommended = q.options?.filter((o) => o.recommended).length ?? 0;
      if (recommended > 1 || (recommended === 1 && !q.recommendationReason))
        ctx.addIssue({
          code: "custom",
          message: "At most one justified recommendation per question",
        });
      if (q.options && new Set(q.options.map((o) => o.label)).size !== q.options.length)
        ctx.addIssue({ code: "custom", message: "Options must be distinct" });
    }
  });
export type PlanningQuestions = z.infer<typeof PlanningQuestionsSchema>;
export type PlanningAnswers = Record<string, string>;
export type AskPlanningQuestions = (
  request: PlanningQuestions,
  signal?: AbortSignal,
) => Promise<PlanningAnswers | undefined>;

export const CampaignProposalSchema = z
  .object({
    objective: text,
    summary: text,
    assumptions: z.array(text).max(30),
    missingInputs: z.array(text).max(30),
    protocols: z
      .array(
        z
          .object({
            id: text,
            version: text,
            contentDigest: text,
            role: text,
            limitations: text,
          })
          .strict(),
      )
      .max(60),
    decisions: z
      .array(
        z
          .object({
            question: text,
            choice: text,
            rationale: text,
            alternatives: z.array(text).max(6),
          })
          .strict(),
      )
      .max(40),
    stages: z
      .array(
        z
          .object({
            id: identifier,
            title: text,
            description: text,
            dependsOn: z.array(identifier).max(30),
            protocolRefs: z.array(text).max(30),
            inputs: z.array(text).max(30),
            outputs: z.array(text).max(30),
            parameters: z.record(text).refine((v) => Object.keys(v).length <= 40),
            resources: text,
            acceptanceCriteria: z.array(text).min(1).max(20),
            onFailure: text,
          })
          .strict(),
      )
      .min(1)
      .max(40),
    environmentRequirements: z.array(text).min(1).max(30),
    successCriteria: z.array(text).min(1).max(30),
    risks: z.array(text).min(1).max(30),
    limitations: z.array(text).min(1).max(30),
  })
  .strict()
  .superRefine((proposal, ctx) => {
    const seen = new Set<string>();
    const refs = new Set(proposal.protocols.map((p) => `${p.id}@${p.version}`));
    for (const stage of proposal.stages) {
      if (seen.has(stage.id) || stage.dependsOn.some((id) => !seen.has(id)))
        ctx.addIssue({
          code: "custom",
          message: "Stages must have unique IDs and only depend on earlier stages",
        });
      if (stage.protocolRefs.some((id) => !refs.has(id)))
        ctx.addIssue({
          code: "custom",
          message: "Stage protocol reference is missing from the proposal",
        });
      seen.add(stage.id);
    }
    if (!proposal.protocols.length && !proposal.missingInputs.length)
      ctx.addIssue({
        code: "custom",
        message: "A proposal without protocols must identify the coverage gap",
      });
  });
export type CampaignProposal = z.infer<typeof CampaignProposalSchema>;

// Incremental construction stays within the configured per-response token cap.
const proposalFields = CampaignProposalSchema.innerType();
export const CampaignDraftUpdateSchema = z
  .object({
    overview: proposalFields.omit({ stages: true, decisions: true }).optional(),
    stage: proposalFields.shape.stages.element.optional(),
    decision: proposalFields.shape.decisions.element.optional(),
    save: z.boolean().default(false),
  })
  .strict()
  .refine(
    (update) => !!(update.overview || update.stage || update.decision || update.save),
    "Provide a draft section or request save",
  );

export function renderCampaignProposal(plan: CampaignProposal): string {
  const lines = [
    `# ${plan.objective}`,
    plan.summary,
    "## Assumptions",
    ...plan.assumptions.map((s) => `- ${s}`),
    "## Decisions",
    ...plan.decisions.flatMap((d) => [
      `- **${d.question}** ${d.choice}`,
      `  ${d.rationale}`,
      ...d.alternatives.map((a) => `  Alternative: ${a}`),
    ]),
    "## Protocol coverage",
    ...plan.protocols.map(
      (p) => `- ${p.id}@${p.version}: ${p.role}\n  ${p.limitations}\n  Digest: ${p.contentDigest}`,
    ),
    "## Campaign stages",
    ...plan.stages.flatMap((s, i) => [
      `### ${i + 1}. ${s.title} (${s.id})`,
      s.description,
      `Dependencies: ${s.dependsOn.join(", ") || "none"}`,
      `Protocols: ${s.protocolRefs.join(", ") || "coverage gap"}`,
      `Inputs: ${s.inputs.join("; ")}`,
      `Outputs: ${s.outputs.join("; ")}`,
      ...Object.entries(s.parameters).map(([k, v]) => `- ${k}: ${v}`),
      `Resources: ${s.resources}`,
      "Acceptance:",
      ...s.acceptanceCriteria.map((c) => `- ${c}`),
      `On failure: ${s.onFailure}`,
    ]),
    "## Environment",
    ...plan.environmentRequirements.map((s) => `- ${s}`),
    "## Success criteria",
    ...plan.successCriteria.map((s) => `- ${s}`),
    "## Risks",
    ...plan.risks.map((s) => `- ${s}`),
    "## Limitations",
    ...plan.limitations.map((s) => `- ${s}`),
    "## Still needed",
    ...(plan.missingInputs.length
      ? plan.missingInputs.map((s) => `- ${s}`)
      : [
          "No unresolved inputs reported; scientific review and execution authorization remain separate.",
        ]),
  ];
  return lines.join("\n\n");
}
