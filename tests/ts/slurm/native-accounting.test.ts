import { describe, expect, test } from "bun:test";
import fixture from "../../fixtures/slurm/accounting-23.11.4-live.json";
import oomFixture from "../../fixtures/slurm/accounting-23.11.4-oom-live.json";
import {
  corroborateNativeAccounting,
  parseSacctRecords,
  sacctContractForVersion,
  SlurmCliClient,
} from "@eigengrid/slurm";

const contract = sacctContractForVersion("23.11.4-1.2ubuntu5");
const records = parseSacctRecords(fixture.text, contract);
const rowsFor = (id: string) => records.filter((row) => row.allocationId === id);

describe("native Slurm 23.11 corroboration against captured cluster observations", () => {
  test("preserves the real Slurm OOM sentinel separately from engine Linux signals", () => {
    const rows = corroborateNativeAccounting(
      JSON.stringify(oomFixture.native),
      parseSacctRecords(oomFixture.text, contract).filter((row) => row.allocationId === "37"),
      contract,
    );
    expect(rows.map((row) => [row.jobId, row.state, row.exitCode, row.signal])).toEqual([
      ["37", "OUT_OF_MEMORY", 0, 125],
      ["37.batch", "OUT_OF_MEMORY", 0, 125],
    ]);
    expect(oomFixture.provenance.note).toContain("not the engine Linux SIGKILL 9");
  });

  test("recovers 137 without guessing that text 9 means SIGKILL", () => {
    const rows = corroborateNativeAccounting(
      JSON.stringify(fixture.native),
      rowsFor("28"),
      contract,
    );
    expect(rows.map((row) => [row.jobId, row.rawTextExitCode, row.exitCode, row.signal])).toEqual([
      ["28", 9, 137, 0],
      ["28.batch", 9, 137, 0],
    ]);
    // SIGKILL 9 belongs to the separate engine receipt. Slurm observed a
    // normally exiting supervisor with exit 137, not a signalled batch.
  });

  test("retains all observed allocation/batch/step identities and derived failure", () => {
    const rows = corroborateNativeAccounting(
      JSON.stringify(fixture.native),
      rowsFor("32"),
      contract,
    );
    expect(rows.map((row) => row.jobId)).toEqual(["32", "32.batch", "32.0"]);
    expect(rows[0]).toMatchObject({ state: "FAILED", exitCode: 43, derivedExitCode: 43 });
  });

  test("cancellation and timeout are not inferred from the engine/supervisor return code", () => {
    for (const [id, state] of [
      ["29", "CANCELLED"],
      ["30", "TIMEOUT"],
    ]) {
      const rows = corroborateNativeAccounting(
        JSON.stringify(fixture.native),
        rowsFor(id),
        contract,
      );
      expect(rows[0]).toMatchObject({ state, exitCode: 0 });
      expect(rows[1]).toMatchObject({ state: "FAILED", rawTextExitCode: 15, exitCode: 143 });
    }
  });

  test("the allocation-only OOM probe is explicitly not an OOM qualification", () => {
    const rows = corroborateNativeAccounting(
      JSON.stringify(fixture.native),
      rowsFor("31"),
      contract,
    );
    expect(rows[0].state).toBe("COMPLETED");
    expect(fixture.provenance.note).toContain("not an OOM PASS");
  });

  const corruptions: [string, (document: typeof fixture.native) => void][] = [
    [
      "unqualified release",
      (d) => {
        d.meta.slurm.release = "24.11.0";
      },
    ],
    [
      "unqualified serializer",
      (d) => {
        d.meta.plugin.data_parser = "data_parser/v0.0.99";
      },
    ],
    [
      "non-durable backend",
      (d) => {
        d.meta.plugin.accounting_storage = "accounting_storage/none";
      },
    ],
    [
      "error",
      (d) => {
        Object.assign(d, { errors: [{ description: "database unavailable" }] });
      },
    ],
    [
      "warning/partial response",
      (d) => {
        Object.assign(d, { warnings: ["incomplete"] });
      },
    ],
    [
      "reused JobID",
      (d) => {
        d.jobs[2].time.submission += 1;
      },
    ],
    [
      "wrong cluster",
      (d) => {
        d.jobs[2].cluster = "other";
      },
    ],
    [
      "duplicate job",
      (d) => {
        d.jobs.push(d.jobs[2]);
      },
    ],
    [
      "changed state",
      (d) => {
        d.jobs[2].state.current = ["COMPLETED"];
      },
    ],
    [
      "mismatched exit",
      (d) => {
        d.jobs[2].exit_code.return_code.number = 42;
      },
    ],
    [
      "missing exit",
      (d) => {
        d.jobs[2].exit_code.return_code.set = false;
      },
    ],
    [
      "missing step",
      (d) => {
        d.jobs[2].steps.pop();
      },
    ],
  ];
  for (const [name, change] of corruptions) {
    test(`fails closed on ${name}`, () => {
      const document = structuredClone(fixture.native);
      change(document);
      expect(() =>
        corroborateNativeAccounting(JSON.stringify(document), rowsFor("28"), contract),
      ).toThrow();
    });
  }

  for (const nativeAvailable of [true, false]) {
    test(`CLI terminal truth requires native corroboration (available=${nativeAvailable})`, async () => {
      const calls: string[] = [];
      const client = new SlurmCliClient({
        async run(command, args) {
          calls.push(command);
          if (command === "sacct" && args.includes("--json")) {
            return {
              exitCode: nativeAvailable ? 0 : 1,
              stdout: nativeAvailable ? JSON.stringify(fixture.native) : "",
              stderr: "",
            };
          }
          if (command === "sacct") {
            return {
              exitCode: 0,
              stdout: fixture.text
                .split("\n")
                .filter((line) => /^(?:28|28\.batch)\|/u.test(line))
                .join("\n"),
              stderr: "",
            };
          }
          if (command === "squeue") return { exitCode: 0, stdout: "", stderr: "" };
          throw new Error(`Unexpected effect: ${command}`);
        },
      });
      if (nativeAvailable)
        expect(await client.getJobStatus("28")).toMatchObject({
          state: "FAILED",
          exitCode: 137,
          signal: 0,
        });
      else
        expect(await client.getJobStatus("28")).toMatchObject({
          state: "UNKNOWN",
          accountingPending: true,
        });
      expect(calls).not.toContain("sbatch");
    });
  }
});
