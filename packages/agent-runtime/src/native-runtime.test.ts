import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeAgentEngine, replayAgentSession } from "./engine";
import {
  InMemoryAgentJournal,
  JsonlAgentJournal,
  AgentConcurrencyError,
  AgentIntegrityError,
  ZERO_AGENT_CURSOR,
} from "./journal";
import {
  agentDigest,
  canonicalAgentJson,
  type AgentInferenceReply,
  type AgentToolCall,
  type AgentToolAuthority,
  type AgentInferencePort,
  type AgentInferenceRequest,
} from "./index";

type Fixture = {
  engine: NativeAgentEngine;
  journal: InMemoryAgentJournal;
  calls: string[];
  approvals: Set<string>;
  changePolicy: (policy: "allow" | "deny" | "ask") => void;
  inferenceCalls: () => number;
};
function response(text: string, calls: readonly AgentToolCall[] = []): AgentInferenceReply {
  return {
    text,
    calls,
    provider: "fixture-llm",
    usage: { inputTokens: 4, outputTokens: 2, cost: 0.001 },
  };
}
function setup(
  replies: readonly AgentInferenceReply[],
  options: {
    policy?: "allow" | "deny" | "ask";
    onEffect?: (call: AgentToolCall) => Promise<void>;
    beforeEffect?: (call: AgentToolCall) => Promise<void>;
    reserveFinalResponse?: boolean;
    inspectRequest?: (request: AgentInferenceRequest) => void;
  } = {},
): Fixture {
  const journal = new InMemoryAgentJournal();
  const calls: string[] = [];
  const approvals = new Set<string>();
  let policy = options.policy ?? "allow";
  let n = 0;
  const inference: AgentInferencePort = {
    infer: async (request) => {
      options.inspectRequest?.(request);
      return replies[n++] ?? response("finished");
    },
  };
  const authority: AgentToolAuthority = {
    describe: () => [
      {
        name: "inspect",
        description: "Typed read-only inspection",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
      },
    ],
    decide: async () => policy,
    verifyApproval: async (call) => approvals.has(call.id),
    execute: async (call) => {
      calls.push(call.id);
      await options.onEffect?.(call);
      return { id: call.id, tool: call.name, ok: true, result: { accepted: true } };
    },
  };
  return {
    engine: new NativeAgentEngine({
      journal,
      inference,
      authority,
      reserveFinalResponse: options.reserveFinalResponse,
      beforeEffect: options.beforeEffect ? async (c) => options.beforeEffect?.(c) : undefined,
    }),
    journal,
    calls,
    approvals,
    changePolicy: (p) => {
      policy = p;
    },
    inferenceCalls: () => n,
  };
}
const limits = {
  maximumSteps: 4,
  maximumToolCalls: 4,
  maximumInputTokens: 1000,
  maximumOutputTokens: 1000,
  maximumCost: 1,
};

