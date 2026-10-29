import { describe, expect, mock, test } from "bun:test";
import { nativeFixtureForText } from "./native-fixture";
import { BunExecutor, SlurmCliClient, SACCT_23_11_FIELDS } from "@eigengrid/slurm";
import type { CliExecutor, CliResult } from "@eigengrid/slurm";

type Handler = (
  cmd: string,
  args: string[],
  opts?: {
    timeout?: number;
    env?: Record<string, string>;
    maxOutputBytes?: number;
    maxErrorBytes?: number;
  },
) => Promise<Partial<CliResult>>;

function makeMockExecutor(handlers: Partial<Record<string, Handler>> = {}): CliExecutor {
  let lastTextAccounting = "";
  return {
    run: mock(
      async (
        cmd: string,
        args: string[],
        opts?: {
          timeout?: number;
          env?: Record<string, string>;
          maxOutputBytes?: number;
          maxErrorBytes?: number;
        },
      ) => {
        if (cmd === "sacct" && args.includes("--json")) {
          return { exitCode: 0, stdout: nativeFixtureForText(lastTextAccounting), stderr: "" };
        }
        const handler = handlers[cmd] ?? (async () => ({ exitCode: 0, stdout: "", stderr: "" }));
        const result = await handler(cmd, args, opts);
        if (cmd === "sacct") lastTextAccounting = result.stdout ?? "";
        return {
          exitCode: result.exitCode ?? 0,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          timedOut: result.timedOut,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated,
        };
      },
    ),
  };
}

