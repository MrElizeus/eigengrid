import { readFileSync, statSync } from "node:fs";
import type { CommandModule } from "yargs";
import { z } from "zod";
import { AgentMemory, captureAgentExperience } from "@eigengrid/agent";
import { JsonlAgentJournal } from "@eigengrid/agent-runtime";
import { LessonCandidateSchema } from "@eigengrid/experience-memory";
import { confirmExperienceReview } from "../services/experience-review";

const argsSchema = z.object({
  action: z.enum([
    "search",
    "show",
    "evidence",
    "propose",
    "verify",
    "review",
    "promote",
    "relate",
    "resolve",
    "import-session",
  ]),
  id: z.string().optional(),
  file: z.string().optional(),
  query: z.string().default(""),
  expected: z.string().optional(),
  reason: z.string().max(4000).optional(),
  confidence: z.enum(["unknown", "low", "medium", "high"]).default("unknown"),
  target: z.string().optional(),
  "target-expected": z.string().optional(),
  relation: z.enum(["contradicts", "refutes", "supersedes"]).optional(),
  "include-candidates": z.boolean().default(false),
  "journal-dir": z.string().optional(),
  "session-id": z.string().optional(),
  "installation-id": z.string().optional(),
});
function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`Missing ${name}`);
  return value;
}
function readProposal(file: string) {
  if (statSync(file).size > 128 * 1024) throw new Error("Memory proposal exceeds 128 KiB");
  return LessonCandidateSchema.innerType()
    .omit({
      schemaVersion: true,
      boundary: true,
      author: true,
      createdAt: true,
      digest: true,
    })
    .parse(JSON.parse(readFileSync(file, "utf8")));
}

export const memoryCommand: CommandModule = {
  command: "memory <action> [id]",
  describe: "Inspect local experiences, import durable sessions and review evidenced lessons",
  builder: (y) =>
    y
      .positional("action", { type: "string", choices: argsSchema.shape.action.options })
      .positional("id", { type: "string", describe: "Lesson or evidence ID" })
      .option("query", { type: "string", default: "" })
      .option("include-candidates", {
        type: "boolean",
        default: false,
        describe: "Inspect excluded lessons with their exclusion reasons",
      })
      .option("file", { type: "string", describe: "Candidate JSON file for propose" })
      .option("expected", { type: "string", describe: "Exact current lesson event digest" })
      .option("reason", { type: "string", describe: "Review or relationship rationale" })
      .option("confidence", {
        type: "string",
        choices: ["unknown", "low", "medium", "high"],
        default: "unknown",
      })
      .option("target", { type: "string", describe: "Related lesson ID" })
      .option("target-expected", { type: "string", describe: "Exact related lesson event digest" })
      .option("relation", { type: "string", choices: ["contradicts", "refutes", "supersedes"] })
      .option("journal-dir", {
        type: "string",
        describe: "Owned durable journal directory to import",
      })
      .option("session-id", { type: "string" })
      .option("installation-id", { type: "string" }),
  async handler(argv) {
    const args = argsSchema.parse(argv);
    const local = new AgentMemory();
    await local.connect();
    try {
      const memory = local.experience!;
      const owner = { id: memory.boundary.ownerId, kind: "human", role: "author" } as const;
      let result: unknown;
      switch (args.action) {
        case "search":
          result = memory.search(
            args.query,
            {
              ...local.experienceContext,
              sessionId: args["session-id"],
              installationId: args["installation-id"],
            },
            { includeIneligible: args["include-candidates"], limit: 20 },
          );
          break;
        case "show":
          result = memory.get(required(args.id, "id"));
          break;
        case "evidence":
          result = args.id ? memory.evidence(args.id) : memory.recentEvidence();
          break;
        case "propose":
          result = memory.propose(readProposal(required(args.file, "--file")), owner);
          break;
        case "import-session": {
          const id = required(args["session-id"], "--session-id");
          const records = new JsonlAgentJournal(
            required(args["journal-dir"], "--journal-dir"),
          ).load(id);
          if (!records.length) throw new Error("No durable session records found");
          result = captureAgentExperience(memory, id, records);
          break;
        }
        case "verify":
          result = memory.verify(required(args.id, "id"), required(args.expected, "--expected"), {
            id: "local-evidence-verifier",
            kind: "service",
            role: "observer",
          });
          break;
        default: {
          const id = required(args.id, "id"),
            expected = required(args.expected, "--expected");
          const reason = required(args.reason, "--reason");
          const lesson = memory.get(id);
          const evidence = lesson.candidate.evidence.map((ref) => memory.evidence(ref.id));
          const relation =
            args.action === "relate"
              ? {
                  sourceId: id,
                  sourceExpected: expected,
                  targetId: required(args.target, "--target"),
                  targetExpected: required(args["target-expected"], "--target-expected"),
                  kind: z.enum(["contradicts", "refutes", "supersedes"]).parse(args.relation),
                  reason,
                }
              : undefined;
          const target = relation ? memory.get(relation.targetId) : undefined;
          if (target && target.current.digest !== relation!.targetExpected)
            throw new Error("Stale target revision");
          const actor = await confirmExperienceReview(args.action, lesson, expected, {
            observations: evidence,
            reason,
            confidence: args.confidence,
            relation,
            target,
            targetEvidence: target?.candidate.evidence.map((ref) => memory.evidence(ref.id)),
          });
          if (relation) result = memory.relate(relation, actor);
          else if (args.action === "review")
            result = memory.review(id, expected, actor, reason, {
              level: args.confidence,
              basis: reason,
            });
          else if (args.action === "promote") result = memory.promote(id, expected, actor, reason);
          else result = memory.resolve(id, expected, actor, reason);
        }
      }
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await local.disconnect();
    }
  },
};
