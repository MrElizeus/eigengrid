import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentDigest,
  type AgentInferencePort,
  type AgentToolCall,
  type AgentInferenceReply,
} from "@eigengrid/agent-runtime";
import {
  AgentSessionService,
  type AgentPrincipal,
  type AgentSessionIdentity,
  type AgentSessionEffects,
} from "./agent-sessions";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const input = {
  projectId: "project-a",
  missionId: "mission-one",
  prompt: "run a reviewed mission",
};
const call: AgentToolCall = {
  id: "call-one",
  name: "mission-start",
  input: {
    projectId: "project-a",
    missionId: "mission-one",
    planId: "plan-1",
    candidateDigest: "a".repeat(64),
  },
};
function reply(text: string, calls: readonly AgentToolCall[] = []): AgentInferenceReply {
  return { text, calls, provider: "test", usage: { inputTokens: 1, outputTokens: 2, cost: 0.001 } };
}
function fixture(
  options: { replies?: AgentInferenceReply[]; effectFailure?: boolean; effectDelay?: number } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "eigengrid-session-"));
  chmodSync(root, 0o700);
  roots.push(root);
  let current: AgentPrincipal = {
    actorId: "scientist-a",
    projectId: input.projectId,
    missionId: input.missionId,
    policyDigest: "1".repeat(64),
  };
  let access = true,
    permission: "ask" | "deny" | "allow" = "ask",
    now = 10_000;
  let inferenceCount = 0,
    effectCount = 0,
    reconcileCount = 0;
  const script = options.replies ?? [reply("", [call]), reply("complete")];
  const model: AgentInferencePort = {
    infer: async () => script[inferenceCount++] ?? reply("complete"),
  };
  const identity: AgentSessionIdentity = {
    current: async (address) => {
      if (
        !access ||
        current.projectId !== address.projectId ||
        current.missionId !== address.missionId
      )
        throw new Error("Protected mission access revoked");
      return { ...current };
    },
    assertCurrent: async (expected) => {
      if (
        !access ||
        Object.keys(current).some(
          (key) => current[key as keyof AgentPrincipal] !== expected[key as keyof AgentPrincipal],
        )
      )
        throw new Error("Current access, actor or policy changed");
    },
  };
  const effects: AgentSessionEffects = {
    tools: {
      describe: () => [
        {
          name: "mission-start",
          description: "Canonical verified start",
          inputSchema: { type: "object", additionalProperties: false },
        },
      ],
      decide: async () => permission,
      execute: async (c) => {
        effectCount++;
        if (options.effectDelay) await Bun.sleep(options.effectDelay);
        if (options.effectFailure) throw new Error("ACK lost after effect");
        return { id: c.id, tool: c.name, ok: true, result: { operationId: "one" } };
      },
    },
    observeUncertain: async () => {
      reconcileCount++;
      return { status: "UNKNOWN" };
    },
  };
  const construct = () => new AgentSessionService(root, identity, model, effects, () => now);
  const service = construct();
  return {
    root,
    service,
    construct,
    identity,
    effects,
    setActor: (actorId: string) => {
      current = { ...current, actorId };
    },
    setProject: (projectId: string) => {
      current = { ...current, projectId };
    },
    setPolicy: (policyDigest: string) => {
      current = { ...current, policyDigest };
    },
    revoke: () => {
      access = false;
    },
    policy: (p: typeof permission) => {
      permission = p;
    },
    advance: (ms: number) => {
      now += ms;
    },
    effectsCalled: () => effectCount,
    inferencesCalled: () => inferenceCount,
    reconciled: () => reconcileCount,
  };
}
async function pending(f: ReturnType<typeof fixture>) {
  const original = await f.service.open(input);
  const result = await f.service.resume(original.sessionId);
  expect(result.phase).toBe("awaiting_approval");
  return result;
}
function approval(state: import("@eigengrid/agent-runtime").AgentSession) {
  return {
    callId: state.call!.id,
    inputDigest: agentDigest(state.call!.input),
    cursor: state.cursor,
    ttlSeconds: 40,
  };
}
describe("application host-owned sessions, policy and replay", () => {
  test("two real Head processes race without duplicating a call; SIGKILL requires observed reconciliation", async () => {
    const fixturePath = new URL(
      "../../../../tests/fixtures/agent-session-process.ts",
      import.meta.url,
    ).pathname;
    const f = fixture();
    const s = await pending(f);
    await f.service.approve(s.sessionId, approval(s));
    const marker = join(f.root, "effect-marker");
    const children = [0, 1].map(() =>
      Bun.spawn([process.execPath, fixturePath, f.root, s.sessionId, "normal", marker], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const exits = await Promise.all(children.map((child) => child.exited));
    for (let i = 0; i < children.length; i++) {
      if (exits[i] !== 0)
        expect(await new Response(children[i]!.stderr).text()).toContain("AgentConcurrencyError");
    }
    const markerCalls = () =>
      existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n") : [];
    const checkpoint = await f.construct().observe(s.sessionId);
    const beforeRecovery = markerCalls();
    expect(beforeRecovery.length).toBeLessThanOrEqual(1);
    // CAS is per event. Contention can stop both writers, including after an
    // intent or an effect. An unknown checkpoint must stay fenced on resume.
    if (["inference_pending", "tool_pending", "uncertain_effect"].includes(checkpoint.phase)) {
      expect((await f.construct().resume(s.sessionId)).phase).toBe(checkpoint.phase);
      expect(markerCalls()).toEqual(beforeRecovery);
    } else {
      expect(["ready", "awaiting_approval", "completed"]).toContain(checkpoint.phase);
      expect(checkpoint.observations.filter((o) => o.id === call.id)).toHaveLength(
        beforeRecovery.length,
      );
      // A fresh caller resumes only a proven safe checkpoint. The killed-process
      // case below separately proves readback recovery of an uncertain effect.
      const recovery = Bun.spawn(
        [process.execPath, fixturePath, f.root, s.sessionId, "normal", marker],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await recovery.exited).toBe(0);
      expect((await f.construct().observe(s.sessionId)).phase).toBe("completed");
      expect(markerCalls()).toEqual([call.id]);
    }
    expect(markerCalls().every((id) => id === call.id)).toBe(true);
    expect(markerCalls().length).toBeLessThanOrEqual(1);
    const killed = fixture();
    const state = await pending(killed);
    await killed.service.approve(state.sessionId, approval(state));
    const killedMarker = join(killed.root, "effect-marker");
    const child = Bun.spawn(
      [process.execPath, fixturePath, killed.root, state.sessionId, "kill", killedMarker],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).not.toBe(0);
    expect((await killed.construct().resume(state.sessionId)).phase).toBe("tool_pending");
    expect(readFileSync(killedMarker, "utf8").trim()).toBe(call.id);
    const recovered = new AgentSessionService(
      killed.root,
      killed.identity,
      { infer: async () => reply("recovered") },
      {
        ...killed.effects,
        observeUncertain: async () => ({
          status: "RESOLVED",
          receiptId: "process-fixture-only",
          observation: { id: call.id, tool: call.name, ok: true, result: { synthetic: true } },
        }),
      },
    );
    await recovered.reconcile(state.sessionId);
    expect((await recovered.resume(state.sessionId)).phase).toBe("completed");
    expect(readFileSync(killedMarker, "utf8").trim().split("\n")).toHaveLength(1);
  }, 15000);
  test("duplicate open keys return the same persisted session and conflicting prompts are rejected", async () => {
    const f = fixture();
    const one = await f.service.open({ ...input, requestId: "client-open-1" });
    const two = await f.construct().open({ ...input, requestId: "client-open-1" });
    expect(two.sessionId).toBe(one.sessionId);
    expect(
      (await f.construct().findOpened({ ...input, requestId: "client-open-1" }))?.sessionId,
    ).toBe(one.sessionId);
    await expect(
      f.service.open({ ...input, requestId: "client-open-1", prompt: "changed" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.inferencesCalled()).toBe(0);
  });
  test("persists an agent session; a second Head can observe and resume exact pending state", async () => {
    const f = fixture();
    const s = await pending(f);
    const otherHead = f.construct();
    expect((await otherHead.observe(s.sessionId)).cursor).toEqual(s.cursor);
    const grant = await otherHead.approve(s.sessionId, approval(s));
    expect(grant.inputDigest).toBe(agentDigest(call.input));
    const done = await f.service.resume(s.sessionId);
    expect(done.phase).toBe("completed");
    expect(f.effectsCalled()).toBe(1);
    expect((await otherHead.resume(s.sessionId)).phase).toBe("completed");
    expect(f.effectsCalled()).toBe(1);
    expect((await otherHead.events(s.sessionId, 0, 2)).events).toHaveLength(2);
    const page = await otherHead.events(s.sessionId, done.cursor.sequence - 1);
    expect(page.cursor).toBe(done.cursor.sequence);
  });

  test("no new scientific effect without a host approval bound to call input and cursor", async () => {
    const f = fixture();
    const s = await pending(f);
    expect((await f.service.resume(s.sessionId)).phase).toBe("awaiting_approval");
    expect(f.effectsCalled()).toBe(0);
    await expect(
      f.service.approve(s.sessionId, { ...approval(s), inputDigest: "f".repeat(64) }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      f.service.approve(s.sessionId, { ...approval(s), cursor: { ...s.cursor, sequence: 0 } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      f.service.approve(s.sessionId, { ...approval(s), ttlSeconds: 901 }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(f.effectsCalled()).toBe(0);
  });

  test("expiry, current policy and read-only invocation errors fail closed", async () => {
    const f = fixture();
    const s = await pending(f);
    await f.service.approve(s.sessionId, approval(s));
    f.advance(40_001);
    expect((await f.service.resume(s.sessionId)).phase).toBe("awaiting_approval");
    expect(f.effectsCalled()).toBe(0);
    const renewed = await f.service.approve(s.sessionId, approval(s));
    expect(renewed.expiresAtMs).toBeGreaterThan(50_001);
    f.policy("deny");
    expect((await f.service.resume(s.sessionId)).phase).toBe("failed");
    expect(f.effectsCalled()).toBe(0);
  });

  test("actor, mission and policy revocation block observation, approval and execution", async () => {
    for (const change of ["actor", "project", "policy", "revoked"] as const) {
      const f = fixture();
      const s = await pending(f);
      if (change === "actor") f.setActor("attacker");
      if (change === "project") f.setProject("other");
      if (change === "policy") f.setPolicy("2".repeat(64));
      if (change === "revoked") f.revoke();
      await expect(f.service.observe(s.sessionId)).rejects.toThrow();
      await expect(f.service.approve(s.sessionId, approval(s))).rejects.toThrow();
      await expect(f.service.resume(s.sessionId)).rejects.toThrow();
      expect(f.effectsCalled()).toBe(0);
    }
  });

  test("durable cancel tombstone persists across processes and never fabricates completion", async () => {
    const f = fixture();
    const s = await pending(f);
    await f.service.cancel(s.sessionId);
    await f.service.cancel(s.sessionId);
    await expect(f.construct().resume(s.sessionId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(f.service.approve(s.sessionId, approval(s))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(f.effectsCalled()).toBe(0);
    expect((await f.construct().observe(s.sessionId)).phase).toBe("awaiting_approval");
  });

  test("lost acknowledgement is uncertain, never a second submit; reconcile observes only", async () => {
    const f = fixture({ effectFailure: true });
    const s = await pending(f);
    await f.service.approve(s.sessionId, approval(s));
    const uncertain = await f.service.resume(s.sessionId);
    expect(uncertain.phase).toBe("uncertain_effect");
    expect(f.effectsCalled()).toBe(1);
    expect((await f.construct().resume(s.sessionId)).phase).toBe("uncertain_effect");
    expect(f.effectsCalled()).toBe(1);
    expect(await f.construct().reconcile(s.sessionId)).toEqual({ status: "UNKNOWN" });
    expect(f.reconciled()).toBe(1);
  });

  test("two simultaneous resume requests never admit two tool effects", async () => {
    const f = fixture({ effectDelay: 20 });
    const s = await pending(f);
    await f.service.approve(s.sessionId, approval(s));
    const outcomes = await Promise.allSettled([
      f.service.resume(s.sessionId),
      f.construct().resume(s.sessionId),
    ]);
    expect(outcomes.some((x) => x.status === "fulfilled")).toBe(true);
    expect(f.effectsCalled()).toBe(1);
    expect((await f.service.observe(s.sessionId)).phase).toBe("completed");
  });

  test("unknown, cross-session, invalid cursors and malformed storage are rejected", async () => {
    const f = fixture();
    await expect(f.service.observe("not-an-id")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(f.service.observe("00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const s = await pending(f);
    await expect(f.service.events(s.sessionId, -1)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(f.service.events(s.sessionId, 0, 257)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(f.service.events(s.sessionId, 10000)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(f.service.reconcile(s.sessionId)).rejects.toMatchObject({ code: "CONFLICT" });
    const journal = join(f.root, "journal", s.sessionId + ".jsonl");
    writeFileSync(journal, "tampered\n", { mode: 0o600 });
    await expect(f.service.observe(s.sessionId)).rejects.toThrow();
  });

  test("symlinked session metadata and insecure storage cannot impersonate a session", async () => {
    const f = fixture();
    const s = await pending(f);
    const scopePath = join(f.root, "scopes", s.sessionId + ".json");
    const bytes = readFileSync(scopePath);
    rmSync(scopePath);
    const external = join(f.root, "external");
    writeFileSync(external, bytes, { mode: 0o600 });
    symlinkSync(external, scopePath);
    await expect(f.service.observe(s.sessionId)).rejects.toMatchObject({ code: "CONFLICT" });
    const unsafe = mkdtempSync(join(tmpdir(), "eigengrid-session-unsafe-"));
    roots.push(unsafe);
    chmodSync(unsafe, 0o777);
    expect(
      () =>
        new AgentSessionService(unsafe, f.identity, { infer: async () => reply("x") }, f.effects),
    ).toThrow("not private");
  });

  test("no provider is needed to open and observe; inference is only invoked on resume", async () => {
    const f = fixture();
    const opened = await f.service.open(input);
    expect(opened.phase).toBe("ready");
    expect(f.inferencesCalled()).toBe(0);
    expect((await f.service.observe(opened.sessionId)).phase).toBe("ready");
    expect(f.inferencesCalled()).toBe(0);
    await f.service.resume(opened.sessionId);
    expect(f.inferencesCalled()).toBe(1);
  });
});
