import { createInterface } from "node:readline/promises";
import type { CommandModule } from "yargs";
import { configureLlm, loadLlmConfig, type AgentInput } from "@eigengrid/agent";
import type { ScientificPlanArtifact } from "@eigengrid/mission-runtime";
import { createAgentRuntime, type AgentRuntime } from "../agent/create-agent-runtime";
import { ScientificPlanningSession } from "../agent/scientific-planning";
import type { AskPlanningQuestions, PlanningQuestions } from "../agent/planning-contracts";

export interface PlanArgs {
  objective: string;
  "mission-id"?: string;
  "project-id"?: string;
  "objective-id"?: string;
  "plan-id"?: string;
  json?: boolean;
  "store-path"?: string;
}
export interface PlanResult {
  status: "proposal" | "needs-input" | "incomplete";
  response: string;
  artifact?: ScientificPlanArtifact;
  questions?: PlanningQuestions;
}
export interface PlanDependencies {
  runtime?: Pick<AgentRuntime, "registry" | "ctx">;
  model?: AgentInput["model"];
  ask?: AskPlanningQuestions;
  signal?: AbortSignal;
}

export const planCommand: CommandModule = {
  command: "plan <objective>",
  describe: "Research and propose a scientific campaign with the configured model",
  builder: (y) =>
    y
      .positional("objective", {
        type: "string",
        demandOption: true,
        describe: "Scientific objective and known inputs",
      })
      .option("mission-id", { type: "string", describe: "Exact mission identity" })
      .option("project-id", { type: "string", describe: "Project identity" })
      .option("objective-id", { type: "string", describe: "Objective identity" })
      .option("plan-id", { type: "string", describe: "Revise an existing plan" })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "Return proposal or unanswered questions as JSON without interactive prompts",
      })
      .option("store-path", {
        type: "string",
        describe: "Plan journal (defaults to .eigengrid/plans.jsonl)",
      }),
  async handler(argv) {
    const args = argv as unknown as PlanArgs;
    const saved = loadLlmConfig();
    if (saved) configureLlm(saved);
    const result = await runPlan(args, process.cwd(), {
      ask: !args.json && process.stdin.isTTY ? askInTerminal : undefined,
    });
    // Preserve the published ScientificPlanArtifact JSON shape on success.
    if (args.json)
      console.log(JSON.stringify(result.status === "proposal" ? result.artifact : result, null, 2));
    else {
      console.log(result.response || "The planner did not produce a saved proposal.");
      if (result.questions) console.log(JSON.stringify(result.questions, null, 2));
    }
    if (result.status !== "proposal") process.exitCode = 2;
  },
};

const askInTerminal: AskPlanningQuestions = async (request, signal) => {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const answers: Record<string, string> = {};
  try {
    for (const q of request.questions) {
      console.log(`\n${q.question}`);
      const options = [...(q.options ?? [])].sort(
        (a, b) => Number(b.recommended) - Number(a.recommended),
      );
      options.forEach((o, i) =>
        console.log(
          `${i + 1}. ${o.label}${o.recommended ? " (Recommended)" : ""}\n   ${o.description}`,
        ),
      );
      if (q.recommendationReason) console.log(`Recommendation: ${q.recommendationReason}`);
      let answer = "";
      while (!answer.trim())
        answer = await terminal.question("Choose a number or write your answer: ", { signal });
      const choice = /^\d+$/.test(answer.trim()) ? options[Number(answer.trim()) - 1] : undefined;
      answers[q.id] = choice ? `${choice.label}: ${choice.description}` : answer;
    }
    return answers;
  } finally {
    terminal.close();
  }
};

/** Same planning engine as /plan. No placeholder artifact when inference fails. */
export async function runPlan(
  args: PlanArgs,
  cwd = process.cwd(),
  dependencies: PlanDependencies = {},
): Promise<PlanResult> {
  const owned = dependencies.runtime ? undefined : await createAgentRuntime({ memory: false });
  const runtime = dependencies.runtime ?? owned!;
  const controller = new AbortController();
  const signal = dependencies.signal
    ? AbortSignal.any([controller.signal, dependencies.signal])
    : controller.signal;
  const session = new ScientificPlanningSession(cwd, {
    planId: args["plan-id"],
    storePath: args["store-path"],
    projectId: args["project-id"],
    missionId: args["mission-id"],
    objectiveId: args["objective-id"],
  });
  let questions: PlanningQuestions | undefined;
  let response = "";
  let failed = false;
  try {
    await session.open();
    const priorRevision = session.artifact?.revision ?? 0;
    for await (const event of session.run(args.objective, runtime, {
      signal,
      model: dependencies.model,
      ask:
        dependencies.ask ??
        (async (request) => {
          questions = request;
          controller.abort();
          return undefined;
        }),
    })) {
      if (event.type === "text") response += event.text;
      if (event.type === "error") {
        failed = true;
        if (!questions) response += `\n${event.message}`;
      }
    }
    return {
      status: questions
        ? "needs-input"
        : (session.artifact?.revision ?? 0) > priorRevision && !failed
          ? "proposal"
          : "incomplete",
      response,
      ...(session.artifact ? { artifact: session.artifact } : {}),
      ...(questions ? { questions } : {}),
    };
  } finally {
    await owned?.close();
  }
}
