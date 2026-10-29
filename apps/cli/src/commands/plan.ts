import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { CommandModule } from "yargs";
import {
  DurablePlanArtifactStore,
  PlanCapabilityRegistry,
  createPlanArtifact,
  type ScientificPlanArtifact,
} from "@eigengrid/mission-runtime";
import { digestCanonical } from "@eigengrid/scientific-schema";

export interface PlanArgs {
  objective: string;
  "mission-id"?: string;
  "project-id"?: string;
  "objective-id"?: string;
  "plan-id"?: string;
  json?: boolean;
  "store-path"?: string;
}

/**
 * First-class hard Plan Mode. It deliberately has no ApplicationContext or
 * runner handles; only deterministic artifact construction and a controlled
 * append-only plan store are reachable from this command.
 */
export const planCommand: CommandModule = {
  command: "plan <objective>",
  describe: "Create a durable, zero-effect scientific plan artifact",
  builder: (y) =>
    y
      .positional("objective", {
        type: "string",
        demandOption: true,
        describe: "Scientific objective",
      })
      .option("mission-id", { type: "string", describe: "Exact mission identity" })
      .option("project-id", { type: "string", describe: "Project identity" })
      .option("objective-id", { type: "string", describe: "Objective identity" })
      .option("plan-id", { type: "string", describe: "Plan identity (defaults to a new id)" })
      .option("json", { type: "boolean", default: false, describe: "Render the artifact as JSON" })
      .option("store-path", {
        type: "string",
        describe: "Controlled plan store path (defaults to .eigengrid/plans.jsonl)",
      }),
  async handler(argv) {
    const artifact = await runPlan(argv as unknown as PlanArgs);
    if ((argv as unknown as PlanArgs).json) console.log(JSON.stringify(artifact, null, 2));
    else
      console.log(
        `  Plan ${artifact.planId} revision ${artifact.revision} created (${artifact.materialDigest})`,
      );
  },
};

export async function runPlan(
  args: PlanArgs,
  cwd = process.cwd(),
): Promise<ScientificPlanArtifact> {
  // The host registry is consulted before constructing any plan operation.
  const capabilities = new PlanCapabilityRegistry();
  capabilities.assertAllowed("plan.create");
  for (const forbidden of ["job.submit", "job.cancel", "ssh.mutate", "slurm.mutate", "shell.raw"]) {
    if (capabilities.decide(forbidden).allowed)
      throw new Error(`Plan Mode invariant violated for ${forbidden}`);
  }

  const missionId = args["mission-id"] ?? "unbound-mission";
  const projectId = args["project-id"] ?? "unbound-project";
  const objectiveId = args["objective-id"] ?? "objective-1";
  const planId = args["plan-id"] ?? `plan-${randomUUID()}`;
  const objective = { projectId, missionId, objectiveId, revision: 1 };
  const objectiveDigest = `sha256:${digestCanonical(objective)}`;
  const store = new DurablePlanArtifactStore(
    args["store-path"] ?? join(cwd, ".eigengrid", "plans.jsonl"),
  );
  const previous = await store.get(planId);
  const revision = (previous?.revision ?? 0) + 1;
  const artifact = createPlanArtifact({
    planId,
    revision,
    priorRevision: previous?.revision ?? null,
    objective: { ...objective, digest: objectiveDigest },
    problem: args.objective,
    nonGoals: ["execution", "publication", "unreviewed scientific claims"],
    assumptions: [
      {
        id: "assumption.context",
        statement: "Inputs require review before execution",
        status: "proposed",
      },
    ],
    contradictions: [],
    humanInputs: [],
    evidence: [],
    alternatives: [{ id: "deterministic", rationale: "bounded host-validated workflow" }],
    selectedAlternative: "deterministic",
    scientificDecisions: [],
    workGraph: { nodes: [], edges: [] },
    environments: [],
    resources: [],
    risks: [{ id: "risk.unqualified", class: "R2", mitigation: "require exact approval" }],
    approvalPolicy: { requiredRoles: ["scientific-reviewer"], exactDigest: true },
    validation: [{ id: "schema", required: true, method: "deterministic-schema-validation" }],
    recovery: { onRestart: "reload-artifact-and-reconcile-before-effects" },
    budgets: { modelCalls: 0, externalEffects: 0, scientificCompute: 0 },
    critiques: [],
    limitations: ["Planning is not approval and does not execute effects."],
  });
  return store.put(artifact);
}