describe("native agent native engine: replay, budgets, effects and approval", () => {
  test("recovery rejects reused call IDs before executing any fresh calls in that reply", async () => {
    const f = setup([response("", [{ id: "used", name: "inspect", input: {} }])]);
    f.engine.start({ sessionId: "duplicate-recovery", prompt: "Inspect", limits });
    await f.engine.run("duplicate-recovery");
    // Reproduce a crash after the second observation was committed but before
    // the live loop could enforce cross-step identity uniqueness.
    const records = f.journal.load("duplicate-recovery");
    const journal = new InMemoryAgentJournal();
    let cursor = ZERO_AGENT_CURSOR;
    for (const record of records.slice(0, 5)) {
      cursor = journal.append("duplicate-recovery", cursor, record.event);
    }
    cursor = journal.append("duplicate-recovery", cursor, { type: "inference_requested", step: 2 });
    journal.append("duplicate-recovery", cursor, {
      type: "inference_observed",
      step: 2,
      reply: response("", [
        { id: "used", name: "inspect", input: {} },
        { id: "fresh", name: "inspect", input: {} },
      ]),
    });
    const recovered = new NativeAgentEngine({ ...f.engine.options, journal });
    expect((await recovered.run("duplicate-recovery")).phase).toBe("failed");
    expect(f.calls).toEqual(["used"]);
  });
  test("recovery completes an already observed empty answer without another paid inference", async () => {
    const f = setup([]);
    let s = f.engine.start({ sessionId: "empty-recovery", prompt: "Inspect", limits });
    f.journal.append(s.sessionId, s.cursor, { type: "inference_requested", step: 1 });
    s = f.engine.state(s.sessionId);
    f.journal.append(s.sessionId, s.cursor, {
      type: "inference_observed",
      step: 1,
      reply: response(""),
    });
    expect((await f.engine.run(s.sessionId)).phase).toBe("completed");
    expect(f.inferenceCalls()).toBe(0);
  });
  test("cancellation during authorization prevents the tool effect", async () => {
    const controller = new AbortController();
    const f = setup([response("", [{ id: "cancelled", name: "inspect", input: {} }])], {
      beforeEffect: async () => controller.abort(),
    });
    f.engine.start({ sessionId: "cancel-before-effect", prompt: "Inspect", limits });
    expect((await f.engine.run("cancel-before-effect", controller.signal)).phase).toBe("aborted");
    expect(f.calls).toEqual([]);
    expect((await f.engine.run("cancel-before-effect")).phase).toBe("aborted");
  });
  test("cancellation while deciding policy records no effect intent", async () => {
    const controller = new AbortController();
    const f = setup([response("", [{ id: "cancelled", name: "inspect", input: {} }])]);
    const engine = new NativeAgentEngine({
      ...f.engine.options,
      authority: {
        ...f.engine.options.authority,
        decide: async () => {
          controller.abort();
          return "allow";
        },
      },
    });
    engine.start({ sessionId: "cancel-policy", prompt: "Inspect", limits });
    expect((await engine.run("cancel-policy", controller.signal)).phase).toBe("aborted");
    expect(f.calls).toEqual([]);
    expect(f.journal.load("cancel-policy").some((r) => r.event.type === "effect_intent")).toBe(
      false,
    );
  });
  test("cancellation after an effect starts preserves uncertainty on a lost acknowledgement", async () => {
    const controller = new AbortController();
    const f = setup([response("", [{ id: "started", name: "inspect", input: {} }])], {
      onEffect: async () => {
        controller.abort();
        throw Error("lost ACK");
      },
    });
    f.engine.start({ sessionId: "cancel-during-effect", prompt: "Inspect", limits });
    expect((await f.engine.run("cancel-during-effect", controller.signal)).phase).toBe(
      "uncertain_effect",
    );
    expect((await f.engine.run("cancel-during-effect")).phase).toBe("uncertain_effect");
    expect(f.calls).toEqual(["started"]);
  });
  test("cancellation during a provider call records usage without reporting completion", async () => {
    const controller = new AbortController();
    const f = setup([]);
    const engine = new NativeAgentEngine({
      ...f.engine.options,
      inference: {
        infer: async () => {
          controller.abort();
          return response("late answer");
        },
      },
    });
    engine.start({ sessionId: "cancel-inference", prompt: "Inspect", limits });
    const s = await engine.run("cancel-inference", controller.signal);
    expect(s.phase).toBe("aborted");
    expect(s.inputTokens).toBe(4);
    expect(s.cost).toBe(0.001);
  });
  test("provider accessors are rejected without executing them", async () => {
    let reads = 0;
    const reply = {
      ...response("ok"),
      get text() {
        reads++;
        return "ok";
      },
    };
    const f = setup([reply]);
    f.engine.start({ sessionId: "getter", prompt: "Inspect", limits });
    expect((await f.engine.run("getter")).phase).toBe("failed");
    expect(reads).toBe(0);
  });
  test.each(["approval_pending", "effect_intent"] as const)(
    "replay binds %s to the complete proposed input, not only its call ID",
    (type) => {
      const f = setup([]);
      let s = f.engine.start({ sessionId: "binding", prompt: "Inspect", limits });
      f.journal.append(s.sessionId, s.cursor, { type: "inference_requested", step: 1 });
      s = f.engine.state(s.sessionId);
      f.journal.append(s.sessionId, s.cursor, {
        type: "inference_observed",
        step: 1,
        reply: response("", [{ id: "bound", name: "inspect", input: { id: "reviewed" } }]),
      });
      s = f.engine.state(s.sessionId);
      f.journal.append(s.sessionId, s.cursor, {
        type,
        call: { id: "bound", name: "inspect", input: { id: "substituted" } },
      });
      expect(() => f.engine.state(s.sessionId)).toThrow();
    },
  );
  test("each inference receives only the remaining cumulative session budget", async () => {
    const requests: import("./contracts").AgentInferenceRequest[] = [];
    const journal = new InMemoryAgentJournal();
    const engine = new NativeAgentEngine({
      journal,
      inference: {
        infer: async (request) => {
          requests.push(request);
          return requests.length === 1
            ? {
                ...response("", [{ id: "budget-read", name: "inspect", input: {} }]),
                usage: { inputTokens: 30, outputTokens: 20, cost: 0.6 },
              }
            : response("finished");
        },
      },
      authority: {
        describe: () => [{ name: "inspect", description: "Read", inputSchema: { type: "object" } }],
        decide: async () => "allow",
        execute: async (call) => ({ id: call.id, tool: call.name, ok: true, result: {} }),
      },
    });
    engine.start({ sessionId: "remaining", prompt: "Inspect", limits });
    expect((await engine.run("remaining")).phase).toBe("completed");
    expect(requests[1]!.remainingBudget).toEqual({
      inputTokens: 970,
      outputTokens: 980,
      cost: 0.4,
    });
  });
  test("text accompanying a tool proposal is not a final answer based on unobserved results", async () => {
    const f = setup([
      response("I will inspect the evidence", [
        { id: "mixed", name: "inspect", input: { id: "x" } },
      ]),
      response("The observed result is accepted"),
    ]);
    f.engine.start({ sessionId: "mixed", prompt: "Inspect and explain", limits });
    expect((await f.engine.run("mixed")).text).toBe("The observed result is accepted");
    expect(f.inferenceCalls()).toBe(2);
  });
  test("restarting after durable over-budget usage cannot cross a tool effect boundary", async () => {
    const f = setup([]);
    let state = f.engine.start({ sessionId: "usage-crash", prompt: "Inspect", limits });
    f.journal.append(state.sessionId, state.cursor, { type: "inference_requested", step: 1 });
    state = f.engine.state(state.sessionId);
    f.journal.append(state.sessionId, state.cursor, {
      type: "inference_observed",
      step: 1,
      reply: {
        ...response("", [{ id: "blocked", name: "inspect", input: {} }]),
        usage: { inputTokens: 4, outputTokens: 3, cost: 2 },
      },
    });
    expect((await new NativeAgentEngine(f.engine.options).run(state.sessionId)).phase).toBe(
      "budget_exhausted",
    );
    expect(f.calls).toHaveLength(0);
  });
  test("host reconciliation records an exact observation without executing the uncertain call again", async () => {
    const f = setup(
      [
        response("", [{ id: "recovered", name: "inspect", input: {} }]),
        response("Recovered result observed"),
      ],
      {
        onEffect: async () => {
          throw Error("lost ACK");
        },
      },
    );
    f.engine.start({ sessionId: "reconcile", prompt: "Inspect", limits });
    expect((await f.engine.run("reconcile")).phase).toBe("uncertain_effect");
    expect(() =>
      f.engine.reconcileEffect("reconcile", {
        id: "foreign",
        tool: "inspect",
        ok: true,
        result: {},
      }),
    ).toThrow();
    f.engine.reconcileEffect("reconcile", {
      id: "recovered",
      tool: "inspect",
      ok: true,
      result: { accepted: true },
    });
    expect((await f.engine.run("reconcile")).text).toBe("Recovered result observed");
    expect(f.calls).toEqual(["recovered"]);
  });
  test("advances explicit one-provider-call steps with a durable tool observation", async () => {
    const f = setup([
      response("", [{ id: "x", name: "inspect", input: { id: "protein" } }]),
      response("accepted"),
    ]);
    f.engine.start({ sessionId: "valid", prompt: "inspect protein", limits });
    const s = await f.engine.run("valid");
    expect(s.phase).toBe("completed");
    expect(s.text).toBe("accepted");
    expect(s.steps).toBe(2);
    expect(s.observations).toHaveLength(1);
    expect(f.calls).toEqual(["x"]);
    expect(f.inferenceCalls()).toBe(2);
    expect(f.engine.state("valid")).toEqual(s);
    expect(await f.engine.run("valid")).toEqual(s);
  });

  test("keeps the reserved final response inside the original step and usage budgets", async () => {
    const requests: AgentInferenceRequest[] = [];
    const f = setup(
      [
        response("", [{ id: "first", name: "inspect", input: {} }]),
        response("Here are the observations."),
      ],
      { reserveFinalResponse: true, inspectRequest: (request) => requests.push(request) },
    );
    f.engine.start({
      sessionId: "reserved-answer",
      prompt: "Inspect",
      limits: { ...limits, maximumSteps: 2 },
    });
    const state = await f.engine.run("reserved-answer");
    expect(state.phase).toBe("completed");
    expect(state.steps).toBe(2);
    expect(f.calls).toEqual(["first"]);
    expect(requests[1]?.answerOnly).toBe(true);
    expect(requests[1]?.tools).toEqual([]);
    expect(requests[1]?.observations).toHaveLength(1);
    const exhausted = setup(
      [
        {
          ...response("", [{ id: "never", name: "inspect", input: {} }]),
          usage: { inputTokens: 4, outputTokens: 2, cost: limits.maximumCost + 1 },
        },
      ],
      { reserveFinalResponse: true },
    );
    exhausted.engine.start({
      sessionId: "no-budget-bypass",
      prompt: "Inspect",
      limits: { ...limits, maximumSteps: 2 },
    });
    expect((await exhausted.engine.run("no-budget-bypass")).phase).toBe("budget_exhausted");
    expect(exhausted.inferenceCalls()).toBe(1);
    expect(exhausted.calls).toHaveLength(0);
  });

  test("a provider cannot execute final-round tools, including after a crash and replay", async () => {
    const f = setup(
      [
        response("", [{ id: "first", name: "inspect", input: {} }]),
        response("", [{ id: "forbidden", name: "inspect", input: {} }]),
      ],
      { reserveFinalResponse: true },
    );
    f.engine.start({
      sessionId: "no-final-effect",
      prompt: "Inspect",
      limits: { ...limits, maximumSteps: 2 },
    });
    expect((await f.engine.run("no-final-effect")).phase).toBe("budget_exhausted");
    expect(f.calls).toEqual(["first"]);
    const journal = new InMemoryAgentJournal();
    const recovered = new NativeAgentEngine({ ...f.engine.options, journal });
    for (const record of f.journal.load("no-final-effect").slice(0, -1))
      journal.append(record.sessionId, recovered.state(record.sessionId).cursor, record.event);
    expect((await recovered.run("no-final-effect")).phase).toBe("budget_exhausted");
    expect(f.calls).toEqual(["first"]);
    expect(f.inferenceCalls()).toBe(2);
  });
  test("a fresh consumer deterministically replays recorded observations without reinference", async () => {
    const f = setup([response("done")]);
    f.engine.start({ sessionId: "replay", prompt: "review", limits });
    const a = await f.engine.run("replay");
    expect(replayAgentSession("replay", f.journal.load("replay"))).toEqual(a);
    expect(f.inferenceCalls()).toBe(1);
    expect(await f.engine.run("replay")).toEqual(a);
    expect(f.inferenceCalls()).toBe(1);
  });
  test("two racing agents cannot duplicate inference or an effect", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const journal = new InMemoryAgentJournal();
    let calls = 0;
    const inference: AgentInferencePort = {
      infer: async () => {
        calls++;
        await gate;
        return response("race complete");
      },
    };
    const authority: AgentToolAuthority = {
      describe: () => [],
      decide: async () => "deny",
      execute: async () => {
        throw Error("never");
      },
    };
    const first = new NativeAgentEngine({ journal, inference, authority });
    const second = new NativeAgentEngine({ journal, inference, authority });
    first.start({ sessionId: "race", prompt: "once", limits });
    const pending = first.run("race");
    // Allow the async continuation of the first invocation to append inference_requested.
    await Promise.resolve();
    const duplicate = await second.run("race");
    expect(duplicate.phase).toBe("inference_pending");
    expect(calls).toBe(1);
    release();
    expect((await pending).phase).toBe("completed");
  });
  test("unacknowledged tool intent is never replayed after an exception", async () => {
    const f = setup([response("", [{ id: "crash", name: "inspect", input: { id: "x" } }])], {
      onEffect: async () => {
        throw Error("lost ACK");
      },
    });
    f.engine.start({ sessionId: "unknown-effect", prompt: "inspect", limits });
    expect((await f.engine.run("unknown-effect")).phase).toBe("uncertain_effect");
    const clone = new NativeAgentEngine(f.engine.options);
    expect((await clone.run("unknown-effect")).phase).toBe("uncertain_effect");
    expect(f.calls).toEqual(["crash"]);
  });
  test("ask means a durable waiting state until a host binds an approval to the call", async () => {
    const f = setup(
      [
        response("", [{ id: "approval", name: "inspect", input: { id: "lot-18" } }]),
        response("ok"),
      ],
      { policy: "ask" },
    );
    f.engine.start({ sessionId: "need-approval", prompt: "review", limits });
    expect((await f.engine.run("need-approval")).phase).toBe("awaiting_approval");
    expect(f.calls).toHaveLength(0);
    expect((await f.engine.run("need-approval")).phase).toBe("awaiting_approval");
    f.approvals.add("approval");
    expect((await f.engine.run("need-approval")).phase).toBe("completed");
    expect(f.calls).toEqual(["approval"]);
  });
  test("revocation of an approval blocks execution", async () => {
    const f = setup([response("", [{ id: "approval", name: "inspect", input: { id: "x" } }])], {
      policy: "ask",
    });
    f.engine.start({ sessionId: "revoked", prompt: "review", limits });
    await f.engine.run("revoked");
    f.changePolicy("deny");
    f.approvals.add("approval");
    expect((await f.engine.run("revoked")).phase).toBe("failed");
    expect(f.calls).toHaveLength(0);
  });
  test("permissions are checked again immediately before the effect", async () => {
    let revoke!: () => void;
    const f = setup(
      [response("", [{ id: "revoked-midflight", name: "inspect", input: { id: "x" } }])],
      {
        beforeEffect: async () => revoke(),
      },
    );
    revoke = () => f.changePolicy("deny");
    f.engine.start({ sessionId: "revocation", prompt: "inspect", limits });
    expect((await f.engine.run("revocation")).phase).toBe("uncertain_effect");
    expect(f.calls).toHaveLength(0);
  });
  test("cost overruns stop before tool execution", async () => {
    const f = setup([
      {
        ...response("", [{ id: "expensive", name: "inspect", input: { id: "x" } }]),
        usage: { inputTokens: 4, outputTokens: 3, cost: 1.5 },
      },
    ]);
    f.engine.start({ sessionId: "over-budget", prompt: "review", limits });
    expect((await f.engine.run("over-budget")).phase).toBe("budget_exhausted");
    expect(f.calls).toHaveLength(0);
  });
  test("repeated cross-step call IDs cannot cause a repeated effect", async () => {
    const same = { id: "repeated", name: "inspect", input: { id: "x" } };
    const f = setup([response("", [same]), response("", [same])]);
    f.engine.start({ sessionId: "duplicate-call", prompt: "review", limits });
    expect((await f.engine.run("duplicate-call")).phase).toBe("failed");
    expect(f.calls).toEqual(["repeated"]);
  });
  test("missing provider stops with no tools executed", async () => {
    const f = setup([]);
    const engine = new NativeAgentEngine({
      journal: f.journal,
      inference: {
        infer: async () => {
          throw Error("provider unavailable");
        },
      },
      authority: f.engine.options.authority,
    });
    engine.start({ sessionId: "offline", prompt: "review", limits });
    const s = await engine.run("offline");
    expect(s.phase).toBe("failed");
    expect(s.detail).toContain("provider unavailable");
    expect(f.calls).toEqual([]);
  });
  test("explicit recovery can retry an interrupted inference but not an uncertain tool effect", async () => {
    const f = setup([response("finished")]);
    let s = f.engine.start({ sessionId: "interrupted", prompt: "continue", limits });
    f.journal.append("interrupted", s.cursor, { type: "inference_requested", step: 1 });
    expect((await f.engine.run("interrupted")).phase).toBe("inference_pending");
    s = f.engine.recoverInterruptedInference("interrupted");
    expect(s.phase).toBe("ready");
    expect((await f.engine.run("interrupted")).phase).toBe("completed");
  });
  test("missing, stale and conflicting session cursors reject concurrent writes", () => {
    const journal = new InMemoryAgentJournal();
    const first = journal.append("cas", ZERO_AGENT_CURSOR, {
      type: "started",
      prompt: "test",
      limits,
    });
    expect(() =>
      journal.append("cas", ZERO_AGENT_CURSOR, { type: "started", prompt: "test", limits }),
    ).toThrow(AgentConcurrencyError);
    expect(first.sequence).toBe(1);
  });
  test("rejects adversarial provider prototype, cycles and accessor payloads", () => {
    const loop: { self?: unknown } = {};
    loop.self = loop;
    expect(() => canonicalAgentJson(loop)).toThrow();
    expect(() =>
      canonicalAgentJson({
        get value() {
          throw Error("getter");
        },
      }),
    ).toThrow();
    expect(() => canonicalAgentJson(new Date())).toThrow();
    expect(agentDigest({ a: 2, b: 1 })).toBe(agentDigest({ b: 1, a: 2 }));
  });
});

describe("native agent JSONL durable journal: disk integrity and fencing", () => {
  test("rejects tampering, incomplete tails and concurrent writes with fresh process-like handles", () => {
    const dir = mkdtempSync(join(tmpdir(), "eigengrid-agent-journal-"));
    try {
      const one = new JsonlAgentJournal(dir);
      const two = new JsonlAgentJournal(dir);
      const first = one.append("file", ZERO_AGENT_CURSOR, {
        type: "started",
        prompt: "hello",
        limits,
      });
      expect(two.load("file")).toHaveLength(1);
      expect(() =>
        two.append("file", ZERO_AGENT_CURSOR, { type: "started", prompt: "wrong", limits }),
      ).toThrow(AgentConcurrencyError);
      const file = join(dir, "file.jsonl");
      let contents = readFileSync(file, "utf-8");
      writeFileSync(file, contents.replace("hello", "evil"), { mode: 0o600 });
      expect(() => one.load("file")).toThrow(AgentIntegrityError);
      writeFileSync(file, contents + '{"bad":', { mode: 0o600 });
      expect(() => one.load("file")).toThrow(AgentIntegrityError);
      writeFileSync(file, contents, { mode: 0o600 });
      expect(two.load("file")[0].digest).toBe(first.digest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
