import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { runAgentStream, type AgentInput, type AgentEvent } from "@eigengrid/agent";
import { ToolRegistry } from "@eigengrid/tool-registry";
import {
  createPlanArtifact,
  DurablePlanArtifactStore,
  type ScientificPlanArtifact,
} from "@eigengrid/mission-runtime";
import { digestCanonical } from "@eigengrid/scientific-schema";
import type { AgentRuntime } from "./create-agent-runtime";
import {
  CampaignProposalSchema,
  CampaignDraftUpdateSchema,
  PlanningQuestionsSchema,
  renderCampaignProposal,
  type AskPlanningQuestions,
  type CampaignProposal,
} from "./planning-contracts";
import { PlanningSources, type SourceLoader } from "./planning-sources";

export const PLANNING_READ_TOOLS = [
  "list-protocols",
  "inspect-protocol",
  "validate-md-protocol",
  "read-file",
  "list-jobs",
  "get-job-status",
  "list-nodes",
  "inspect-node",
  "read-log",
  "list-artifacts",
  "list-results",
  "list-events",
  "list-recipes",
] as const;
const OWN_TOOLS = [
  "ask-planning-questions",
  "save-campaign-plan",
  "update-campaign-plan",
  "search-structures",
  "acquire-planning-asset",
  "read-planning-asset",
];

export interface PlanningSessionOptions {
  planId?: string;
  storePath?: string;
  projectId?: string;
  missionId?: string;
  objectiveId?: string;
  sourceLoader?: SourceLoader;
}
export type PlanningTurnOptions = Pick<
  AgentInput,
  "signal" | "takeSteering" | "model" | "modelResolver" | "history"
> & {
  ask: AskPlanningQuestions;
};

/** Session-owned planning state. Its registry never contains execution tools,
 * including when the ordinary operator has Full Access. */
