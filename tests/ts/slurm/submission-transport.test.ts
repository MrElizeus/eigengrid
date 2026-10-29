import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import {
  createSlurmSubmissionBinding,
  slurmScriptDigest,
  slurmSubmissionJobName,
  slurmSubmissionMarker,
  SlurmSubmissionTransport,
  type CliExecutionOptions,
  type CliExecutor,
  type CliResult,
  type SlurmSubmissionProfile,
} from "@eigengrid/slurm";

const user = userInfo();
const directory = mkdtempSync(join(user.homedir, "egv1-submit-test-"));
const submissionDirectory = join(directory, "submissions");
mkdirSync(submissionDirectory, { mode: 0o700 });
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const profile: SlurmSubmissionProfile = {
  cluster: "fixture-cluster",
  slurmVersion: "23.11.4-1.2ubuntu5",
  uid: user.uid,
  username: user.username,
  home: user.homedir,
  submissionDirectory,
  siteProfileDigest: "c".repeat(64),
  partition: "chem",
  node: "worker-01",
  account: "chem",
  cpuLimit: 1,
  memoryMiBLimit: 2048,
  walltimeLimitSeconds: 300,
};
const script = Buffer.from("#!/bin/bash\n#SBATCH --job-name=fixture\n/usr/bin/true\n");
const binding = (bytes = script) =>
  createSlurmSubmissionBinding({
    operationId: "operation-transport-1",
    requestDigest: "a".repeat(64),
    admissionDigest: "b".repeat(64),
    scriptDigest: slurmScriptDigest(bytes),
    siteProfileDigest: profile.siteProfileDigest,
    cluster: profile.cluster,
    uid: profile.uid,
    notBefore: "2026-09-20T05:00:00.000Z",
    expiresAt: "2026-09-20T05:05:00.000Z",
    resources: {
      partition: "chem",
      node: "worker-01",
      account: "chem",
      cpus: 1,
      memoryMiB: 128,
      walltimeSeconds: 121,
    },
  });
const clock = () => new Date("2026-09-20T05:00:01.000Z");
const config =
  "ClusterName = fixture-cluster\nSLURM_VERSION = 23.11.4\nAccountingStorageType = accounting_storage/slurmdbd\nAccountingStoreFlags = job_comment\n";
const ok = (stdout = ""): CliResult => ({ exitCode: 0, stdout, stderr: "" });
const accounting = (jobId = "43") => {
  const value = binding();
  return `${jobId}|fixture-cluster|${user.uid}|2026-09-20T05:00:01Z|${slurmSubmissionJobName(value)}|${slurmSubmissionMarker(value)}`;
};

function fixture(
  handlers: Record<
    string,
    (args: string[], options?: CliExecutionOptions) => Promise<CliResult>
  > = {},
) {
  const calls: { cmd: string; args: string[]; options?: CliExecutionOptions }[] = [];
  const executor: CliExecutor = {
    run: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      if (handlers[cmd]) return handlers[cmd](args, options);
      if (cmd === "/usr/bin/scontrol") return ok(config);
      if (cmd === "/usr/local/bin/cluster-sbatch") return ok("43;fixture-cluster");
      if (cmd === "/usr/bin/sacct") return ok(accounting());
      if (cmd === "/usr/bin/squeue") return ok("");
      throw new Error("Unqualified executable");
    },
  };
  return { executor, calls, transport: new SlurmSubmissionTransport(profile, executor, clock) };
}

