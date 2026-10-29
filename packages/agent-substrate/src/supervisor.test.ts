import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  AgentSubstrateAdapter,
  CodexAppServerSupervisor,
  DurableCodexSupervisorJournal,
  EIGENGRID_AGENT_PROTOCOL,
  PINNED_CODEX_APP_SERVER_BINDING,
  preflightAgentSubstrate,
} from "./index";

function receipt() {
  const binary = "1".repeat(64);
  const config = "2".repeat(64);
  return preflightAgentSubstrate(
    {
      adapterProtocol: EIGENGRID_AGENT_PROTOCOL,
      adapterVersion: "0.1.0",
      codexCliVersion: PINNED_CODEX_APP_SERVER_BINDING.codexCliVersion,
      codexUpstreamCommit: PINNED_CODEX_APP_SERVER_BINDING.codexUpstreamCommit,
      codexBinarySha256: binary,
      schemaSha256: PINNED_CODEX_APP_SERVER_BINDING.schemaSha256,
      configurationSha256: config,
      requiredFeatures: ["app_server_v2"],
    },
    {
      adapterProtocol: EIGENGRID_AGENT_PROTOCOL,
      adapterVersion: "0.1.0",
      codexCliVersion: PINNED_CODEX_APP_SERVER_BINDING.codexCliVersion,
      codexUpstreamCommit: PINNED_CODEX_APP_SERVER_BINDING.codexUpstreamCommit,
      codexBinarySha256: binary,
      schemaSha256: PINNED_CODEX_APP_SERVER_BINDING.schemaSha256,
      configurationSha256: config,
      availableFeatures: ["app_server_v2"],
    },
  );
}

class FakeProcess extends EventEmitter {
  readonly pid = 4242;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly writes: string[] = [];
  readonly stdin = {
    write: (chunk: string) => {
      this.writes.push(chunk);
      return true;
    },
    end: () => {},
  };
  kill = (_signal?: NodeJS.Signals) => {
    this.emit("exit", 0, null);
    return true;
  };
}

describe("Codex app-server supervisor", () => {
  test("starts a private stdio child and serves the adapter transport", async () => {
    const child = new FakeProcess();
    const supervisor = new CodexAppServerSupervisor({
      preflight: receipt(),
      processFactory: (_command, args, options) => {
        expect(args).toEqual(["app-server"]);
        expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
        expect(options.env.OPENAI_API_KEY).toBeUndefined();
        return child as any;
      },
      requestTimeoutMs: 1_000,
    });
    await supervisor.start();
    expect(supervisor.status).toBe("ready");
    const adapter = new AgentSubstrateAdapter(receipt(), supervisor.asTransport());
    const pending = adapter.request("initialize", { protocol: EIGENGRID_AGENT_PROTOCOL });
    for (let i = 0; i < 10 && child.writes.length === 0; i += 1) await Promise.resolve();
    const request = JSON.parse(child.writes[0]!);
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } })}\n`,
    );
    await expect(pending).resolves.toEqual({ ok: true });
    await supervisor.stop(0);
    expect(supervisor.status).toBe("stopped");
  });

  test("fails closed on unknown critical upstream event", async () => {
    const child = new FakeProcess();
    const supervisor = new CodexAppServerSupervisor({
      preflight: receipt(),
      processFactory: () => child as any,
      requestTimeoutMs: 1_000,
    });
    await supervisor.start();
    child.stdout.write('{"jsonrpc":"2.0","method":"permission/adminGrant"}\n');
    expect(supervisor.status).toBe("incompatible");
    await expect(supervisor.request("initialize", {})).rejects.toThrow("not ready");
  });

  test("dispatches only the allow-listed server capability request", async () => {
    const child = new FakeProcess();
    const calls: unknown[] = [];
    const supervisor = new CodexAppServerSupervisor({
      preflight: receipt(),
      processFactory: () => child as any,
      serverRequestDispatcher: async (method, params) => {
        calls.push([method, params]);
        return { accepted: true };
      },
    });
    await supervisor.start();
    child.stdout.write(
      '{"jsonrpc":"2.0","id":"server-1","method":"item/tool/call","params":{"name":"inspect"}}\n',
    );
    for (let i = 0; i < 10 && child.writes.length < 1; i += 1) await Promise.resolve();
    expect(calls).toEqual([["item/tool/call", { name: "inspect" }]]);
    expect(JSON.parse(child.writes.at(-1)!)).toMatchObject({
      id: "server-1",
      result: { accepted: true },
    });
    await supervisor.stop(0);
  });

  test("fails closed when an unbounded upstream message or server request appears", async () => {
    const child = new FakeProcess();
    const supervisor = new CodexAppServerSupervisor({
      preflight: receipt(),
      processFactory: () => child as any,
      maxBufferedBytes: 32,
    });
    await supervisor.start();
    child.stdout.write("x".repeat(33));
    expect(supervisor.status).toBe("incompatible");

    const secondChild = new FakeProcess();
    const second = new CodexAppServerSupervisor({
      preflight: receipt(),
      processFactory: () => secondChild as any,
    });
    await second.start();
    secondChild.stdout.write(
      '{"jsonrpc":"2.0","id":"server-2","method":"item/tool/call","params":{}}\n',
    );
    await Promise.resolve();
    expect(second.status).toBe("incompatible");
    await supervisor.stop(0);
    await second.stop(0);
  });

  test("filters credential aliases from the Codex child environment", async () => {
    const child = new FakeProcess();
    let environment: NodeJS.ProcessEnv | undefined;
    const supervisor = new CodexAppServerSupervisor({
      preflight: receipt(),
      environment: {
        AWS_SECRET_ACCESS_KEY: "aws-secret",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        EIGENGRID_DATABASE_URL: "postgres://u:p@host/db",
        CODEX_HOME: "/tmp/codex-home",
      },
      processFactory: (_command, _args, options) => {
        environment = options.env;
        return child as any;
      },
    });
    await supervisor.start();
    expect(environment?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(environment?.SSH_AUTH_SOCK).toBeUndefined();
    expect(environment?.EIGENGRID_DATABASE_URL).toBeUndefined();
    expect(environment?.CODEX_HOME).toBe("/tmp/codex-home");
    await supervisor.stop(0);
  });

  test("journals lifecycle records with restricted file semantics", async () => {
    const root = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp("/tmp/eigengrid-codex-"),
    );
    const path = `${root}/journal.ndjson`;
    const journal = new DurableCodexSupervisorJournal(path);
    await journal.append({ type: "process.started", secret: "not-in-context" });
    const text = await import("node:fs/promises").then(({ readFile }) => readFile(path, "utf8"));
    expect(text).toContain("process.started");
    expect(text).not.toContain("OPENAI_API_KEY");
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  });
});
