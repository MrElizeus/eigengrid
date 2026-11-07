import { z } from "zod";
import { ToolRegistry, type ToolContext } from "@eigengrid/tool-registry";
import type { AgentInput } from "@eigengrid/agent";
import type { CampaignProposal, PlanningQuestions } from "../planning-contracts";

export const protocolRef = {
  id: "test.amber-pilot",
  version: "1.0.0",
  contentDigest: "sha256:" + "a".repeat(64),
};
export const questions: PlanningQuestions = {
  questions: [
    {
      id: "temperature",
      question: "Which temperature should the pilot target?",
      options: [
        {
          label: "300 K",
          description: "Matches the stated reference experiment.",
          recommended: true,
        },
        {
          label: "310 K",
          description: "Tests a different condition and needs a separate comparison.",
          recommended: false,
        },
      ],
      recommendationReason: "The supplied reference experiment uses 300 K.",
    },
  ],
};
export const proposal: CampaignProposal = {
  objective: "A small AMBER pilot",
  summary: "A preparation and stability pilot; no affinity inference.",
  assumptions: ["The user supplies the target identity."],
  missingInputs: ["Verify the biological assembly and ligand state."],
  protocols: [
    {
      ...protocolRef,
      role: "Pilot design",
      limitations: "Synthetic test fixture; not scientific guidance.",
    },
  ],
  decisions: [
    {
      question: "Temperature",
      choice: "300 K",
      rationale: "User selected the reference condition.",
      alternatives: ["310 K for a different condition"],
    },
  ],
  stages: [
    {
      id: "pilot",
      title: "Verify inputs and run a bounded pilot",
      description: "Review the system before allocating compute.",
      dependsOn: [],
      protocolRefs: ["test.amber-pilot@1.0.0"],
      inputs: ["Verified structure and ligand"],
      outputs: ["Trajectory and diagnostics"],
      parameters: { temperature: "300 K; user selected" },
      resources: "Estimate only; benchmark after site verification.",
      acceptanceCriteria: ["No unresolved preparation diagnostics"],
      onFailure: "Stop and inspect evidence before changing parameters.",
    },
  ],
  environmentRequirements: ["Verify AMBER availability at execution time"],
  successCriteria: ["Traceable inputs and reviewable diagnostics"],
  risks: ["Pilot length is insufficient for convergence claims"],
  limitations: ["No execution has occurred"],
};

export function planningRuntime(paginated = false) {
  const registry = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
  registry.register({
    name: "list-protocols",
    description: "Fixture catalog",
    inputSchema: z.object({}),
    outputSchema: z.record(z.unknown()),
    async execute() {
      return { ok: true, data: { protocols: [protocolRef] } };
    },
  });
  registry.register({
    name: "inspect-protocol",
    description: "Fixture protocol",
    inputSchema: z.object({
      id: z.string(),
      corpusDigest: z.string().optional(),
      cursor: z.object({ fragment: z.number(), character: z.number() }).optional(),
    }),
    outputSchema: z.record(z.unknown()),
    async execute(_ctx, input: { id: string; cursor?: unknown }) {
      return {
        ok: true,
        data: {
          corpusDigest: "fixture-corpus",
          nextCursor: paginated && !input.cursor ? { fragment: 1, character: 0 } : null,
          resolvedSkills: [protocolRef],
          fragments: [{ content: "Synthetic protocol reference" }],
        },
      };
    },
  });
  let effects = 0;
  for (const name of ["run-command", "write-file", "submit-job", "cancel-job"])
    registry.register({
      name,
      description: "Forbidden effect",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      async execute() {
        effects++;
        return { ok: true, data: {} };
      },
    });
  return { registry, ctx: {} as ToolContext, effects: () => effects };
}

export function planningModel(script: (string | { name: string; input: unknown })[]) {
  const requests: unknown[] = [];
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const model = {
    specificationVersion: "v3",
    provider: "test",
    modelId: "scientific-planning-fixture",
    supportedUrls: {},
    async doStream(request: unknown) {
      const step = script[requests.length];
      requests.push(request);
      if (!step) throw new Error("Unexpected planning model call");
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if (typeof step === "string") {
              controller.enqueue({ type: "text-start", id: "response" });
              controller.enqueue({ type: "text-delta", id: "response", delta: step });
              controller.enqueue({ type: "text-end", id: "response" });
            } else
              controller.enqueue({
                type: "tool-call",
                toolCallId: `call-${requests.length}`,
                toolName: step.name,
                input: JSON.stringify(step.input),
              });
            controller.enqueue({
              type: "finish",
              finishReason: {
                unified: typeof step === "string" ? "stop" : "tool-calls",
                raw: "stop",
              },
              usage,
            });
            controller.close();
          },
        }),
      };
    },
  } as unknown as NonNullable<AgentInput["model"]>;
  return { model, requests };
}
export const planSteps = () => [
  { name: "list-protocols", input: {} },
  { name: "inspect-protocol", input: { id: protocolRef.id } },
  { name: "save-campaign-plan", input: proposal },
  "The proposed pilot is ready for review.",
];
