import { describe, expect, test } from "bun:test";
import type { Job, SshRunnerConfig } from "@eigengrid/core";
import type { WorkerJobManifest } from "@eigengrid/worker";
import { SshDaemonStager, type CommandExecutor } from "@eigengrid/runners";

const config: SshRunnerConfig = {
  host: "worker.test",
  port: 22,
  username: "worker",
  remoteScratchDir: "/scratch/eigengrid",
};

const job = {
  id: "job-001",
  inputPath: "/local/input.inp",
} as Job;

function manifest(overrides: Partial<WorkerJobManifest> = {}): WorkerJobManifest {
  return {
    schemaVersion: 2,
    jobId: job.id,
    attemptId: "attempt-001",
    nodeName: "worker-01",
    software: "orca",
    recipeId: "orca-opt",
    runner: "worker-daemon",
    inputName: "input.inp",
    outputName: "input.out",
    resources: { cores: 1, memoryGb: 1 },
    createdAt: 1,
    ...overrides,
  };
}

type StagerSeam = {
  sshExec: (command: string) => Promise<{ ok: boolean; error?: string }>;
  scpFile: (localPath: string, remoteDest: string) => Promise<{ ok: boolean; error?: string }>;
  buildSshArgs: (command: string) => string[];
  buildScpArgs: (localPath: string, remoteDest: string) => string[];
};

function fakeSideEffects(stager: SshDaemonStager, calls: string[]): void {
  const seam = stager as unknown as StagerSeam;
  seam.sshExec = async (command) => {
    calls.push(`ssh:${command}`);
    return { ok: true };
  };
  seam.scpFile = async (localPath, remoteDest) => {
    calls.push(`scp:${localPath}:${remoteDest}`);
    return { ok: true };
  };
}

/**
 * A CommandExecutor that records invocations without spawning real processes.
 */
class RecordingExecutor implements CommandExecutor {
  readonly calls: Array<{ command: string; args: string[] }> = [];

  async run(command: string, args: string[] = []): Promise<any> {
    this.calls.push({ command, args });
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      command: "",
    };
  }

  spawn(): any {
    throw new Error("not used");
  }
  runSync(): any {
    throw new Error("not used");
  }
}

