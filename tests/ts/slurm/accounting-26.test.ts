import { expect, test } from "bun:test";
import fixture from "../../fixtures/slurm/accounting-26.05.5-live.json";
import {
  SlurmCliClient,
  sacctContractForVersion,
  parseSacctRecords,
  corroborateNativeAccounting,
} from "@eigengrid/slurm";
import { SubmitterAccountingRecordSchema } from "../../../packages/slurm/src/submitter-accounting";

const contract = sacctContractForVersion("26.05.5");
const all = parseSacctRecords(fixture.text, contract);

for (const [name, id] of Object.entries(fixture.provenance.jobs)) {
  test(`Slurm 26.05 live ${name}: native identity and full exit codes`, async () => {
    const rows = all.filter((r) => r.allocationId === id);
    const result = corroborateNativeAccounting(JSON.stringify(fixture.native), rows, contract);
    expect(result[0].state).toBe(
      name === "success"
        ? "COMPLETED"
        : name === "cancel"
          ? "CANCELLED"
          : name === "timeout"
            ? "TIMEOUT"
            : "FAILED",
    );
    if (name === "high-exit") expect(result[0].exitCode).toBe(137);
    if (name === "failure") expect(result[0].exitCode).toBe(43);
    const client = new SlurmCliClient(
      {
        async run(command, args) {
          expect(command).toBe("sacct");
          if (args.some((a) => a.startsWith("--json"))) {
            expect(args).toContain("--json=v0.0.45");
            return { exitCode: 0, stdout: JSON.stringify(fixture.native), stderr: "" };
          }
          return {
            exitCode: 0,
            stdout: rows
              .map((r) => fixture.text.split("\n").find((line) => line.startsWith(r.jobId + "|")))
              .join("\n"),
            stderr: "",
          };
        },
      },
      "26.05.5",
    );
    const accounting = await client.getAccounting(id);
    expect(accounting?.nativeAccountingSchema).toBe("slurm-26.05/data_parser-v0.0.45");
    expect(SubmitterAccountingRecordSchema.safeParse(accounting).success).toBe(true);
    expect(
      SubmitterAccountingRecordSchema.safeParse({
        ...accounting,
        nativeAccountingSchema: "slurm-23.11/data_parser-v0.0.40",
      }).success,
    ).toBe(false);
  });
}

test("Slurm 26.05 rejects changed serializer, release, incomplete steps and mismatched exits", () => {
  const rows = all.filter((r) => r.allocationId === fixture.provenance.jobs["high-exit"]);
  for (const change of [
    (d: typeof fixture.native) => {
      d.meta.plugin.data_parser = "data_parser/v0.0.40";
    },
    (d: typeof fixture.native) => {
      d.meta.slurm.release = "26.05.6";
    },
    (d: typeof fixture.native) => {
      d.jobs.find((j) => String(j.job_id) === rows[0].jobId)!.steps.pop();
    },
    (d: typeof fixture.native) => {
      d.jobs.find((j) => String(j.job_id) === rows[0].jobId)!.exit_code.return_code.number = 9;
    },
  ]) {
    const doc = structuredClone(fixture.native);
    change(doc);
    expect(() => corroborateNativeAccounting(JSON.stringify(doc), rows, contract)).toThrow();
  }
});
