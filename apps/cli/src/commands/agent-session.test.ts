import { describe, expect, test } from "bun:test";
import yargs from "yargs";
import { createAgentSessionCommand } from "./agent-session";
import { agentCommand } from "./agent";
import { approveCommand } from "./approve";
import { executeCommand } from "./execute";
import type { AgentSessionService } from "../services/agent-sessions";

describe("application CLI surface and fail-closed legacy migrations", () => {
  test("start accepts a prompt and rejects scope overrides before dispatch", async () => {
    const calls: string[] = [];
    const results: unknown[] = [];
    const command = createAgentSessionCommand(
      () => {
        throw new Error("must not open a local service");
      },
      (result) => results.push(result),
      async (prompt) => {
        calls.push(prompt);
        return { phase: "waiting_approval" };
      },
    );
    await yargs(["agent-session", "start", " inspect this mission "])
      .command(command)
      .exitProcess(false)
      .parseAsync();
    expect(calls).toEqual(["inspect this mission"]);
    expect(results).toEqual([{ phase: "waiting_approval" }]);
    await expect(
      (async () =>
        yargs(["agent-session", "start", "inspect", "--actorId", "admin"])
          .command(command)
          .exitProcess(false)
          .parseAsync())(),
    ).rejects.toThrow();
    await expect(
      yargs(["agent-session", "start", "   "]).command(command).exitProcess(false).parseAsync(),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
  test("agent help resolves the native agent rather than an overlapping legacy execute command", async () => {
    let help = "";
    await yargs([])
      .command(agentCommand)
      .exitProcess(false)
      .help()
      .parseAsync(["agent", "--help"], {}, (_error, _argv, output) => {
        help = output;
      });
    expect(help).toContain("Run EigenGrid AI agent");
    expect(help).toContain("prompt");
    expect(help).toContain("agent execute");
  });
  test("legacy direct approval and execution no longer read SQLite or call local submitters", () => {
    expect(() => approveCommand.handler?.({} as never)).toThrow("LEGACY_AGENT_APPROVAL_DISABLED");
    expect(() => executeCommand.handler?.({} as never)).toThrow("LEGACY_AGENT_EXECUTE_DISABLED");
  });

  test("malformed agent session identifiers reject before connecting protected services", async () => {
    let opened = 0;
    const command = createAgentSessionCommand(() => {
      opened++;
      throw new Error("must not open");
    });
    await expect(
      yargs(["agent-session", "observe", "../../other"])
        .command(command)
        .exitProcess(false)
        .parseAsync(),
    ).rejects.toThrow();
    expect(opened).toBe(0);
  });

  test("observe dispatches to exactly one host service with a validated ID", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const values: unknown[] = [];
    let seen: string | undefined;
    const service = {
      observe: async (sessionId: string) => {
        seen = sessionId;
        return { sessionId, phase: "ready" };
      },
    } as unknown as AgentSessionService;
    await yargs(["agent-session", "observe", id])
      .command(
        createAgentSessionCommand(
          () => service,
          (v) => values.push(v),
        ),
      )
      .exitProcess(false)
      .parseAsync();
    expect(seen).toBe(id);
    expect(values).toEqual([{ sessionId: id, phase: "ready" }]);
  });
});
