import { describe, expect, test } from "bun:test";
import liveJob43 from "../../fixtures/slurm/submission-23.11.4-job43-live.json";
import {
  assertSlurmSubmissionBinding,
  createSlurmSubmissionBinding,
  parseSlurmSubmissionObservations,
  resolveSlurmSubmission,
  slurmScriptDigest,
  slurmSubmissionJobName,
  slurmSubmissionMarker,
  type SlurmSubmissionBinding,
  type SlurmSubmissionObservation,
} from "@eigengrid/slurm";

const script = Buffer.from("#!/bin/bash\n/usr/bin/true\n");
const input = {
  operationId: "operation-qualification-1",
  requestDigest: "a".repeat(64),
  admissionDigest: "b".repeat(64),
  scriptDigest: slurmScriptDigest(script),
  siteProfileDigest: "c".repeat(64),
  cluster: "fixture-cluster",
  uid: 2101,
  notBefore: "2026-09-20T05:00:00.200Z",
  expiresAt: "2026-09-20T05:05:00.000Z",
  resources: {
    partition: "chem",
    node: "worker-01",
    account: "chem",
    cpus: 1,
    memoryMiB: 128,
    walltimeSeconds: 120,
  },
};
const binding = createSlurmSubmissionBinding(input);
const observation = (source: "sacct" | "squeue" = "sacct"): SlurmSubmissionObservation => ({
  source,
  jobId: "43",
  cluster: "fixture-cluster",
  uid: 2101,
  submittedAt: "2026-09-20T05:00:01Z",
  jobName: slurmSubmissionJobName(binding),
  marker: slurmSubmissionMarker(binding),
});
const complete = { accounting: true, queue: true };