describe("SSH daemon stager v2 boundary", () => {
  test("rejects malformed cast manifests before SSH or SCP", async () => {
    const calls: string[] = [];
    const stager = new SshDaemonStager(config);
    fakeSideEffects(stager, calls);

    const result = await stager.stage(job, {
      ...manifest(),
      command: { program: "injected" },
    } as WorkerJobManifest);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid v2 manifest");
    expect(calls).toEqual([]);
  });

  test("rejects manifest and job ID mismatches before SSH or SCP", async () => {
    const calls: string[] = [];
    const stager = new SshDaemonStager(config);
    fakeSideEffects(stager, calls);

    const result = await stager.stage(job, manifest({ jobId: "other-job" }));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("does not match job");
    expect(calls).toEqual([]);
  });

  test("rejects a hostile persisted job identifier before remote effects", async () => {
    const calls: string[] = [];
    const stager = new SshDaemonStager(config);
    fakeSideEffects(stager, calls);

    const result = await stager.stage({ ...job, id: "../escape;touch" } as Job, {
      ...manifest(),
      jobId: "../escape;touch",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid v2 manifest");
    expect(calls).toEqual([]);
  });

  test("rejects input basename mismatches before SSH or SCP", async () => {
    const calls: string[] = [];
    const stager = new SshDaemonStager(config);
    fakeSideEffects(stager, calls);

    const result = await stager.stage({ ...job, inputPath: "/local/other.inp" } as Job, manifest());

    expect(result.ok).toBe(false);
    expect(result.error).toContain("inputName");
    expect(calls).toEqual([]);
  });

  test("stages valid v2 manifests through the expected fake side effects", async () => {
    const calls: string[] = [];
    const stager = new SshDaemonStager(config);
    fakeSideEffects(stager, calls);

    const result = await stager.stage(job, manifest());

    expect(result).toEqual({ ok: true, remoteBundlePath: "/scratch/eigengrid/inbox/job-001" });
    expect(calls).toHaveLength(5);
    expect(calls[0]).toContain("mkdir -p");
    expect(calls[1]).toContain("manifest.json");
    expect(calls[2]).toContain("scp:/local/input.inp");
    expect(calls[2]).toContain("/input/");
    expect(calls[3]).toContain("mv ");
    expect(calls[4]).toContain("touch ");
  });

  test("fails closed when production staging has no configured known-hosts file", async () => {
    const stager = new SshDaemonStager(config);
    const result = await stager.stage(job, manifest());

    expect(result.ok).toBe(false);
    expect(result.failureDisposition).toBe("termination-unknown");
    expect(result.error).toContain("host identity is not configured");
  });

  test("labels a transport failure after the remote boundary as ambiguous", async () => {
    const stager = new SshDaemonStager(config);
    const seam = stager as unknown as StagerSeam;
    seam.sshExec = async () => ({ ok: false, error: "connection lost" });

    const result = await stager.stage(job, manifest());

    expect(result).toMatchObject({
      ok: false,
      failureDisposition: "termination-unknown",
    });
  });
});

// ────────────────────────────────────────────────────────────
// SSH/SCP argv injection regression tests
// ────────────────────────────────────────────────────────────

describe("ssh-daemon-stager argv injection safety", () => {
  const dangerousConfig: SshRunnerConfig = {
    host: "target;rm -rf /",
    port: 22,
    username: "user$(whoami)",
    privateKeyPath: "/key with spaces && echo pwned",
    remoteScratchDir: "/scratch/eigengrid",
    knownHostsPath: "/tmp/eigengrid-test-known-hosts",
  };

  test("buildSshArgs keeps dangerous config values as distinct argv elements", () => {
    const stager = new SshDaemonStager(dangerousConfig);
    const seam = stager as unknown as StagerSeam;

    const args = seam.buildSshArgs("mkdir -p test");

    // privateKeyPath remains a single element after -i
    const iIndex = args.indexOf("-i");
    expect(iIndex).toBeGreaterThanOrEqual(0);
    expect(args[iIndex + 1]).toBe(dangerousConfig.privateKeyPath);

    // username@host is a single element with literal dangerous chars
    const hostEntry = `${dangerousConfig.username}@${dangerousConfig.host}`;
    expect(args).toContain(hostEntry);

    // The command is a single final element
    expect(args[args.length - 1]).toBe("mkdir -p test");

    // No shell metacharacters cause argv splitting
    expect(args).toEqual([
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "UserKnownHostsFile=/tmp/eigengrid-test-known-hosts",
      "-i",
      dangerousConfig.privateKeyPath,
      "-p",
      "22",
      hostEntry,
      "mkdir -p test",
    ]);
  });

  test("buildScpArgs keeps dangerous local/remote paths as distinct argv elements", () => {
    const stager = new SshDaemonStager(dangerousConfig);
    const seam = stager as unknown as StagerSeam;

    const localPath = "/local/input; touch /tmp/pwned.inp";
    const remoteDest = "/remote/dest/`whoami`/$(id)";
    const args = seam.buildScpArgs(localPath, remoteDest);

    // privateKeyPath remains a single element
    const iIndex = args.indexOf("-i");
    expect(iIndex).toBeGreaterThanOrEqual(0);
    expect(args[iIndex + 1]).toBe(dangerousConfig.privateKeyPath);

    // localPath is a single argv element
    expect(args).toContain(localPath);

    // SCP destination (user@host:remoteDest) is a single combined element
    const destEntry = `${dangerousConfig.username}@${dangerousConfig.host}:'${remoteDest.replaceAll("'", "'\\\"'\\\"'")}'`;
    expect(args).toContain(destEntry);

    // Full structure check
    expect(args).toEqual([
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "UserKnownHostsFile=/tmp/eigengrid-test-known-hosts",
      "-i",
      dangerousConfig.privateKeyPath,
      "-P",
      "22",
      localPath,
      destEntry,
    ]);
  });

  test("sshExec invokes executor with 'ssh' command and built args", async () => {
    const executor = new RecordingExecutor();
    const stager = new SshDaemonStager(dangerousConfig, executor);
    const seam = stager as unknown as StagerSeam;

    await seam.sshExec("mkdir -p test");

    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0].command).toBe("ssh");
    expect(executor.calls[0].args).toContain(dangerousConfig.privateKeyPath);
    expect(executor.calls[0].args[executor.calls[0].args.length - 1]).toBe("mkdir -p test");
    // shell:false is structural — DefaultCommandExecutor.run → runCommand → spawn with shell:false
    // No shell interpolation means distinct argv elements stay separate
  });

  test("scpFile invokes executor with 'scp' command and built args", async () => {
    const executor = new RecordingExecutor();
    const stager = new SshDaemonStager(dangerousConfig, executor);
    const seam = stager as unknown as StagerSeam;

    await seam.scpFile("/local/input.inp", "/remote/dest/");

    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0].command).toBe("scp");
    expect(executor.calls[0].args).toContain(dangerousConfig.privateKeyPath);
    expect(executor.calls[0].args).toContain("/local/input.inp");
  });

  test("no sentinel command or file is created from dangerous values", async () => {
    const executor = new RecordingExecutor();
    const stager = new SshDaemonStager(dangerousConfig, executor);
    const seam = stager as unknown as StagerSeam;

    // The command string with injection chars must pass through as a single argv element
    const cmd = "mkdir -p /safe/dir; touch /tmp/sentinel-$(id)";
    await seam.sshExec(cmd);

    expect(executor.calls).toHaveLength(1);
    const lastArg = executor.calls[0].args[executor.calls[0].args.length - 1];
    expect(lastArg).toBe(cmd);

    // All config values remain literal in argv — no shell interpolation
    const allArgs = executor.calls[0].args.join(" ");
    expect(allArgs).toContain(dangerousConfig.privateKeyPath);
    expect(allArgs).toContain(dangerousConfig.host);
    expect(allArgs).toContain(dangerousConfig.username);
  });
});
