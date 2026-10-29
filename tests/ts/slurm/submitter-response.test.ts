import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import {
  createSlurmSubmissionBinding,
  decodeSubmitterResponse,
  signSubmitterCapability,
  slurmSubmissionJobName,
  slurmSubmissionMarker,
} from "@eigengrid/slurm";

const dispatchNow = 1_789_885_000_000;
const binding = createSlurmSubmissionBinding({
  operationId: "operation-1",
  requestDigest: "a".repeat(64),
  admissionDigest: "b".repeat(64),
  scriptDigest: "c".repeat(64),
  siteProfileDigest: "d".repeat(64),
  cluster: "fixture-cluster",
  uid: 2101,
  notBefore: "2026-09-20T05:00:00.000Z",
  expiresAt: "2026-09-20T05:05:00.000Z",
  resources: {
    partition: "chem",
    node: "worker-01",
    account: "m2",
    cpus: 1,
    memoryMiB: 1024,
    walltimeSeconds: 300,
  },
});
const body = Buffer.from('{"kind":"test-only-counted-effect"}');

function expectation(action: "submit" | "observe") {
  return { operationId: binding.operationId, action, binding };
}

function schedulerObservation() {
  return {
    source: "sacct",
    jobId: "45",
    cluster: binding.cluster,
    uid: binding.uid,
    submittedAt: "2026-09-20T05:00:01Z",
    jobName: slurmSubmissionJobName(binding),
    marker: slurmSubmissionMarker(binding),
  };
}

function matchedObservationResponse() {
  const observation = schedulerObservation();
  return {
    status: "observation",
    operationId: binding.operationId,
    resubmitAllowed: false,
    observation: {
      status: "matched",
      resubmitAllowed: false,
      reason: "One exact durable scheduler identity; this is not execution or scientific success",
      observations: [observation],
      markerEvidence: "accounting_comment",
      identity: {
        jobId: observation.jobId,
        cluster: observation.cluster,
        uid: observation.uid,
        submittedAt: observation.submittedAt,
      },
    },
  };
}

const PythonBoundaryFixturesSchema = z
  .object({
    consumed: z.unknown(),
    alreadyConsumed: z.unknown(),
    observation: z.unknown(),
    rejected: z.unknown(),
  })
  .strict();

/** Produces real submit/replay/observe replies through TransportJournal and
 * SubmitterBoundary. The test-only backend is only the bounded Slurm result;
 * it does not bypass the Python serializer, signature, claim, or receipt code. */
