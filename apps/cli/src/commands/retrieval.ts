import { readFileSync, statSync } from "node:fs";
import type { CommandModule } from "yargs";
import { z } from "zod";
import { composeScientificCatalog } from "@eigengrid/scientific-skills";
import {
  createInstalledScientificRetrieval,
  evaluateScientificRetrieval,
  RetrievalEvaluationCaseSchema,
} from "@eigengrid/scientific-retrieval";

const Args = z.object({
  action: z.enum(["status", "rebuild", "search", "evaluate", "compose"]),
  query: z.string().optional(),
  config: z.string().optional(),
  corpus: z.string().optional(),
  "site-corpus": z.string().optional(),
  output: z.string().optional(),
  "expected-public-digest": z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  "expected-site-digest": z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  mode: z.enum(["lexical", "vector", "hybrid", "scientific"]).optional(),
  cases: z.string().optional(),
  k: z.number().int().min(1).max(100).default(5),
  repeats: z.number().int().min(1).max(20).default(1),
  context: z.boolean().default(false),
  "max-characters": z.number().int().min(0).max(1000000).default(24000),
});

export const retrievalCommand: CommandModule = {
  command: "retrieval <action>",
  describe: "Inspect, rebuild or evaluate the local derived scientific retrieval index",
  builder: (y) =>
    y
      .positional("action", { type: "string", choices: Args.shape.action.options })
      .option("query", { type: "string" })
      .option("config", {
        type: "string",
        describe: "Owned retrieval configuration JSON; defaults to EIGENGRID_RETRIEVAL_CONFIG",
      })
      .option("corpus", { type: "string", describe: "Local scientific corpus root" })
      .option("site-corpus", { type: "string", describe: "Site catalog to compose with --corpus" })
      .option("output", {
        type: "string",
        describe: "New private composition directory; omit to preview",
      })
      .option("expected-public-digest", { type: "string" })
      .option("expected-site-digest", { type: "string" })
      .option("mode", { type: "string", choices: ["lexical", "vector", "hybrid", "scientific"] })
      .option("context", { type: "boolean", default: false })
      .option("max-characters", { type: "number", default: 24000 })
      .option("cases", {
        type: "string",
        describe: "Evaluation JSONL with explicit relevance labels",
      })
      .option("k", { type: "number", default: 5 })
      .option("repeats", { type: "number", default: 1 }),
  async handler(argv) {
    const args = Args.parse(argv);
    if (args.action === "compose") {
      if (!args.corpus || !args["site-corpus"])
        throw new Error("compose requires --corpus and --site-corpus");
      console.log(
        JSON.stringify(
          composeScientificCatalog({
            publicRoot: args.corpus,
            siteRoot: args["site-corpus"],
            output: args.output,
            expectedPublicDigest: args["expected-public-digest"],
            expectedSiteDigest: args["expected-site-digest"],
          }),
          null,
          2,
        ),
      );
      return;
    }
    const service = createInstalledScientificRetrieval(args.corpus, args.config);
    try {
      let output: unknown;
      if (args.action === "status") output = service.status();
      else if (args.action === "rebuild") output = await service.rebuild();
      else if (args.action === "search") {
        if (!args.query) throw new Error("search requires --query");
        const request = { query: args.query, mode: args.mode, limit: args.k };
        const result = await service.search(request);
        output = args.context
          ? {
              result,
              context: service.context(result, request, { maxCharacters: args["max-characters"] }),
            }
          : result;
      } else {
        if (!args.cases || statSync(args.cases).size > 4 * 1024 * 1024)
          throw new Error("evaluate requires --cases with a JSONL file no larger than 4 MiB");
        const cases = readFileSync(args.cases, "utf8")
          .split(/\r?\n/u)
          .filter((line) => line.trim())
          .map((line) => RetrievalEvaluationCaseSchema.parse(JSON.parse(line)));
        output = await evaluateScientificRetrieval(service, cases, {
          k: args.k,
          repeats: args.repeats,
          maxCharacters: args["max-characters"],
        });
      }
      console.log(JSON.stringify(output, null, 2));
    } finally {
      service.close();
    }
  },
};
