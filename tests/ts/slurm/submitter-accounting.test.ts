import { describe, expect, test } from "bun:test";
import {
  SlurmCliClient,
  createSlurmSubmissionBinding,
  decodeSubmitterAccountingResponse,
  decodeSubmitterResponse,
  slurmSubmissionJobName,
  slurmSubmissionMarker,
} from "@eigengrid/slurm";
import captured from "../../fixtures/slurm/accounting-23.11.4-live.json";

const binding = createSlurmSubmissionBinding({
  operationId: "accounting-operation",
  requestDigest: "a".repeat(64),
  admissionDigest: "b".repeat(64),
  scriptDigest: "c".repeat(64),
  siteProfileDigest: "d".repeat(64),
  cluster: "fixture-cluster",
  uid: 2101,
  notBefore: "2026-09-20T00:25:20.000Z",
  expiresAt: "2026-09-20T00:25:30.000Z",
  resources: {
    partition: "chem",
    node: "worker-01",
    account: "chem",
    cpus: 1,
    memoryMiB: 128,
    walltimeSeconds: 60,
  },
});
async function fixture() {
  const queries: string[][] = [];
  const client = new SlurmCliClient(
    {
      async run(command, args) {
        queries.push([command, ...args]);
        return {
          exitCode: 0,
          stderr: "",
          stdout: args.includes("--json")
            ? JSON.stringify(captured.native)
            : captured.text
                .split("\n")
                .filter((line) => line.startsWith("28|") || line.startsWith("28.batch|"))
                .join("\n"),
        };
      },
    },
    "23.11.4-1.2ubuntu5",
  );
  const accounting = await client.getAccounting("28");
  if (!accounting) throw new Error("Captured accounting failed its native contract");
  const identity = {
    jobId: "28",
    cluster: "fixture-cluster",
    uid: 2101,
    submittedAt: "2026-09-20T00:25:25Z",
  };
  return {
    queries,
    response: {
      version: "eigengrid.submitter-response/v2",
      status: "accounting",
      operationId: binding.operationId,
      resubmitAllowed: false,
      observation: {
        status: "matched",
        resubmitAllowed: false,
        reason: "One exact scheduler identity",
        markerEvidence: "accounting_comment",
        identity,
        observations: [
          {
            source: "sacct",
            ...identity,
            jobName: slurmSubmissionJobName(binding),
            marker: slurmSubmissionMarker(binding),
          },
        ],
      },
      accounting,
    },
  };
}

describe("V2 protected accounting response", () => {
  test("retains captured native 137 and exact bound identity without granting V1 submit", async () => {
    const { response, queries } = await fixture();
    const decoded = decodeSubmitterAccountingResponse(response, {
      operationId: binding.operationId,
      binding,
    });
    expect(decoded.status).toBe("accounting");
    if (decoded.status !== "accounting") throw new Error("Expected accounting result");
    expect(decoded.accounting).toMatchObject({
      slurmJobId: "28",
      state: "FAILED",
      exitCode: 137,
      signal: 0,
      uid: 2101,
      nodeName: "worker-01",
    });
    expect(decoded.accounting?.records.map((record) => record.rawTextExitCode)).toEqual([9, 9]);
    expect(queries).toHaveLength(2);
    expect(() =>
      decodeSubmitterResponse(response, {
        operationId: binding.operationId,
        action: "observe",
        binding,
      }),
    ).toThrow();
  });

  test.each([
    "operation",
    "job",
    "uid",
    "submitted",
    "cluster",
    "node",
    "native",
    "step",
    "summary",
    "state",
    "kind",
    "extra",
    "version",
    "oversized",
  ])("rejects %s substitution", async (attack) => {
    const { response } = await fixture();
    if (attack === "operation") response.operationId = "foreign-operation";
    if (attack === "job") response.accounting.slurmJobId = "29";
    if (attack === "uid") response.accounting.uid = 2103;
    if (attack === "submitted") response.accounting.submittedAt = "2026-09-20T00:25:26Z";
    if (attack === "cluster") response.accounting.cluster = "other";
    if (attack === "node") {
      response.accounting.nodeName = "other";
      response.accounting.records![0]!.nodeList = "other";
    }
    if (attack === "native") delete response.accounting.nativeAccountingSchema;
    if (attack === "step") response.accounting.records![1]!.allocationId = "29";
    if (attack === "summary") response.accounting.exitCode = 9;
    if (attack === "state") response.accounting.state = "COMPLETED";
    if (attack === "kind") response.accounting.records![1]!.kind = "external";
    if (attack === "extra") Object.assign(response, { command: "caller payload" });
    if (attack === "version") response.version = "eigengrid.submitter-response/v1";
    if (attack === "oversized") response.observation.reason = "X".repeat(64 * 1024);
    expect(() =>
      decodeSubmitterAccountingResponse(response, { operationId: binding.operationId, binding }),
    ).toThrow();
  });

  test("unavailable accounting and legacy rejection preserve uncertainty", async () => {
    const { response } = await fixture();
    const missing = { ...response, accounting: null };
    expect(
      decodeSubmitterAccountingResponse(missing, { operationId: binding.operationId, binding }),
    ).toMatchObject({ accounting: null });
    expect(
      decodeSubmitterAccountingResponse(
        { status: "rejected", resubmitAllowed: false },
        { operationId: binding.operationId, binding },
      ),
    ).toEqual({ status: "rejected", resubmitAllowed: false });
    const indeterminate = {
      ...response,
      observation: {
        status: "indeterminate",
        reason: "No identity",
        resubmitAllowed: false,
        observations: [],
      },
    };
    expect(() =>
      decodeSubmitterAccountingResponse(indeterminate, {
        operationId: binding.operationId,
        binding,
      }),
    ).toThrow();
  });
});