async function pythonBoundaryFixtures() {
  const key = generateKeyPairSync("ed25519");
  const privateKeyPem = key.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyHex = Buffer.from(key.publicKey.export({ type: "spki", format: "der" }))
    .subarray(12)
    .toString("hex");
  const capability = (action: "submit" | "observe", requestId: string) =>
    signSubmitterCapability(
      {
        action,
        requestId,
        subject: "human-1",
        projectId: "project-1",
        uid: binding.uid,
        gid: 2911,
        recoveryEpoch: "site-epoch-1",
        membershipGeneration: 3,
        siteProfileDigest: binding.siteProfileDigest,
        operationId: binding.operationId,
        requestDigest: binding.requestDigest,
        admissionDigest: binding.admissionDigest,
        bindingDigest: binding.bindingDigest,
        fencingGeneration: 17,
        notBeforeMs: dispatchNow - 1_000,
        expiresAtMs: dispatchNow + 30_000,
      },
      body,
      privateKeyPem,
    );
  const submit = capability("submit", "rpc-1");
  const observe = capability("observe", "rpc-2");
  const script = [
    "import base64,json,os,sys,tempfile",
    `sys.path.insert(0, ${JSON.stringify(resolve("python/src"))})`,
    "from eigengrid_submitter.authority import SubmitterPolicy, compact_json",
    "from eigengrid_submitter.boundary import SubmitterBoundary",
    "from eigengrid_submitter.journal import TransportJournal, bootstrap_record",
    "payload=json.loads(sys.stdin.buffer.read())",
    "class Backend:",
    " def prepare(self, request): return request",
    " def submit(self, prepared): return {'status':'acknowledged','resubmitAllowed':False,'jobId':'45','cluster':'fixture-cluster'}",
    " def observe(self, prepared): return payload['observation']",
    " def release(self, prepared): pass",
    "policy=SubmitterPolicy(uid=2101,gid=2911,head_uid=997,recovery_epoch='site-epoch-1',site_profile_digest='d'*64,public_key_hex=payload['publicKeyHex'],memberships={('human-1','project-1'):3})",
    "with tempfile.TemporaryDirectory(dir='/tmp') as directory:",
    " path=os.path.join(directory,'journal')",
    " with open(path,'xb') as stream:",
    "  stream.write(bootstrap_record('gateway-1',2101)); stream.flush(); os.fsync(stream.fileno())",
    " os.chmod(path,0o600)",
    " fd=os.open(path,os.O_RDWR|os.O_APPEND|os.O_CLOEXEC)",
    " try: journal=TransportJournal(fd,'gateway-1',2101,owner_uid=os.getuid())",
    " finally: os.close(fd)",
    " try:",
    "  boundary=SubmitterBoundary(journal,lambda: policy,Backend(),lambda: 1789885000000)",
    "  consumed=boundary.handle(base64.b64decode(payload['submitWire']),997)",
    "  already=boundary.handle(base64.b64decode(payload['submitWire']),997)",
    "  observed=boundary.handle(base64.b64decode(payload['observeWire']),997)",
    "  sys.stdout.buffer.write(compact_json({'consumed':consumed,'alreadyConsumed':already,'observation':observed,'rejected':{'status':'rejected','resubmitAllowed':False}}))",
    " finally: journal.close()",
  ].join("\n");
  const process = Bun.spawn(["python3", "-I", "-c", script], {
    stdin: Buffer.from(
      JSON.stringify({
        submitWire: Buffer.from(submit.wire).toString("base64"),
        observeWire: Buffer.from(observe.wire).toString("base64"),
        publicKeyHex,
        observation: matchedObservationResponse().observation,
      }),
    ),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0 || stderr !== "") throw new Error("Python submitter boundary fixture failed");
  return PythonBoundaryFixturesSchema.parse(JSON.parse(stdout));
}

describe("typed per-UID submitter responses", () => {
  test("decodes real Python boundary submit, replay, observe, and reject shapes", async () => {
    const fixture = await pythonBoundaryFixtures();

    const consumed = decodeSubmitterResponse(fixture.consumed, expectation("submit"));
    expect(consumed.status).toBe("consumed");
    if (consumed.status !== "consumed") throw new Error("Expected consumed submitter response");
    expect(consumed.receipt).toEqual({
      status: "acknowledged",
      resubmitAllowed: false,
      jobId: "45",
      cluster: binding.cluster,
    });

    const already = decodeSubmitterResponse(fixture.alreadyConsumed, expectation("submit"));
    expect(already.status).toBe("already_consumed");
    if (already.status !== "already_consumed")
      throw new Error("Expected already-consumed submitter response");
    expect(already.requiresReconciliation).toBe(true);

    const observed = decodeSubmitterResponse(fixture.observation, expectation("observe"));
    expect(observed.status).toBe("observation");
    if (observed.status !== "observation")
      throw new Error("Expected observation submitter response");
    expect(observed.observation.status).toBe("matched");

    expect(decodeSubmitterResponse(fixture.rejected, expectation("submit"))).toEqual({
      status: "rejected",
      resubmitAllowed: false,
    });
  });

  test("binds receipt and operation to the immutable expected submit delivery", () => {
    const consumed = {
      status: "consumed",
      operationId: binding.operationId,
      resubmitAllowed: false,
      receipt: {
        status: "acknowledged",
        resubmitAllowed: false,
        jobId: "45",
        cluster: binding.cluster,
      },
      requiresReconciliation: true,
    };
    expect(decodeSubmitterResponse(consumed, expectation("submit")).status).toBe("consumed");

    const indeterminateReceipt = decodeSubmitterResponse(
      { ...consumed, receipt: { status: "indeterminate", resubmitAllowed: false } },
      expectation("submit"),
    );
    expect(indeterminateReceipt.status).toBe("consumed");
    if (indeterminateReceipt.status !== "consumed")
      throw new Error("Expected consumed indeterminate submitter response");
    expect(indeterminateReceipt.receipt.status).toBe("indeterminate");

    for (const value of [
      { ...consumed, operationId: "other-operation" },
      { ...consumed, resubmitAllowed: true },
      { ...consumed, requiresReconciliation: "true" },
      { ...consumed, receipt: null },
      { ...consumed, receipt: { ...consumed.receipt, cluster: "other-cluster" } },
      { ...consumed, receipt: { ...consumed.receipt, jobId: 45 } },
      { ...consumed, receipt: { ...consumed.receipt, unknown: "field" } },
      { ...consumed, receipt: { status: "indeterminate", resubmitAllowed: true } },
      { ...consumed, unknown: "field" },
    ])
      expect(() => decodeSubmitterResponse(value, expectation("submit"))).toThrow();

    for (const jobId of ["0", "00045", "45.batch", "45_2", "4294967296"])
      expect(() =>
        decodeSubmitterResponse(
          { ...consumed, receipt: { ...consumed.receipt, jobId } },
          expectation("submit"),
        ),
      ).toThrow();

    const replayWithoutReceipt = {
      status: "already_consumed",
      operationId: binding.operationId,
      resubmitAllowed: false,
      receipt: null,
      requiresReconciliation: true,
    };
    expect(decodeSubmitterResponse(replayWithoutReceipt, expectation("submit"))).toEqual(
      replayWithoutReceipt,
    );
    expect(() => decodeSubmitterResponse(consumed, expectation("observe"))).toThrow();
    expect(() =>
      decodeSubmitterResponse(
        { status: "rejected", resubmitAllowed: false, operationId: binding.operationId },
        expectation("submit"),
      ),
    ).toThrow();
  });

  test("validates nested scheduler evidence while retaining conflict and indeterminacy", () => {
    const matched = matchedObservationResponse();
    expect(decodeSubmitterResponse(matched, expectation("observe")).status).toBe("observation");

    const observation = schedulerObservation();
    for (const value of [
      { ...matched, resubmitAllowed: true },
      { ...matched, operationId: "other-operation" },
      {
        ...matched,
        observation: {
          ...matched.observation,
          identity: { ...matched.observation.identity, jobId: "46" },
        },
      },
      {
        ...matched,
        observation: { ...matched.observation, observations: [observation, observation] },
      },
      {
        ...matched,
        observation: {
          ...matched.observation,
          observations: [{ ...observation, jobId: "45.batch" }],
        },
      },
      { ...matched, observation: { ...matched.observation, markerEvidence: "untrusted" } },
      { ...matched, observation: { ...matched.observation, identity: undefined } },
      { ...matched, observation: { ...matched.observation, unknown: "field" } },
    ])
      expect(() => decodeSubmitterResponse(value, expectation("observe"))).toThrow();

    expect(() => decodeSubmitterResponse(matched, expectation("submit"))).toThrow();
    const indeterminate = {
      status: "observation",
      operationId: binding.operationId,
      resubmitAllowed: false,
      observation: {
        status: "indeterminate",
        resubmitAllowed: false,
        reason: "No durable accounting match yet",
        observations: [],
      },
    };
    expect(decodeSubmitterResponse(indeterminate, expectation("observe"))).toEqual(indeterminate);

    const conflict = {
      ...indeterminate,
      observation: {
        status: "conflict",
        resubmitAllowed: false,
        reason: "Submission evidence differs from its binding",
        observations: [{ ...observation, cluster: "other-cluster" }],
      },
    };
    const decodedConflict = decodeSubmitterResponse(conflict, expectation("observe"));
    expect(decodedConflict.status).toBe("observation");
    if (decodedConflict.status !== "observation") throw new Error("Expected observation conflict");
    expect(decodedConflict.observation.status).toBe("conflict");

    for (const value of [null, [], "response", { status: "future", resubmitAllowed: false }])
      expect(() => decodeSubmitterResponse(value, expectation("submit"))).toThrow();
  });
});
