import { describe, expect, test } from "bun:test";
import yargs from "yargs";
import { createMissionCommand, runMissionAction } from "./mission";
import type { openMissionApplication } from "../services/mission-composition";

type Session = Awaited<ReturnType<typeof openMissionApplication>>;

describe("mission CLI", () => {
  test("malformed requests and caller-supplied authority are rejected before composition", async () => {
    let opened = 0;
    const open = async (): Promise<Session> => {
      opened++;
      throw new Error("must not open");
    };
    for (const extra of [
      { actor: { id: "admin" } },
      { authorizedRoles: ["admin"] },
      { databaseUrl: "postgresql://evil" },
      { policyDigest: "0".repeat(64) },
    ])
      await expect(
        runMissionAction("status", { projectId: "p", missionId: "m", ...extra }, open),
      ).rejects.toThrow();
    await expect(
      runMissionAction("approve", { projectId: "p", missionId: "m" }, open),
    ).rejects.toThrow();
    expect(opened).toBe(0);
  });

  test("dispatches exact request and closes composition on success or failure", async () => {
    let closed = 0;
    const request = { projectId: "p", missionId: "m" };
    const session = {
      application: {
        status: async (value: unknown) => {
          expect(value).toEqual(request);
          return { state: "awaiting_approval" };
        },
      },
      close: async () => {
        closed++;
      },
    } as unknown as Session;
    expect(await runMissionAction("status", request, async () => session)).toEqual({
      state: "awaiting_approval",
    });
    expect(closed).toBe(1);
    session.application.status = async () => {
      throw new Error("revoked");
    };
    await expect(runMissionAction("status", request, async () => session)).rejects.toThrow(
      "revoked",
    );
    expect(closed).toBe(2);
  });

  test("help exposes the durable workflow without opening authority", async () => {
    let opened = 0;
    const command = createMissionCommand(async () => {
      opened++;
      throw new Error("must not open");
    });
    const parser = yargs([]).scriptName("eigengrid").command(command).exitProcess(false).help();
    let help = "";
    await parser.parseAsync(["mission", "--help"], {}, (_error, _argv, output) => {
      help = output;
    });
    for (const action of [
      "create",
      "import",
      "review",
      "approve",
      "compile",
      "start",
      "status",
      "artifact",
    ])
      expect(help).toContain(`mission ${action}`);
    expect(help).not.toContain("--actor");
    expect(opened).toBe(0);
  });

  test("CLI rejects unrecognized identity and policy switches", async () => {
    let opened = 0;
    const parser = yargs([])
      .command(
        createMissionCommand(async () => {
          opened++;
          throw new Error("must not open");
        }),
      )
      .exitProcess(false)
      .strict()
      .fail((message, error) => {
        throw error ?? new Error(message);
      });
    await expect(
      Promise.resolve().then(() =>
        parser.parseAsync(["mission", "status", "request.json", "--actor", "admin"]),
      ),
    ).rejects.toThrow("Unknown argument");
    expect(opened).toBe(0);
  });
});

test("client configuration schema is available without database, model or protected files", async () => {
  let output: unknown;
  const parser = yargs([])
    .exitProcess(false)
    .command(
      createMissionCommand(
        async () => {
          throw new Error("Schema inspection must not open authority");
        },
        (value) => {
          output = value;
        },
      ),
    );
  await parser.parseAsync(["mission", "schema", "client-config"]);
  expect(output).toMatchObject({
    type: "object",
    additionalProperties: false,
    properties: { schemaVersion: { const: "eigengrid.mission-client/v1" } },
  });
  expect((output as { required: string[] }).required).toContain("operators");
});