describe("per-UID Slurm transport (not canonical coordinator qualification)", () => {
  test("revalidates site authority after controller IO and never submits if it was revoked", async () => {
    let controllerReturned = false;
    const { transport, calls } = fixture({
      "/usr/bin/scontrol": async () => {
        controllerReturned = true;
        return ok(config);
      },
    });
    await expect(
      transport.sendAdmitted(binding(), script, async () => {
        expect(controllerReturned).toBe(true);
        throw new Error("TEST current site authority revoked");
      }),
    ).rejects.toThrow("revoked");
    expect(calls.map((call) => call.cmd)).toEqual(["/usr/bin/scontrol"]);
  });

  test("a slow site-authority check cannot extend the frozen delivery window", async () => {
    const { executor, calls } = fixture();
    let now = clock();
    const transport = new SlurmSubmissionTransport(profile, executor, () => now);
    await expect(
      transport.sendAdmitted(binding(), script, async () => {
        now = new Date(binding().expiresAt);
      }),
    ).rejects.toThrow();
    expect(calls.map((call) => call.cmd)).toEqual(["/usr/bin/scontrol"]);
  });

  test("snapshots verified script bytes before asynchronous preflight", async () => {
    const mutable = new Uint8Array(script);
    const { transport, calls } = fixture({
      "/usr/bin/scontrol": async () => {
        mutable.fill(0);
        return ok(config);
      },
    });
    expect((await transport.sendAdmitted(binding(), mutable)).status).toBe("acknowledged");
    expect(Buffer.from(calls[1].options?.stdin ?? [])).toEqual(script);
    expect(mutable.every((byte) => byte === 0)).toBe(true);
  });

  test("uses the fixed wrapper, exact stdin bytes, clean environment and bounded argv", async () => {
    const { transport, calls } = fixture();
    expect(await transport.sendAdmitted(binding(), script)).toEqual({
      status: "acknowledged",
      jobId: "43",
      cluster: "fixture-cluster",
      resubmitAllowed: false,
    });
    const call = calls[1];
    expect(calls.length).toBe(2);
    expect(call.cmd).toBe("/usr/local/bin/cluster-sbatch");
    expect(call.args).toEqual([
      "--parsable",
      "--no-requeue",
      "--export=NIL",
      `--job-name=${slurmSubmissionJobName(binding())}`,
      `--comment=${slurmSubmissionMarker(binding())}`,
      "--partition=chem",
      "--account=chem",
      "--nodelist=worker-01",
      "--nodes=1",
      "--ntasks=1",
      "--cpus-per-task=1",
      "--mem=128M",
      "--time=2:01",
    ]);
    expect(Buffer.from(call.options?.stdin ?? [])).toEqual(script);
    expect(call.options).toMatchObject({
      inheritEnv: false,
      cwd: submissionDirectory,
      timeout: 10_000,
      maxOutputBytes: 65536,
    });
    expect(call.options?.env).toEqual({
      LC_ALL: "C",
      TZ: "UTC",
      SLURM_TIME_FORMAT: "%Y-%m-%dT%H:%M:%SZ",
      PATH: "/usr/bin:/bin",
      HOME: user.homedir,
      USER: user.username,
      LOGNAME: user.username,
    });
  });

  test("requests exactly one provisioned GPU only for an explicitly GPU-bound stage", async () => {
    const gpuProfile: SlurmSubmissionProfile = {
      ...profile,
      gpuType: "a100",
      gpuLimit: 1,
    };
    const { schemaVersion: _schema, bindingDigest: _digest, ...input } = binding();
    const gpuBinding = createSlurmSubmissionBinding({
      ...input,
      resources: { ...input.resources, gpuCount: 1 },
    });
    const gpuFixture = fixture();
    const sent = new SlurmSubmissionTransport(gpuProfile, gpuFixture.executor, clock);
    expect((await sent.sendAdmitted(gpuBinding, script)).status).toBe("acknowledged");
    expect(gpuFixture.calls[1].args).toContain("--gres=gpu:a100:1");

    const cpuFixture = fixture();
    const cpuTransport = new SlurmSubmissionTransport(gpuProfile, cpuFixture.executor, clock);
    expect((await cpuTransport.sendAdmitted(binding(), script)).status).toBe("acknowledged");
    expect(cpuFixture.calls[1].args.some((arg) => arg.startsWith("--gres="))).toBe(false);
  });

  test("rejects GPU binding/profile mismatches before any scheduler call", async () => {
    const { schemaVersion: _schema, bindingDigest: _digest, ...input } = binding();
    const gpuBinding = createSlurmSubmissionBinding({
      ...input,
      resources: { ...input.resources, gpuCount: 1 },
    });
    for (const malformedProfile of [
      { ...profile, gpuType: "a100" },
      { ...profile, gpuLimit: 1 },
      { ...profile, gpuType: "a100", gpuLimit: 2 },
    ]) {
      const { executor } = fixture();
      expect(
        () =>
          new SlurmSubmissionTransport(malformedProfile as SlurmSubmissionProfile, executor, clock),
      ).toThrow();
    }

    const { executor, calls } = fixture();
    const transport = new SlurmSubmissionTransport(profile, executor, clock);
    await expect(transport.sendAdmitted(gpuBinding, script)).rejects.toThrow("site limits");
    expect(calls).toEqual([]);
  });

  test("wrong UID, account mapping, symlink or public submit directory is rejected", () => {
    for (const changes of [
      { uid: user.uid + 1 },
      { uid: 0 },
      { username: "wrong-user" },
      { home: directory },
      { submissionDirectory: user.homedir },
      { slurmVersion: "24.11.0" },
    ]) {
      expect(
        () => new SlurmSubmissionTransport({ ...profile, ...changes }, fixture().executor, clock),
      ).toThrow();
    }
    const symlink = join(directory, "symlink");
    symlinkSync(submissionDirectory, symlink);
    expect(
      () =>
        new SlurmSubmissionTransport(
          { ...profile, submissionDirectory: symlink },
          fixture().executor,
        ),
    ).toThrow("canonical");
    chmodSync(submissionDirectory, 0o755);
    try {
      expect(() => new SlurmSubmissionTransport(profile)).toThrow("private");
    } finally {
      chmodSync(submissionDirectory, 0o700);
    }
  });

  test("resource escalation, payload tampering and expiry never reach sbatch", async () => {
    const { transport, calls, executor } = fixture();
    await expect(
      transport.sendAdmitted(binding(), Buffer.from("#!/bin/bash\nfalse\n")),
    ).rejects.toThrow("exact");
    for (const resources of [
      { ...binding().resources, cpus: 2 },
      { ...binding().resources, memoryMiB: 2049 },
      { ...binding().resources, walltimeSeconds: 301 },
      { ...binding().resources, node: "fixture-cluster" },
      { ...binding().resources, partition: "admin" },
      { ...binding().resources, account: "other" },
    ]) {
      const { schemaVersion: _schema, bindingDigest: _digest, ...input } = binding();
      await expect(
        transport.sendAdmitted(createSlurmSubmissionBinding({ ...input, resources }), script),
      ).rejects.toThrow("site limits");
    }
    expect(calls.length).toBe(0);
    for (const time of ["2026-09-20T04:59:59Z", "2026-09-20T05:05:00Z", "bad-time"]) {
      await expect(
        new SlurmSubmissionTransport(profile, executor, () => new Date(time)).sendAdmitted(
          binding(),
          script,
        ),
      ).rejects.toThrow("window");
    }
    expect(calls.every((call) => call.cmd === "/usr/bin/scontrol")).toBe(true);
  });

  test("rejects arrays, heterogeneous jobs, requeue, extra directive arguments and malformed UTF-8", async () => {
    const { transport, calls } = fixture();
    for (const directive of [
      "#SBATCH --array=1-2",
      "#SBATCH hetjob",
      "#SBATCH --requeue",
      "#SBATCH --qos=admin",
      "#SBATCH --job-name=ok --array=1-2",
      "#SBATCH --no-requeue=false",
      "#SBATCH --nodes",
      " #SBATCH --nodes=2",
    ]) {
      const bytes = Buffer.from(`#!/bin/bash\n${directive}\n/usr/bin/true\n`);
      await expect(transport.sendAdmitted(binding(bytes), bytes)).rejects.toThrow("directive");
    }
    for (const bytes of [
      Buffer.from("#!/bin/bash\n\0"),
      Buffer.concat([script, Buffer.from([0xff])]),
    ]) {
      await expect(transport.sendAdmitted(binding(bytes), bytes)).rejects.toThrow("UTF-8");
    }
    expect(calls.length).toBe(0);
  });

  test("verifies exact cluster/version/accounting before effects", async () => {
    for (const stdout of [
      config.replace("fixture-cluster", "other"),
      config.replace("23.11.4", "24.11.0"),
      config.replace("job_comment", "none"),
      config.replace("accounting_storage/slurmdbd", "accounting_storage/none"),
      config + "ClusterName = other\n",
    ]) {
      const { transport, calls } = fixture({ "/usr/bin/scontrol": async () => ok(stdout) });
      await expect(transport.sendAdmitted(binding(), script)).rejects.toThrow("contract differs");
      expect(calls.length).toBe(1);
    }
  });

  test("all uncertain replies, even nonzero exit or thrown after-effect errors, require reconciliation", async () => {
    for (const result of [
      { ...ok("43"), timedOut: true },
      { ...ok("43"), stdoutTruncated: true },
      { ...ok("43"), stderrTruncated: true },
      { ...ok("43"), exitCode: 1 },
      ok("43;other"),
      ok("0"),
      ok("Submitted batch job 43"),
      ok("43\n44"),
      ok("43;fixture-cluster;garbage"),
      ok(""),
    ]) {
      const { transport, calls } = fixture({ "/usr/local/bin/cluster-sbatch": async () => result });
      expect(await transport.sendAdmitted(binding(), script)).toMatchObject({
        status: "indeterminate",
        resubmitAllowed: false,
      });
      expect(calls.filter((call) => call.cmd.endsWith("cluster-sbatch")).length).toBe(1);
    }
    const { transport, calls } = fixture({
      "/usr/local/bin/cluster-sbatch": async () => {
        throw new Error("lost ACK");
      },
    });
    expect(await transport.sendAdmitted(binding(), script)).toMatchObject({
      status: "indeterminate",
      resubmitAllowed: false,
    });
    expect((await transport.discover(binding())).identity?.jobId).toBe("43");
    expect(calls.filter((call) => call.cmd.endsWith("cluster-sbatch")).length).toBe(1);
  });

  test("discovery queries explicit UTC history through now and returns the durable exact identity", async () => {
    const { transport, calls } = fixture();
    expect((await transport.discover(binding())).status).toBe("matched");
    expect(calls.map((call) => call.cmd)).toEqual([
      "/usr/bin/scontrol",
      "/usr/bin/sacct",
      "/usr/bin/squeue",
    ]);
    expect(calls[1].args).toContain("--duplicates");
    expect(calls[1].args).toContain("--starttime=2026-09-20T04:59:59");
    expect(calls[1].args).toContain("--endtime=2026-09-20T05:00:02");
    expect(calls[1].args).toContain(
      "--format=JobIDRaw,Cluster%128,UID,Submit,JobName%128,Comment%128",
    );
    expect(calls[2].args).toContain("--format=%i|%U|%V|%j|%k");
    expect(calls.every((call) => call.options?.inheritEnv === false)).toBe(true);
    const historical = new SlurmSubmissionTransport(
      profile,
      fixture().executor,
      () => new Date("2026-09-22T05:00:00Z"),
    );
    expect((await historical.discover(binding())).status).toBe("matched");
  });

  test("incomplete accounting, malformed/truncated evidence, queue outage or zero rows remain indeterminate", async () => {
    for (const handlers of [
      { "/usr/bin/sacct": async () => ok("") },
      { "/usr/bin/sacct": async () => ok("bad columns") },
      { "/usr/bin/sacct": async () => ({ ...ok(accounting()), timedOut: true }) },
      { "/usr/bin/sacct": async () => ({ ...ok(accounting()), stdoutTruncated: true }) },
      { "/usr/bin/squeue": async () => ({ ...ok(), exitCode: 1 }) },
      {
        "/usr/bin/squeue": async () => {
          throw new Error("outage");
        },
      },
      { "/usr/bin/scontrol": async () => ({ ...ok(), exitCode: 1 }) },
    ]) {
      const { transport, calls } = fixture(handlers);
      expect(await transport.discover(binding())).toMatchObject({
        status: "indeterminate",
        resubmitAllowed: false,
      });
      expect(calls.every((call) => !call.cmd.endsWith("cluster-sbatch"))).toBe(true);
    }
  });

  test("duplicate or conflicting real identities block adoption without dispatch", async () => {
    const { transport, calls } = fixture({
      "/usr/bin/sacct": async () => ok([accounting(), accounting("44")].join("\n")),
    });
    expect(await transport.discover(binding())).toMatchObject({
      status: "conflict",
      resubmitAllowed: false,
    });
    expect(calls.length).toBe(3);
  });
});
