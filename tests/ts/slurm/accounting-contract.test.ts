import { describe, expect, test } from "bun:test";
import { nativeFixtureForText } from "./native-fixture";
import {
  parseSacctRecords,
  sacctContractForVersion,
  SACCT_23_11_FIELDS,
  SlurmCliClient,
  type CliExecutor,
} from "@eigengrid/slurm";

const contract = sacctContractForVersion("23.11.4-1.2ubuntu5");
function row(jobId = "41", state = "COMPLETED", exit = "0:0", derived = "0:0") {
  return [
    jobId,
    state,
    exit,
    "00:00:05",
    "",
    "1000Mn",
    "1",
    "1",
    derived,
    "2101",
    "2026-09-19T18:00:00",
    "fixture-cluster",
    "worker-01",
    "None",
  ].join("|");
}

function clientFor(stdout: string, queue = "", queryExit = 0) {
  const invocations: string[] = [];
  const executor: CliExecutor = {
    async run(command, args, options) {
      invocations.push(args.includes("--json") ? "sacct-json" : command);
      if (command === "sacct") {
        expect(options?.env).toEqual({
          LC_ALL: "C",
          TZ: "UTC",
          SLURM_TIME_FORMAT: "%Y-%m-%dT%H:%M:%SZ",
        });
        if (args.includes("--json")) {
          expect(args).toEqual(["--jobs", "41", "--json"]);
          return { exitCode: queryExit, stdout: nativeFixtureForText(stdout), stderr: "" };
        }
        expect(args).toEqual([
          "--jobs",
          "41",
          "--noheader",
          "--parsable2",
          "--format",
          contract.format,
        ]);
        return { exitCode: queryExit, stdout, stderr: "" };
      }
      if (command === "squeue") return { exitCode: 0, stdout: queue, stderr: "" };
      throw new Error(`unexpected effect: ${command}`);
    },
  };
  return { client: new SlurmCliClient(executor, "23.11.4-1.2ubuntu5"), invocations };
}

describe("versioned Slurm 23.11 accounting contract", () => {
  test("query format and parser share the exact field contract", () => {
    expect(contract.format).toBe(SACCT_23_11_FIELDS.join(","));
    const parsed = parseSacctRecords(row(), contract);
    expect(parsed[0]).toMatchObject({
      jobId: "41",
      allocationId: "41",
      kind: "allocation",
      exitCode: 0,
      signal: 0,
      derivedExitCode: 0,
      derivedSignal: 0,
      uid: 2101,
    });
    expect(() => sacctContractForVersion("24.11.0")).toThrow("Unqualified");
    expect(() => sacctContractForVersion("23.11.4\nattack")).toThrow("Unqualified");
  });

  test("retains allocation, batch, external and numbered steps without confusing their identity", () => {
    const records = parseSacctRecords(
      [row("41.batch"), row("41.extern"), row("41.0"), row()].join("\n"),
      contract,
    );
    expect(records.map((record) => record.kind)).toEqual([
      "batch",
      "external",
      "step",
      "allocation",
    ]);
    expect(records.every((record) => record.allocationId === "41")).toBe(true);
    expect(parseSacctRecords(row("41_2.batch"), contract)[0].allocationId).toBe("41_2");
    expect(parseSacctRecords(row("41+2.0"), contract)[0].allocationId).toBe("41+2");
  });

  test("rejects malformed, truncated and incompatible columns instead of inventing zero", () => {
    for (const malformed of [
      row().split("|").slice(0, 7).join("|"),
      row().replace("|1|1|", "|oops|1|"),
      row("not-a-job"),
      row("41", "FAILED", "NaN:0"),
      row("41", "FAILED", "0:999"),
    ]) {
      expect(() => parseSacctRecords(malformed, contract)).toThrow();
    }
    expect(parseSacctRecords(row("41", "COMPLETED", "", ""), contract)[0].exitCode).toBeUndefined();
    expect(parseSacctRecords(row("41", "CANCELLED+"), contract)[0]).toMatchObject({
      state: "UNKNOWN",
      rawState: "CANCELLED+",
    });
  });

  for (const state of [
    "COMPLETED",
    "FAILED",
    "CANCELLED by 2101",
    "TIMEOUT",
    "OUT_OF_MEMORY",
    "NODE_FAIL",
  ]) {
    test(`preserves ${state} and exact exit/signal`, async () => {
      const successful = state === "COMPLETED";
      const { client } = clientFor(row("41", state, successful ? "0:0" : "0:9"));
      expect(await client.getJobStatus("41")).toMatchObject({
        state: state.startsWith("CANCELLED") ? "CANCELLED" : state,
        rawState: state,
        exitCode: 0,
        signal: successful ? 0 : 9,
        source: "sacct",
      });
    });
  }

  test("selects the exact allocation, not the first step or another job", async () => {
    const { client } = clientFor(
      [row("41.batch", "FAILED", "42:0"), row("42"), row("41", "FAILED", "42:0")].join("\n"),
    );
    expect(await client.getJobStatus("41")).toMatchObject({
      slurmJobId: "41",
      state: "FAILED",
      exitCode: 42,
    });
    expect((await client.getAccounting("41"))?.records).toHaveLength(2);
  });

  for (const output of [
    row("41", "COMPLETED", "42:0"),
    row("41", "COMPLETED", "0:0", "1:0"),
    row("41", "COMPLETED", "0:0", "0:9"),
    [row(), row("41.batch", "FAILED", "42:0")].join("\n"),
  ]) {
    test(`never treats inconsistent completion as success: ${output.slice(0, 60)}`, async () => {
      const { client } = clientFor(output);
      expect(await client.getJobStatus("41")).toMatchObject({
        state: "FAILED",
        rawState: "COMPLETED",
        reason: "accounting_inconsistent_completion",
      });
    });
  }

  for (const output of [
    "",
    row("41.batch"),
    [row(), row()].join("\n"),
    row("41", "COMPLETED", "", ""),
    row().split("|").slice(0, 7).join("|"),
  ]) {
    test(`queue disappearance or incomplete accounting stays unknown (${output.length} bytes)`, async () => {
      const { client, invocations } = clientFor(output);
      expect(await client.getJobStatus("41")).toMatchObject({
        state: "UNKNOWN",
        accountingPending: true,
      });
      expect(invocations).toEqual(["sacct", "squeue"]);
    });
  }

  test("queue terminal state cannot replace accounting during an outage", async () => {
    const { client } = clientFor("", "CD", 1);
    expect(await client.getJobStatus("41")).toMatchObject({
      state: "UNKNOWN",
      rawState: "CD",
      source: "squeue",
      accountingPending: true,
    });
  });

  test("empty successful sbatch acknowledgement is ambiguous, not permission to resubmit", async () => {
    const client = new SlurmCliClient({
      async run() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(await client.submitJob("/tmp/job.sh")).toMatchObject({
      success: false,
      ambiguous: true,
    });
  });

  test("rejects broad cancellation expressions before invoking scancel", async () => {
    const executor: CliExecutor = {
      async run() {
        throw new Error("must not execute");
      },
    };
    const client = new SlurmCliClient(executor);
    for (const id of ["0", "41-50", "41:50", "41,50", "41_*", "41foo"]) {
      await expect(client.cancelJob(id)).rejects.toThrow("invalid Slurm job identity");
    }
  });
});