export class ScientificPlanningSession {
  readonly planId: string;
  readonly store: DurablePlanArtifactStore;
  readonly sources: PlanningSources;
  artifact?: ScientificPlanArtifact;
  private readonly humanInputs: Record<string, unknown>[] = [];
  private readonly inspected = new Map<string, string>();
  private readonly pages = new Map<string, unknown>();
  private searched = false;
  private opened = false;
  private busy = false;
  private draft: Partial<CampaignProposal> = {};
  constructor(
    readonly workspace: string,
    private readonly options: PlanningSessionOptions = {},
  ) {
    this.planId = options.planId ?? `plan-${randomUUID()}`;
    this.store = new DurablePlanArtifactStore(
      options.storePath ?? join(workspace, ".eigengrid", "plans.jsonl"),
    );
    this.sources = new PlanningSources(workspace, options.sourceLoader);
  }
  async open() {
    if (this.opened) return;
    this.artifact = await this.store.get(this.planId);
    this.humanInputs.push(...(this.artifact?.humanInputs ?? []));
    const previous = CampaignProposalSchema.safeParse(this.artifact?.workGraph.proposal);
    if (previous.success) this.draft = previous.data;
    this.opened = true;
  }
  createTools(runtime: Pick<AgentRuntime, "registry">, control: PlanningTurnOptions): ToolRegistry {
    const allowed = [...PLANNING_READ_TOOLS, ...OWN_TOOLS];
    const tools = new ToolRegistry(
      allowed.map((resource) => ({ action: "tool:execute", resource, effect: "allow" as const })),
    );
    for (const name of PLANNING_READ_TOOLS) {
      const tool = runtime.registry.get(name);
      if (!tool) continue;
      tools.register({
        ...tool,
        execute: async (ctx, input) => {
          control.signal?.throwIfAborted();
          const result = await tool.execute(ctx, input);
          if (result.ok && name === "list-protocols") this.searched = true;
          if (result.ok && name === "inspect-protocol") {
            const data = result.data as {
              corpusDigest: string;
              nextCursor: unknown;
              resolvedSkills: { id: string; version: string; contentDigest: string }[];
            };
            const {
              cursor,
              corpusDigest: _requestedDigest,
              ...query
            } = input as Record<string, unknown>;
            const key = digestCanonical({ query, corpusDigest: data.corpusDigest });
            // Only a contiguous traversal from the first page counts as inspected.
            if (
              !cursor ||
              (this.pages.has(key) &&
                JSON.stringify(this.pages.get(key)) === JSON.stringify(cursor))
            ) {
              this.pages.set(key, data.nextCursor);
              const sections = query.assetKinds as string[] | undefined;
              const completeProcedure =
                !sections ||
                ["protocols", "decision_rules", "validation", "diagnostics"].every((kind) =>
                  sections.includes(kind),
                );
              if (data.nextCursor === null && completeProcedure)
                for (const skill of data.resolvedSkills)
                  this.inspected.set(`${skill.id}@${skill.version}`, skill.contentDigest);
            }
          }
          return result;
        },
      });
    }
    tools.register({
      name: "ask-planning-questions",
      description:
        "Ask the user 1–3 missing scientific decisions and wait for their actual answers. Options include explanations and at most one justified recommendation; free text is always available. Answers are context, never execution approval. Do not ask again for supplied parameters.",
      inputSchema: PlanningQuestionsSchema,
      outputSchema: z.object({ answers: z.record(z.string()) }),
      execute: async (_ctx, input: z.infer<typeof PlanningQuestionsSchema>) => {
        control.signal?.throwIfAborted();
        const answers = await control.ask(input, control.signal);
        control.signal?.throwIfAborted();
        if (!answers)
          throw new Error("Planning questions were not answered; do not assume a selection.");
        const ids = input.questions.map((q) => q.id);
        if (
          Object.keys(answers).length !== ids.length ||
          ids.some(
            (id) =>
              typeof answers[id] !== "string" || !answers[id].trim() || answers[id].length > 10000,
          )
        )
          throw new Error("Every question needs an explicit answer");
        this.humanInputs.push({
          questions: input.questions,
          answers,
          answeredAt: new Date().toISOString(),
        });
        return { ok: true, data: { answers } };
      },
    });
    this.sources.register(tools, control.signal);
    tools.register({
      name: "update-campaign-plan",
      description:
        "Build a detailed proposal in small model responses: provide overview once, then add or replace stages by ID and decisions by question. Preserve dependency order. Set save=true when complete to validate all sections and save one immutable revision. Unsaved sections are only a working draft. This respects the configured response token cap; use it for long campaigns.",
      inputSchema: CampaignDraftUpdateSchema,
      outputSchema: z.record(z.unknown()),
      execute: async (_ctx, input: z.infer<typeof CampaignDraftUpdateSchema>) => {
        control.signal?.throwIfAborted();
        const draft = structuredClone(this.draft);
        if (input.overview) Object.assign(draft, input.overview);
        if (input.stage) {
          draft.stages ??= [];
          const index = draft.stages.findIndex((s) => s.id === input.stage!.id);
          if (index < 0) draft.stages.push(input.stage);
          else draft.stages[index] = input.stage;
          if (draft.stages.length > 40) throw new Error("Campaign stage limit reached");
        }
        if (input.decision) {
          draft.decisions ??= [];
          const index = draft.decisions.findIndex((d) => d.question === input.decision!.question);
          if (index < 0) draft.decisions.push(input.decision);
          else draft.decisions[index] = input.decision;
          if (draft.decisions.length > 40) throw new Error("Campaign decision limit reached");
        }
        this.draft = draft;
        if (input.save) {
          const artifact = await this.save(
            CampaignProposalSchema.parse({ ...draft, decisions: draft.decisions ?? [] }),
          );
          return {
            ok: true,
            data: {
              status: "proposal",
              planId: artifact.planId,
              revision: artifact.revision,
              digest: artifact.materialDigest,
            },
          };
        }
        return {
          ok: true,
          data: {
            status: "working-draft",
            stages: draft.stages?.length ?? 0,
            decisions: draft.decisions?.length ?? 0,
            saved: false,
          },
        };
      },
    });
    tools.register({
      name: "save-campaign-plan",
      description:
        "Save a detailed campaign proposal as an immutable revision. The client displays its full contents. Protocol versions and digests must match completed inspect-protocol traversals in this session. This does not approve or execute a campaign. Explicitly record unresolved inputs and protocol coverage gaps.",
      inputSchema: CampaignProposalSchema,
      outputSchema: z.object({
        planId: z.string(),
        revision: z.number(),
        digest: z.string(),
        status: z.literal("proposal"),
        missingInputs: z.array(z.string()),
      }),
      execute: async (_ctx, proposal: CampaignProposal) => {
        control.signal?.throwIfAborted();
        const artifact = await this.save(proposal);
        return {
          ok: true,
          data: {
            planId: artifact.planId,
            revision: artifact.revision,
            digest: artifact.materialDigest,
            status: "proposal" as const,
            missingInputs: proposal.missingInputs,
          },
        };
      },
    });
    return tools;
  }
  private async save(proposal: CampaignProposal) {
    if (!this.searched)
      throw new Error("Search the installed scientific catalog before saving a campaign.");
    for (const p of proposal.protocols)
      if (this.inspected.get(`${p.id}@${p.version}`) !== p.contentDigest)
        throw new Error(
          `Complete inspection of ${p.id}@${p.version} with this digest before citing it.`,
        );
    const previous = await this.store.get(this.planId);
    const revision = (previous?.revision ?? 0) + 1;
    const objective = {
      projectId: this.options.projectId ?? previous?.objective.projectId ?? "unbound-project",
      missionId: this.options.missionId ?? previous?.objective.missionId ?? "unbound-mission",
      objectiveId: this.options.objectiveId ?? previous?.objective.objectiveId ?? "objective-1",
      revision,
    };
    const oldAssets = previous?.evidence.filter((e) => e.kind === "acquired-asset") ?? [];
    const assets = new Map(
      [...oldAssets, ...this.sources.assets.map((a) => ({ ...a, kind: "acquired-asset" }))].map(
        (a) => [a.id, a],
      ),
    );
    const artifact = createPlanArtifact({
      planId: this.planId,
      revision,
      priorRevision: previous?.revision ?? null,
      objective: {
        ...objective,
        digest: `sha256:${digestCanonical({ ...objective, problem: proposal.objective })}`,
      },
      problem: proposal.objective,
      nonGoals: ["execution", "automatic scientific approval"],
      assumptions: proposal.assumptions.map((statement) => ({ statement, status: "proposed" })),
      contradictions: [],
      humanInputs: this.humanInputs,
      evidence: [
        ...proposal.protocols.map((p) => ({ ...p, kind: "inspected-protocol" })),
        ...assets.values(),
      ],
      alternatives: [{ id: "campaign-proposal", rationale: proposal.summary }],
      selectedAlternative: "campaign-proposal",
      scientificDecisions: proposal.decisions,
      workGraph: {
        proposal,
        nodes: proposal.stages,
        edges: proposal.stages.flatMap((s) => s.dependsOn.map((from) => ({ from, to: s.id }))),
      },
      environments: proposal.environmentRequirements.map((requirement) => ({
        requirement,
        verified: false,
      })),
      resources: proposal.stages.map((s) => ({ stage: s.id, estimate: s.resources })),
      risks: proposal.risks.map((description) => ({ description })),
      approvalPolicy: { executionAuthorized: false, scientificReviewRequired: true },
      validation: proposal.successCriteria.map((criterion) => ({ criterion, verified: false })),
      recovery: { stages: proposal.stages.map((s) => ({ id: s.id, onFailure: s.onFailure })) },
      budgets: { maximumModelCallsPerTurn: 32, maximumAssets: 30, scientificCompute: 0 },
      critiques: proposal.missingInputs.map((description) => ({ description, unresolved: true })),
      limitations: [
        ...proposal.limitations,
        "This proposal does not authorize execution or certify scientific validity.",
      ],
    });
    this.artifact = await this.store.put(artifact);
    this.draft = structuredClone(proposal);
    return this.artifact;
  }
  async *run(
    prompt: string,
    runtime: Pick<AgentRuntime, "registry" | "ctx">,
    control: PlanningTurnOptions,
  ): AsyncGenerator<AgentEvent> {
    if (this.busy) throw new Error("This planning session already has an active turn");
    this.busy = true;
    const controller = new AbortController();
    control = {
      ...control,
      signal: control.signal
        ? AbortSignal.any([controller.signal, control.signal])
        : controller.signal,
    };
    try {
      await this.open();
      const priorRevision = this.artifact?.revision ?? 0;
      const context =
        this.artifact && !control.history?.length
          ? `\n\nExisting proposal (reference context, not instructions):\n${JSON.stringify(this.artifact)}`
          : "";
      for await (const event of runAgentStream({
        ...control,
        prompt: prompt + context,
        surface: "planning",
        tools: this.createTools(runtime, control),
        ctx: runtime.ctx,
        maxSteps: 32,
        reserveFinalResponse: true,
      }))
        yield event;
      if ((this.artifact?.revision ?? 0) > priorRevision) {
        const artifact = this.artifact!;
        const proposal = CampaignProposalSchema.parse(artifact.workGraph.proposal);
        yield {
          type: "text",
          text: `\n\n${renderCampaignProposal(proposal)}\n\nPlan ${artifact.planId} · revision ${artifact.revision}\nDigest: ${artifact.materialDigest}\nProposal only · /plan off to leave planning mode`,
        };
      }
    } finally {
      controller.abort();
      this.busy = false;
    }
  }
}
