import { describe, expect, test } from "bun:test";
import { SubmitterCapabilitySchema, type SubmitterCapability } from "@eigengrid/slurm";
import { PipeBackendChannel, serveSubmitterBackendSession } from "./submitter-backend-session";

const capability = (action: "submit" | "observe" = "submit") =>
  SubmitterCapabilitySchema.parse({
    version: "eigengrid.submitter-capability/v1",
    action,
    requestId: "rpc-1",
    subject: "human-1",
    projectId: "project-1",
    uid: 2101,
    gid: 2101,
    recoveryEpoch: "epoch-1",
    membershipGeneration: 3,
    siteProfileDigest: "a".repeat(64),
    operationId: "op-1",
    requestDigest: "b".repeat(64),
    admissionDigest: "c".repeat(64),
    bindingDigest: "d".repeat(64),
    bodyDigest: "e".repeat(64),
    fencingGeneration: 7,
    notBeforeMs: 1000,
    expiresAtMs: 2000,
  });
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const prepare = (action: "submit" | "observe" = "submit") =>
  bytes({ capability: capability(action), body: Buffer.from("TEST").toString("base64") });
function fixture(frames = [prepare(), bytes({ action: "submit" })]) {
  const responses: unknown[] = [],
    events: string[] = [];
  const channel = {
    async readFrame() {
      const frame = frames.shift();
      if (!frame) throw new Error("TEST EOF");
      return frame;
    },
    async requireEnd() {
      if (frames.length) throw new Error("TEST trailing frame");
      events.push("eof");
    },
    async writeFrame(value: unknown) {
      responses.push(value);
    },
  };
  const backend = {
    async prepare(cap: SubmitterCapability) {
      events.push("prepare");
      return { action: cap.action, operationId: cap.operationId };
    },
    async submit() {
      events.push("submit");
      return {
        status: "acknowledged" as const,
        jobId: "45",
        cluster: "fixture-cluster",
        resubmitAllowed: false as const,
      };
    },
    async observe() {
      events.push("observe");
      return {
        status: "indeterminate" as const,
        reason: "TEST",
        observations: [],
        resubmitAllowed: false as const,
      };
    },
  };
  const authorize = async () => {
    events.push("authorize");
  };
  return { channel, backend, responses, events, authorize };
}