describe("SlurmCliClient", () => {
  test("submitJob returns a parsed job id on success", async () => {
    const client = new SlurmCliClient(
      makeMockExecutor({
        sbatch: async () => ({ exitCode: 0, stdout: "12345\n", stderr: "" }),
      }),
    );

    expect(await client.submitJob("/tmp/job.sh")).toEqual({ slurmJobId: "12345", success: true });
  });

  test("submitJob returns an error on non-zero exit", async () => {
    const client = new SlurmCliClient(
      makeMockExecutor({
        sbatch: async () => ({ exitCode: 1, stdout: "", stderr: "submission failed" }),
      }),
    );

    const result = await client.submitJob("/tmp/job.sh");
    expect(result.success).toBe(false);
    expect(result.error).toContain("submission failed");
  });

  test("treats bounded scheduler output truncation as ambiguous", async () => {
    const client = new SlurmCliClient(
      makeMockExecutor({
        sbatch: async () => ({
          exitCode: 0,
          stdout: "12345",
          stderr: "",
          stdoutTruncated: true,
        }),
      }),
    );

    await expect(client.submitJob("/tmp/job.sh")).resolves.toMatchObject({
      success: false,
      ambiguous: true,
    });
  });

  test("BunExecutor bounds stdout and stderr without buffering unbounded output", async () => {
    const executor = new BunExecutor();
    const result = await executor.run("bash", ["-c", "printf 123456789; printf abcdef >&2"], {
      maxOutputBytes: 4,
      maxErrorBytes: 3,
      timeout: 5_000,
    });

    expect(result.stdout).toBe("1234");
    expect(result.stderr).toBe("abc");
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
  });

  test("marks timeout submission outcomes ambiguous", async () => {
    const client = new SlurmCliClient(
      makeMockExecutor({
        sbatch: async () => ({ exitCode: 137, stdout: "", stderr: "killed", timedOut: true }),
      }),
    );

    await expect(client.submitJob("/tmp/job.sh")).resolves.toMatchObject({
      success: false,
      ambiguous: true,
    });
  });

  test("rejects an option-like or control-character submission path", async () => {
    const executor = makeMockExecutor();
    const client = new SlurmCliClient(executor);

    await expect(client.submitJob("--wrap=touch /tmp/pwned")).rejects.toThrow(
      "invalid Slurm submission script path",
    );
    await expect(client.submitJob("/tmp/job.sh\n--wrap=evil")).rejects.toThrow(
      "invalid Slurm submission script path",
    );
    expect(executor.run).not.toHaveBeenCalled();
  });

  test("getJobStatus uses sacct when available", async () => {
    const client = new SlurmCliClient(
      makeMockExecutor({
        sacct: async () => ({
          exitCode: 0,
          stdout:
            "123456|COMPLETED|0:0|01:23:45|123456K|8Gn|1|8|0:0|2101|2026-09-19T00:00:00|fixture-cluster|worker-01|None\n",
          stderr: "",
        }),
      }),
    );

    expect(await client.getJobStatus("123456")).toMatchObject({
      slurmJobId: "123456",
      state: "COMPLETED",
      stateCompact: "completed",
      elapsed: "01:23:45",
      exitCode: 0,
      signal: 0,
      derivedExitCode: 0,
      derivedSignal: 0,
      rawState: "COMPLETED",
      source: "sacct",
    });
  });

  test("getJobStatus falls back to squeue when sacct fails", async () => {
    const client = new SlurmCliClient(
      makeMockExecutor({
        sacct: async () => ({ exitCode: 1, stdout: "", stderr: "sacct unavailable" }),
        squeue: async () => ({ exitCode: 0, stdout: "R\n", stderr: "" }),
      }),
    );

    expect(await client.getJobStatus("123456")).toMatchObject({
      slurmJobId: "123456",
      state: "RUNNING",
      stateCompact: "running",
      accountingPending: true,
      source: "squeue",
    });
  });

  test("getJobStatus returns unknown when both commands fail", async () => {
    const client = new SlurmCliClient(
      makeMockExecutor({
        sacct: async () => ({ exitCode: 1, stdout: "", stderr: "sacct unavailable" }),
        squeue: async () => ({ exitCode: 1, stdout: "", stderr: "squeue unavailable" }),
      }),
    );

    expect(await client.getJobStatus("123456")).toMatchObject({
      slurmJobId: "123456",
      state: "UNKNOWN",
      stateCompact: "unknown",
      accountingPending: true,
    });
  });

  test("cancelJob returns success on zero exit", async () => {
    const client = new SlurmCliClient(
      makeMockExecutor({
        scancel: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    );

    expect(await client.cancelJob("123456")).toEqual({ success: true });
  });

  test("cancelJob returns an error on non-zero exit", async () => {
    const client = new SlurmCliClient(
      makeMockExecutor({
        scancel: async () => ({ exitCode: 1, stdout: "", stderr: "permission denied" }),
      }),
    );

    const result = await client.cancelJob("123456");
    expect(result.success).toBe(false);
    expect(result.error).toContain("permission denied");
  });

  test("marks timeout cancellation outcomes ambiguous", async () => {
    const client = new SlurmCliClient(
      makeMockExecutor({
        scancel: async () => ({ exitCode: 137, stdout: "", stderr: "killed", timedOut: true }),
      }),
    );

    await expect(client.cancelJob("123456")).resolves.toMatchObject({
      success: false,
      ambiguous: true,
    });
  });

  test("rejects an untrusted scheduler identity before invoking the CLI", async () => {
    const executor = makeMockExecutor();
    const client = new SlurmCliClient(executor);

    await expect(client.cancelJob("--config=/tmp/evil")).rejects.toThrow(
      "invalid Slurm job identity",
    );
    expect(executor.run).not.toHaveBeenCalled();
  });

  test("getNodes parses sinfo output", async () => {
    const client = new SlurmCliClient(
      makeMockExecutor({
        sinfo: async (_cmd, args) => {
          expect(args).toEqual(["--noheader", "--format", "%N|%t|%c|%m|%e|%O"]);
          return {
            exitCode: 0,
            stdout: ["node01|idle|16|64000|62000|0.10", "node02|alloc|32|128000|100000|3.21"].join(
              "\n",
            ),
            stderr: "",
          };
        },
      }),
    );

    expect(await client.getNodes()).toEqual([
      {
        name: "node01",
        state: "idle",
        cpus: 16,
        memoryMb: 64000,
        freeMemoryMb: 62000,
        partitions: [],
      },
      {
        name: "node02",
        state: "alloc",
        cpus: 32,
        memoryMb: 128000,
        freeMemoryMb: 100000,
        partitions: [],
      },
    ]);
  });

  test("getPartitions parses sinfo output", async () => {
    const client = new SlurmCliClient(
      makeMockExecutor({
        sinfo: async (_cmd, args) => {
          expect(args).toEqual(["--noheader", "--format", "%P|%a|%l|%L|%D|%N"]);
          return {
            exitCode: 0,
            stdout: [
              "debug|up|01:00:00|1-00:00:00|4|node01",
              "long|up|04:00:00|7-00:00:00|8|node02,node03",
            ].join("\n"),
            stderr: "",
          };
        },
      }),
    );

    expect(await client.getPartitions()).toEqual([
      {
        name: "debug",
        state: "up",
        defaultTime: "01:00:00",
        maxTime: "1-00:00:00",
        nodes: ["node01"],
      },
      {
        name: "long",
        state: "up",
        defaultTime: "04:00:00",
        maxTime: "7-00:00:00",
        nodes: ["node02", "node03"],
      },
    ]);
  });

  test("getAccounting parses sacct output", async () => {
    const client = new SlurmCliClient(
      makeMockExecutor({
        sacct: async (_cmd, args) => {
          expect(args).toEqual([
            "--jobs",
            "123456",
            "--noheader",
            "--parsable2",
            "--format",
            SACCT_23_11_FIELDS.join(","),
          ]);
          return {
            exitCode: 0,
            stdout:
              "123456|COMPLETED|0:0|01:23:45|123456K|8Gn|1|8|0:0|2101|2026-09-19T00:00:00|fixture-cluster|worker-01|None\n",
            stderr: "",
          };
        },
      }),
    );

    expect(await client.getAccounting("123456")).toMatchObject({
      slurmJobId: "123456",
      state: "COMPLETED",
      exitCode: 0,
      elapsed: "01:23:45",
      maxRss: "123456K",
      reqMem: "8Gn",
      nNodes: 1,
      nCpus: 8,
      signal: 0,
      uid: 2101,
      cluster: "fixture-cluster",
      accountingSchema: "slurm-23.11/parsable2-v1",
    });
  });
});
