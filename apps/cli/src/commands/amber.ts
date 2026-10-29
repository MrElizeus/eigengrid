import type { CommandModule } from "yargs";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { AmberPilotCandidateSchema, AtomMapSchema } from "@eigengrid/scientific-schema";
import {
  AmberPilotPreparationOptionsSchema,
  AmberPilotAnalysisRequestSchema,
  AmberPilotAnalysisObservationSchema,
  renderAmberPilotPreparation,
  inspectAmberPilotPreparation,
  renderAmberPilotAnalysis,
  inspectAmberPilotAnalysis,
} from "@eigengrid/amber-adapter";
import { readMissionRequestFile } from "../services/mission-request-file";
import { openMissionApplication } from "../services/mission-composition";
import { AmberMaterialRequestSchema } from "../services/amber-material-publication";
import { AmberMdPreparationRequestSchema } from "../services/amber-md-preparation";
type MissionSession = Awaited<ReturnType<typeof openMissionApplication>>;

const preparationRequest = z
  .object({
    candidate: AmberPilotCandidateSchema,
    options: AmberPilotPreparationOptionsSchema,
  })
  .strict();
const preparationInspection = preparationRequest
  .extend({
    evidence: z
      .object({
        prmtop: z.string().min(1),
        rst7: z.string().min(1),
        snapshotPdb: z.string().min(1),
        leapLog: z.string().min(1),
        exitCode: z.number().int(),
        atomMap: AtomMapSchema,
      })
      .strict(),
  })
  .strict();
const analysisInspection = z
  .object({
    request: AmberPilotAnalysisRequestSchema,
    observation: AmberPilotAnalysisObservationSchema,
  })
  .strict();
const schemas = {
  prepare: preparationRequest,
  "inspect-preparation": preparationInspection,
  "render-analysis": AmberPilotAnalysisRequestSchema,
  "inspect-analysis": analysisInspection,
};
const actions = ["prepare", "inspect-preparation", "render-analysis", "inspect-analysis"] as const;
export type AmberReviewAction = (typeof actions)[number];

/** Offline review tools: these functions construct no runner, database or scheduler. */
export function runAmberReview(action: AmberReviewAction, value: unknown): unknown {
  switch (action) {
    case "prepare": {
      const input = preparationRequest.parse(value);
      return renderAmberPilotPreparation(input.candidate, input.options);
    }
    case "inspect-preparation": {
      const input = preparationInspection.parse(value);
      return inspectAmberPilotPreparation(input.candidate, input.options, input.evidence);
    }
    case "render-analysis":
      return renderAmberPilotAnalysis(AmberPilotAnalysisRequestSchema.parse(value));
    case "inspect-analysis": {
      const input = analysisInspection.parse(value);
      return inspectAmberPilotAnalysis(input.request, input.observation);
    }
    default:
      throw new Error("Unknown Amber review action");
  }
}

export function createAmberCommand(
  output: (value: unknown) => void = (value) => console.log(JSON.stringify(value, null, 2)),
  open: () => Promise<MissionSession> = openMissionApplication,
): CommandModule {
  return {
    command: "amber",
    describe: "Import approved Amber systems and render or inspect Amber analysis",
    builder(y) {
      y = y.command(
        "schema <action>",
        "Print a JSON request schema",
        (child) => child.positional("action", { choices: actions, demandOption: true }).strict(),
        (args) =>
          output(
            zodToJsonSchema(schemas[args.action as AmberReviewAction], { $refStrategy: "none" }),
          ),
      );
      for (const action of actions)
        y = y.command(
          `${action} <request>`,
          `${action} using an offline JSON request; emits review material`,
          (child) => child.positional("request", { type: "string", demandOption: true }).strict(),
          async (args) =>
            output(
              runAmberReview(
                action,
                await readMissionRequestFile(args.request as string, 40 * 1024 * 1024),
              ),
            ),
        );
      y = y.command(
        "material-schema",
        "Print the closed, human-authorized frozen-material publication request schema",
        (child) => child.strict(),
        () => output(zodToJsonSchema(AmberMaterialRequestSchema, { $refStrategy: "none" })),
      );
      y = y.command(
        "material <request>",
        "Propose, approve or publish an exact frozen Amber material; never dispatch MD",
        (child) => child.positional("request", { type: "string", demandOption: true }).strict(),
        async (args) => {
          const request = AmberMaterialRequestSchema.parse(
            await readMissionRequestFile(args.request as string, 40 * 1024 * 1024),
          );
          const session = await open();
          try {
            output(await session.applyAmberMaterial(request));
          } finally {
            await session.close();
          }
        },
      );
      y = y.command(
        "import-prepared-system <directory>",
        "Verify and import a prepared biomolecular system through its exact EigenGrid authority",
        (child) => child.positional("directory", { type: "string", demandOption: true }).strict(),
        async (args) => {
          const session = await open();
          try {
            output(await session.importPreparedSystem(args.directory as string));
          } finally {
            await session.close();
          }
        },
      );
      y = y.command(
        "publish-md-stage <request>",
        "Render and publish an already approved MD WorkUnit through protected site authority; no dispatch",
        (child) => child.positional("request", { type: "string", demandOption: true }).strict(),
        async (args) => {
          const request = AmberMdPreparationRequestSchema.parse(
            await readMissionRequestFile(args.request as string),
          );
          const session = await open();
          try {
            output(await session.publishMdStage(request));
          } finally {
            await session.close();
          }
        },
      );
      return y.demandCommand(1, "Choose an Amber review action").strict();
    },
    handler() {},
  };
}

export const amberCommand = createAmberCommand();