describe("protected backend two-frame protocol (no cluster qualification)", () => {
  test("prepares once, requires matching command/EOF and revalidates before effect", async () => {
    const f = fixture();
    await serveSubmitterBackendSession(f.channel, f.backend, f.authorize);
    expect(f.events).toEqual(["authorize", "prepare", "eof", "authorize", "submit"]);
    expect(f.responses).toEqual([
      { status: "prepared", operationId: "op-1" },
      {
        status: "result",
        result: {
          status: "acknowledged",
          jobId: "45",
          cluster: "fixture-cluster",
          resubmitAllowed: false,
        },
      },
    ]);
  });
  test("observation never calls submit", async () => {
    const f = fixture([prepare("observe"), bytes({ action: "observe" })]);
    await serveSubmitterBackendSession(f.channel, f.backend, f.authorize);
    expect(f.events).toEqual(["authorize", "prepare", "eof", "authorize", "observe"]);
  });
  test("EOF, wrong action, repeated action and trailing bytes never dispatch", async () => {
    for (const frames of [
      [prepare()],
      [prepare(), bytes({ action: "observe" })],
      [prepare(), bytes({ action: "submit" }), bytes({ action: "submit" })],
      [prepare(), Buffer.from('{"action":"submit","action":"submit"}')],
    ]) {
      const f = fixture(frames);
      await expect(
        serveSubmitterBackendSession(f.channel, f.backend, f.authorize),
      ).rejects.toThrow();
      expect(f.events).not.toContain("submit");
      expect(f.events).not.toContain("observe");
    }
  });
  test("revocation during preparation closes the effect boundary", async () => {
    const f = fixture();
    let checks = 0;
    await expect(
      serveSubmitterBackendSession(f.channel, f.backend, async () => {
        if (++checks === 2) throw new Error("TEST revoked");
      }),
    ).rejects.toThrow("revoked");
    expect(checks).toBe(2);
    expect(f.events).not.toContain("submit");
  });
  test("duplicate/unknown fields, noncanonical UTF-8/base64/JSON rejected before prepare", async () => {
    const raw = prepare().toString();
    const bad = [
      Buffer.from(raw + "\n"),
      Buffer.from(raw.slice(0, -1) + ',"body":"VEVTVA=="}'),
      bytes({ ...JSON.parse(raw), command: "id" }),
      bytes({ capability: capability(), body: "V EVTVA==" }),
      bytes({ capability: { ...capability(), uid: 0 }, body: "VEVTVA==" }),
      Buffer.from([0xff]),
    ];
    for (const frame of bad) {
      const f = fixture([frame]);
      await expect(
        serveSubmitterBackendSession(f.channel, f.backend, f.authorize),
      ).rejects.toThrow();
      expect(f.events).toEqual([]);
    }
  });
  test("lost-ACK diagnostics are not copied into the durable receipt/wire", async () => {
    const f = fixture();
    const backend = {
      ...f.backend,
      async submit() {
        return {
          status: "indeterminate" as const,
          reason: "sensitive command details",
          resubmitAllowed: false as const,
        };
      },
    };
    await serveSubmitterBackendSession(f.channel, backend, f.authorize);
    expect(f.responses[1]).toEqual({
      status: "result",
      result: { status: "indeterminate", resubmitAllowed: false },
    });
  });
});

function frame(payload: Uint8Array) {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length);
  return Buffer.concat([prefix, payload]);
}
describe("bounded binary pipes", () => {
  test("arbitrary splits/coalescing preserve exact two-frame bytes and output", async () => {
    const a = bytes({ first: "á" }),
      b = bytes({ second: 2 });
    const wire = Buffer.concat([frame(a), frame(b)]);
    const outputs: Uint8Array[] = [];
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of wire) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const channel = new PipeBackendChannel(input, async (value) => {
      outputs.push(value);
    });
    try {
      expect(Buffer.from(await channel.readFrame(100, 1000))).toEqual(a);
      expect(Buffer.from(await channel.readFrame(100, 1000))).toEqual(b);
      await channel.requireEnd(1000);
      await channel.writeFrame({ ok: true });
      expect(Buffer.from(outputs[0]!)).toEqual(frame(bytes({ ok: true })));
    } finally {
      await channel.close();
    }
  });
  test("rejects empty/oversized/truncated frames and extra bytes", async () => {
    for (const wire of [
      Buffer.alloc(4),
      Buffer.from([0, 0, 1, 0]),
      Buffer.from([0, 0]),
      Buffer.from([0, 0, 0, 2, 65]),
    ]) {
      const channel = new PipeBackendChannel(
        new ReadableStream({
          start(c) {
            c.enqueue(wire);
            c.close();
          },
        }),
        async () => {},
      );
      try {
        await expect(channel.readFrame(100, 1000)).rejects.toThrow();
      } finally {
        await channel.close();
      }
    }
    const channel = new PipeBackendChannel(
      new ReadableStream({
        start(c) {
          c.enqueue(Buffer.from("extra"));
          c.close();
        },
      }),
      async () => {},
    );
    try {
      await expect(channel.requireEnd(1000)).rejects.toThrow("Unexpected");
    } finally {
      await channel.close();
    }
  });
  test("an idle stream and oversized response remain bounded", async () => {
    const channel = new PipeBackendChannel(new ReadableStream(), async () => {});
    try {
      await expect(channel.readFrame(100, 20)).rejects.toThrow("deadline");
      await expect(channel.writeFrame("x".repeat(65536))).rejects.toThrow("bound");
    } finally {
      await channel.close();
    }
  });
});
