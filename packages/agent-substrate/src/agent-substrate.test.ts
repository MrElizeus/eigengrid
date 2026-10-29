import { describe, expect, test } from "bun:test";

import {
  AgentSubstrateAdapter,
  AgentSubstrateCompatibilityError,
  AgentSubstrateRpcPolicyError,
  AGENT_SUBSTRATE_ADAPTER_VERSION,
  EIGENGRID_AGENT_PROTOCOL,
  PINNED_CODEX_APP_SERVER_BINDING,
  authorizeCodexClientRequest,
  preflightAgentSubstrate,
  type AgentSubstrateCompatibilityExpectation,
  type AgentSubstrateCompatibilityObservation,
  type CodexAppServerTransport,
} from "./index";

const expected: AgentSubstrateCompatibilityExpectation = Object.freeze({
  adapterProtocol: EIGENGRID_AGENT_PROTOCOL,
  adapterVersion: AGENT_SUBSTRATE_ADAPTER_VERSION,
  codexCliVersion: PINNED_CODEX_APP_SERVER_BINDING.codexCliVersion,
  codexUpstreamCommit: PINNED_CODEX_APP_SERVER_BINDING.codexUpstreamCommit,
  codexBinarySha256: "1".repeat(64),
  schemaSha256: PINNED_CODEX_APP_SERVER_BINDING.schemaSha256,
  configurationSha256: "2".repeat(64),
  requiredFeatures: Object.freeze(["app_server_v2"]),
});

const observed: AgentSubstrateCompatibilityObservation = Object.freeze({
  adapterProtocol: EIGENGRID_AGENT_PROTOCOL,
  adapterVersion: AGENT_SUBSTRATE_ADAPTER_VERSION,
  codexCliVersion: PINNED_CODEX_APP_SERVER_BINDING.codexCliVersion,
  codexUpstreamCommit: PINNED_CODEX_APP_SERVER_BINDING.codexUpstreamCommit,
  codexBinarySha256: "1".repeat(64),
  schemaSha256: PINNED_CODEX_APP_SERVER_BINDING.schemaSha256,
  configurationSha256: "2".repeat(64),
  availableFeatures: Object.freeze(["app_server_v2"]),
});

function expectCompatibilityFailure(
  run: () => unknown,
  code: AgentSubstrateCompatibilityError["code"],
  field: string,
): void {
  try {
    run();
    throw new Error("Expected compatibility preflight to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(AgentSubstrateCompatibilityError);
    expect(error).toMatchObject({ code, field });
  }
}

describe("agent substrate compatibility preflight", () => {
  test("issues a frozen receipt only for the exact pinned substrate", () => {
    const receipt = preflightAgentSubstrate(expected, observed);

    expect(receipt).toMatchObject({
      protocol: EIGENGRID_AGENT_PROTOCOL,
      adapterVersion: AGENT_SUBSTRATE_ADAPTER_VERSION,
      codexCliVersion: PINNED_CODEX_APP_SERVER_BINDING.codexCliVersion,
      schemaSha256: expected.schemaSha256,
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.features)).toBe(true);
  });

  test.each([
    ["codexBinarySha256", "3".repeat(64), "CODEX_BINARY_MISMATCH"],
    ["schemaSha256", "4".repeat(64), "SCHEMA_MISMATCH"],
  ] as const)("fails closed on %s mismatch", (field, value, code) => {
    expectCompatibilityFailure(
      () => preflightAgentSubstrate(expected, { ...observed, [field]: value }),
      code,
      field,
    );
  });

  test("rejects unknown manifest fields instead of silently expanding authority", () => {
    expectCompatibilityFailure(
      () => preflightAgentSubstrate(expected, { ...observed, futureAuthority: true }),
      "INVALID_COMPATIBILITY_MANIFEST",
      "futureAuthority",
    );
  });
});

describe("Codex app-server request policy", () => {
  test("accepts the bounded client request trace exercised by the spike", () => {
    for (const method of [
      "initialize",
      "thread/start",
      "turn/start",
      "thread/resume",
      "turn/interrupt",
    ] as const) {
      expect(authorizeCodexClientRequest(method)).toBe(method);
    }
  });

  test("forwards only the initialized lifecycle notification", () => {
    const notifications: string[] = [];
    const adapter = new AgentSubstrateAdapter(preflightAgentSubstrate(expected, observed), {
      async request() {
        return {};
      },
      notify(method) {
        notifications.push(method);
      },
    });

    adapter.notify("initialized", undefined);
    expect(notifications).toEqual(["initialized"]);
    expect(() => adapter.notify("thread/authority/changed", {})).toThrow(
      expect.objectContaining({ code: "UNKNOWN_RPC_METHOD" }),
    );
    expect(notifications).toEqual(["initialized"]);
  });

  test("rejects an unknown upstream method", () => {
    expect(() => authorizeCodexClientRequest("thread/futureAuthorityGrant")).toThrow(
      expect.objectContaining({
        code: "UNKNOWN_RPC_METHOD",
        direction: "client",
        method: "thread/futureAuthorityGrant",
      }),
    );
  });

  test("blocks thread/shellCommand before the transport is invoked", async () => {
    const calls: string[] = [];
    const transport: CodexAppServerTransport = {
      async request(method) {
        calls.push(method);
        return {};
      },
      notify() {},
    };
    const adapter = new AgentSubstrateAdapter(
      preflightAgentSubstrate(expected, observed),
      transport,
    );

    await expect(adapter.request("thread/shellCommand", { command: "whoami" })).rejects.toThrow(
      expect.objectContaining({
        code: "FORBIDDEN_RPC_METHOD",
        direction: "client",
        method: "thread/shellCommand",
      }),
    );
    expect(calls).toEqual([]);
  });

  test("never invokes the transport when preflight fails", () => {
    let calls = 0;
    const transport: CodexAppServerTransport = {
      async request() {
        calls += 1;
        return {};
      },
      notify() {},
    };

    expectCompatibilityFailure(
      () => {
        const receipt = preflightAgentSubstrate(expected, {
          ...observed,
          schemaSha256: "5".repeat(64),
        });
        void new AgentSubstrateAdapter(receipt, transport);
      },
      "SCHEMA_MISMATCH",
      "schemaSha256",
    );
    expect(calls).toBe(0);
  });

  test("allows only the brokered dynamic-tool server request", async () => {
    const adapter = new AgentSubstrateAdapter(preflightAgentSubstrate(expected, observed), {
      async request() {
        return {};
      },
      notify() {},
    });
    const calls: string[] = [];

    await expect(
      adapter.dispatchServerRequest("item/tool/call", {}, async (method) => {
        calls.push(method);
        return { denied: true };
      }),
    ).resolves.toEqual({ denied: true });
    expect(calls).toEqual(["item/tool/call"]);

    await expect(
      adapter.dispatchServerRequest("execCommandApproval", {}, async () => {
        throw new Error("must not dispatch");
      }),
    ).rejects.toBeInstanceOf(AgentSubstrateRpcPolicyError);
  });
});