describe("Slurm submission identity, independent of execution outcome", () => {
  test("anonymized job 43: durable full-digest name plus exact queue comment survives comment delay", () => {
    const captured = assertSlurmSubmissionBinding(liveJob43.binding);
    const running = parseSlurmSubmissionObservations(
      liveJob43.runningAccounting,
      "sacct",
      "fixture-cluster",
    );
    const queue = parseSlurmSubmissionObservations(
      liveJob43.runningQueue,
      "squeue",
      "fixture-cluster",
    );
    expect(resolveSlurmSubmission(captured, [...running, ...queue], complete)).toMatchObject({
      status: "matched",
      markerEvidence: "durable_name_and_queue_comment",
      resubmitAllowed: false,
      identity: {
        jobId: "43",
        uid: 2101,
        cluster: "fixture-cluster",
        submittedAt: "2026-09-20T05:27:09Z",
      },
    });
    expect(resolveSlurmSubmission(captured, running, complete)).toMatchObject({
      status: "indeterminate",
      reason: "Accounting comment is still pending",
      resubmitAllowed: false,
    });
    const terminal = parseSlurmSubmissionObservations(
      liveJob43.terminalAccounting,
      "sacct",
      "fixture-cluster",
    );
    expect(resolveSlurmSubmission(captured, terminal, complete)).toMatchObject({
      status: "matched",
      markerEvidence: "accounting_comment",
      resubmitAllowed: false,
    });
    for (const changed of [
      { ...queue[0], marker: "" },
      { ...queue[0], marker: "other-marker" },
      { ...queue[0], jobId: "44" },
      { ...queue[0], uid: 2103 },
      { ...queue[0], submittedAt: "2026-09-20T05:27:10Z" },
    ])
      expect(resolveSlurmSubmission(captured, [...running, changed], complete).status).toBe(
        "conflict",
      );
    expect(
      resolveSlurmSubmission(captured, [...running, ...queue], { accounting: false, queue: true })
        .status,
    ).toBe("indeterminate");
    expect(
      resolveSlurmSubmission(
        captured,
        [{ ...running[0], jobName: running[0].jobName.slice(0, 32) }, ...queue],
        complete,
      ).status,
    ).toBe("conflict");
    expect(
      resolveSlurmSubmission(
        captured,
        [{ ...running[0], marker: "different-nonempty" }, ...queue],
        complete,
      ).status,
    ).toBe("conflict");
  });

  test("binds exact admission, script, site, identity, resource request and window", () => {
    expect(assertSlurmSubmissionBinding(binding)).toEqual(binding);
    expect(
      createSlurmSubmissionBinding({
        ...input,
        resources: {
          walltimeSeconds: 120,
          memoryMiB: 128,
          cpus: 1,
          account: "chem",
          node: "worker-01",
          partition: "chem",
        },
      }),
    ).toEqual(binding);
    for (const changed of [
      { operationId: "other-operation" },
      { requestDigest: "d".repeat(64) },
      { admissionDigest: "d".repeat(64) },
      { scriptDigest: "d".repeat(64) },
      { siteProfileDigest: "d".repeat(64) },
      { uid: 2103 },
      { cluster: "other" },
      { notBefore: "2026-09-20T05:00:01.000Z" },
      { expiresAt: "2026-09-20T05:05:01.000Z" },
      ...Object.entries({
        partition: "test",
        node: "other",
        account: "other",
        cpus: 2,
        memoryMiB: 256,
        walltimeSeconds: 121,
      }).map(([key, value]) => ({ resources: { ...input.resources, [key]: value } })),
    ]) {
      expect(() => assertSlurmSubmissionBinding({ ...binding, ...changed })).toThrow(
        "digest mismatch",
      );
      expect(createSlurmSubmissionBinding({ ...input, ...changed }).bindingDigest).not.toBe(
        binding.bindingDigest,
      );
    }
  });

  test("keeps legacy CPU digest stable and binds the optional one-GPU allocation", () => {
    expect(liveJob43.binding.bindingDigest).toBe(
      "c35c52929554c190b3fa054fb815a4ed0ceec1f65351fa65ac55d33c1f690a29",
    );
    const gpuBinding = createSlurmSubmissionBinding({
      ...input,
      resources: { ...input.resources, gpuCount: 1 },
    });
    expect(gpuBinding.resources.gpuCount).toBe(1);
    expect(gpuBinding.bindingDigest).not.toBe(binding.bindingDigest);
    expect(() =>
      createSlurmSubmissionBinding({
        ...input,
        resources: { ...input.resources, gpuCount: 2 },
      }),
    ).toThrow();
  });

  test("rejects extra fields, unsafe identities, unbounded windows and resource escalation", () => {
    for (const changed of [
      { uid: 0 },
      { uid: -1 },
      { uid: 4_294_967_295 },
      { uid: 2.5 },
      { cluster: "chem;touch X" },
      { operationId: "-evil" },
      { command: "touch X" },
      { notBefore: "2026-09-20T05:00:00" },
      { expiresAt: input.notBefore },
      { expiresAt: "2026-09-20T06:00:00.000Z" },
      { resources: { ...input.resources, cpus: 32 } },
      { resources: { ...input.resources, memoryMiB: 30_001 } },
      { resources: { ...input.resources, node: "worker-01,fixture-cluster" } },
      { resources: { ...input.resources, array: "1-10" } },
    ])
      expect(() => createSlurmSubmissionBinding({ ...input, ...changed })).toThrow();
  });

  test("matches only a single durable allocation, corroborated by a complete queue query", () => {
    const first = resolveSlurmSubmission(binding, [observation()], complete);
    expect(first.status).toBe("matched");
    expect(first.identity).toEqual({
      jobId: "43",
      cluster: "fixture-cluster",
      uid: 2101,
      submittedAt: "2026-09-20T05:00:01Z",
    });
    const running = resolveSlurmSubmission(
      binding,
      [observation(), observation("squeue")],
      complete,
    );
    expect(running.identity).toEqual(first.identity);
    expect(running.resubmitAllowed).toBe(false);
  });

  test("queue only, missing accounting, empty history or an outage never permit resubmission", () => {
    for (const [rows, sources] of [
      [[], complete],
      [[observation("squeue")], complete],
      [[observation()], { accounting: true, queue: false }],
      [[observation("squeue")], { accounting: false, queue: true }],
      [[], { accounting: false, queue: false }],
    ] as const) {
      expect(resolveSlurmSubmission(binding, [...rows], sources)).toMatchObject({
        status: "indeterminate",
        resubmitAllowed: false,
      });
    }
  });

  test("conflicts include recycled JobIDs, multiple jobs, duplicate rows and marker drift", () => {
    for (const rows of [
      [observation(), { ...observation(), jobId: "44" }],
      [observation(), { ...observation(), submittedAt: "2026-09-20T05:00:02Z" }],
      [observation(), observation()],
      [observation(), { ...observation("squeue"), marker: "" }],
      [{ ...observation(), uid: 2103 }],
      [{ ...observation(), cluster: "other" }],
      [{ ...observation(), jobName: "other" }],
      [{ ...observation(), marker: "egv1:truncated+" }],
      [{ ...observation(), submittedAt: "2026-09-20T04:59:59Z" }],
      [{ ...observation(), submittedAt: "2026-09-20T05:05:01Z" }],
      [{ ...observation(), submittedAt: "not-a-time" }],
      [{ ...observation(), jobId: "43.batch" }],
    ])
      expect(resolveSlurmSubmission(binding, rows, complete)).toMatchObject({
        status: "conflict",
        resubmitAllowed: false,
      });
  });

  test("UTC wire timestamps have second precision, never host-local interpretation", () => {
    expect(
      resolveSlurmSubmission(
        binding,
        [{ ...observation(), submittedAt: "2026-09-20T05:00:00Z" }],
        complete,
      ).status,
    ).toBe("matched");
    expect(
      resolveSlurmSubmission(
        binding,
        [{ ...observation(), submittedAt: "2026-09-20T05:00:00" }],
        complete,
      ).status,
    ).toBe("conflict");
  });

  test("strict accounting and queue field formats preserve the exact marker", () => {
    const value = observation();
    const accounting = [
      value.jobId,
      value.cluster,
      value.uid,
      value.submittedAt,
      value.jobName,
      value.marker,
    ].join("|");
    const queue = [value.jobId, value.uid, value.submittedAt, value.jobName, value.marker].join(
      "|",
    );
    expect(parseSlurmSubmissionObservations(accounting + "\n", "sacct", "fixture-cluster")).toEqual(
      [value],
    );
    expect(parseSlurmSubmissionObservations(queue, "squeue", "fixture-cluster")).toEqual([
      observation("squeue"),
    ]);
    expect(parseSlurmSubmissionObservations("", "sacct", "fixture-cluster")).toEqual([]);
    for (const bad of [
      accounting + "|",
      accounting.replace("43|", "43.batch|"),
      accounting.replace("43|", "43_1|"),
      accounting.replace("43|", "43+1|"),
      accounting.replace("2101|", "4294967295|"),
      accounting.replace("2101|", "0|"),
      accounting.replace("05:00:01Z", "05:00:01"),
      accounting.replace("2026-09-20", "2026-02-30"),
      accounting.replace(value.marker, "x".repeat(129)),
      accounting.replace(value.marker, "x\t"),
      accounting + "\nmalformed",
      "   ",
    ])
      expect(() => parseSlurmSubmissionObservations(bad, "sacct", "fixture-cluster")).toThrow();
    expect(() =>
      parseSlurmSubmissionObservations(
        Array(257).fill(accounting).join("\n"),
        "sacct",
        "fixture-cluster",
      ),
    ).toThrow("Too many");
  });

  test("tampered binding cannot be used even for read-only reconciliation", () => {
    expect(() =>
      resolveSlurmSubmission({ ...binding, uid: 2103 } as SlurmSubmissionBinding, [], complete),
    ).toThrow("digest mismatch");
  });
});
