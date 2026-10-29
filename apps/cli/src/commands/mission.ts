import { MissionClientConfigSchema } from "../services/mission-local-authority";
import { MdFailedAllocationRequestSchema } from "../services/md-failed-allocation-review";
import { MdNoSubmitRequestSchema } from "../services/md-no-submit-review";
import type { CommandModule } from "yargs";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  MissionAddressSchema,
  MissionApproveRequestSchema,
  MissionCompileRequestSchema,
  MissionCreateRequestSchema,
  MissionImportRequestSchema,
  MissionReviewRequestSchema,
  MissionStartRequestSchema,
  MissionReplanUnstartedRequestSchema,
  MissionCancelRequestSchema,
} from "../services/mission-application";
import { openMissionApplication } from "../services/mission-composition";
import { readMissionRequestFile } from "../services/mission-request-file";

type MissionSession = Awaited<ReturnType<typeof openMissionApplication>>;
const actions = [
  "create",
  "import",
  "read",
  "review",
  "approve",
  "compile",
  "start",
  "status",
  "cancel",
  "replan-unstarted",
  "reconcile-no-submit",
  "reconcile-failed-allocation",
] as const;
export type MissionAction = (typeof actions)[number];

const requestSchemas = {
  create: MissionCreateRequestSchema,
  import: MissionImportRequestSchema,
  read: MissionAddressSchema,
  review: MissionReviewRequestSchema,
  approve: MissionApproveRequestSchema,
  compile: MissionCompileRequestSchema,
  start: MissionStartRequestSchema,
  status: MissionAddressSchema,
  cancel: MissionCancelRequestSchema,
  "replan-unstarted": MissionReplanUnstartedRequestSchema,
  "reconcile-no-submit": MdNoSubmitRequestSchema,
  "reconcile-failed-allocation": MdFailedAllocationRequestSchema,
};

const schemaSubjects = { ...requestSchemas, "client-config": MissionClientConfigSchema };

/** Parse before opening authority/DB/CAS so malformed commands have no durable effects. */
export async function runMissionAction(
  action: MissionAction,
  value: unknown,
  open: () => Promise<MissionSession> = openMissionApplication,
): Promise<unknown> {
  if (!Object.hasOwn(requestSchemas, action)) throw new Error("Unknown mission action");
  const parsed = requestSchemas[action].parse(value);
  const session = await open();
  try {
    const app = session.application;
    switch (action) {
      case "create":
        return await app.create(MissionCreateRequestSchema.parse(parsed));
      case "import":
        return await app.importCandidate(MissionImportRequestSchema.parse(parsed));
      case "read":
        return await app.read(MissionAddressSchema.parse(parsed));
      case "review":
        return await app.review(MissionReviewRequestSchema.parse(parsed));
      case "approve":
        return await app.approve(MissionApproveRequestSchema.parse(parsed));
      case "compile":
        return await app.compile(MissionCompileRequestSchema.parse(parsed));
      case "start":
        return await app.start(MissionStartRequestSchema.parse(parsed));
      case "reconcile-failed-allocation":
        return await session.reconcileFailedAllocation(parsed);
      case "reconcile-no-submit":
        return await session.reconcileNoSubmit(parsed);
      case "replan-unstarted":
        return await app.replanUnstarted(MissionReplanUnstartedRequestSchema.parse(parsed));
      case "status":
        return await app.status(MissionAddressSchema.parse(parsed));
      case "cancel":
        return await app.requestCancel(MissionCancelRequestSchema.parse(parsed));
    }
  } finally {
    await session.close();
  }
}

export function createMissionCommand(
  open: () => Promise<MissionSession> = openMissionApplication,
  output: (value: unknown) => void = (value) => console.log(JSON.stringify(value, null, 2)),
): CommandModule {
  return {
    command: "mission",
    describe: "Create, review and start durable scientific missions",
    builder(y) {
      y = y.command(
        "schema <action>",
        "Print a mission request or protected client configuration schema",
        (child) =>
          child
            .positional("action", { choices: Object.keys(schemaSubjects), demandOption: true })
            .strict(),
        (args) =>
          output(
            zodToJsonSchema(schemaSubjects[args.action as keyof typeof schemaSubjects], {
              $refStrategy: "none",
            }),
          ),
      );
      for (const action of actions) {
        y = y.command(
          `${action} <request>`,
          `${action} a mission using an exact JSON request`,
          (child) =>
            child
              .positional("request", {
                type: "string",
                demandOption: true,
                describe: "JSON request file",
              })
              .strict(),
          async (args) =>
            output(
              await runMissionAction(
                action,
                await readMissionRequestFile(args.request as string),
                open,
              ),
            ),
        );
      }
      return y
        .command(
          "artifact <file>",
          "Import a verified input into the configured artifact store",
          (child) =>
            child
              .positional("file", { type: "string", demandOption: true })
              .option("sha256", {
                type: "string",
                demandOption: true,
                describe: "Expected lowercase SHA-256",
              })
              .strict(),
          async (args) => {
            if (!/^[a-f0-9]{64}$/u.test(args.sha256)) throw new Error("Invalid expected SHA-256");
            const session = await open();
            try {
              output(await session.importArtifact(args.file as string, args.sha256));
            } finally {
              await session.close();
            }
          },
        )
        .demandCommand(1, "Choose a mission action")
        .strict();
    },
    handler() {},
  };
}

export const missionCommand = createMissionCommand();
