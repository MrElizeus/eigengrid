import { basename } from "path";
import type { Job, SshRunnerConfig } from "@eigengrid/core";
import { parseManifest, type WorkerJobManifest } from "@eigengrid/worker";
import { SshRunner } from "./ssh";
import { type CommandExecutor, DefaultCommandExecutor } from "./executor";
import { quotePosixShellWord } from "./wrapper";

function assertSafeJobId(jobId: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(jobId)) {
    throw new Error(`Unsafe job identifier for worker staging: ${jobId}`);
  }
}

// ────────────────────────────────────────────────────────────
// SSH Daemon Stager
// ────────────────────────────────────────────────────────────
//
// Stages a job bundle into the worker's remote inbox for
// the worker daemon to pick up.
//
// Flow:
//   1. Create job bundle in remote <scratchDir>/inbox/<jobId>.tmp/
//   2. Write manifest.json, input/ files
//   3. SCP input file(s) from head to remote worker
//   4. Atomic rename from .tmp to <jobId>/
//   5. Create READY marker

export interface StagedDaemonJob {
  ok: boolean;
  remoteBundlePath?: string;
  error?: string;
  /** Transport failures may have crossed the remote bundle effect boundary. */
  failureDisposition?: "terminal-confirmed" | "termination-unknown";
}

export class SshDaemonStager {
  private sshRunner: SshRunner;
  private config: SshRunnerConfig;
  private executor: CommandExecutor;
  private readonly injectedExecutor: boolean;

  constructor(config: SshRunnerConfig, executor?: CommandExecutor) {
    this.config = config;
    this.injectedExecutor = executor !== undefined;
    this.executor = executor ?? new DefaultCommandExecutor();
    this.sshRunner = new SshRunner(config);
  }

  // ── Argument Builders (testable via seam) ──────────────

  private buildSshArgs(command: string): string[] {
    // Host identity is always verified. `/dev/null` is intentionally only a
    // deterministic test fallback: with StrictHostKeyChecking=yes it rejects
    // unknown hosts rather than accepting them. Production callers must pass
    // a real known-hosts file (or EIGENGRID_KNOWN_HOSTS).
    const knownHosts =
      this.config.knownHostsPath ?? process.env.EIGENGRID_KNOWN_HOSTS ?? "/dev/null";
    if (!this.injectedExecutor && knownHosts === "/dev/null") {
      throw new Error(
        "SSH host identity is not configured; set knownHostsPath or EIGENGRID_KNOWN_HOSTS",
      );
    }
    const args: string[] = [
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${knownHosts}`,
    ];
    if (this.config.privateKeyPath) {
      args.push("-i", this.config.privateKeyPath);
    }
    args.push("-p", String(this.config.port));
    args.push(`${this.config.username}@${this.config.host}`);
    args.push(command);
    return args;
  }

  /**
   * Build SCP argument list.
   * SCP destination format: user@host:remotePath
   */
  private buildScpArgs(localPath: string, remoteDest: string): string[] {
    const knownHosts =
      this.config.knownHostsPath ?? process.env.EIGENGRID_KNOWN_HOSTS ?? "/dev/null";
    if (!this.injectedExecutor && knownHosts === "/dev/null") {
      throw new Error(
        "SSH host identity is not configured; set knownHostsPath or EIGENGRID_KNOWN_HOSTS",
      );
    }
    const args: string[] = [
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${knownHosts}`,
    ];
    if (this.config.privateKeyPath) {
      args.push("-i", this.config.privateKeyPath);
    }
    args.push("-P", String(this.config.port));
    args.push(localPath);
    // SCP invokes a remote shell for the destination path; quote the path
    // even though it is carried as one argv element locally.
    args.push(`${this.config.username}@${this.config.host}:${quotePosixShellWord(remoteDest)}`);
    return args;
  }

  /**
   * Stage a job bundle for the worker daemon.
   */
  async stage(job: Job, manifest: WorkerJobManifest): Promise<StagedDaemonJob> {
    const parsed = parseManifest(manifest);
    if (!parsed.ok) {
      return {
        ok: false,
        error: `Invalid v2 manifest: ${parsed.errors.map((error) => `${error.path}: ${error.message}`).join("; ")}`,
      };
    }
    if (parsed.manifest.jobId !== job.id) {
      return {
        ok: false,
        error: `Invalid v2 manifest: jobId ${parsed.manifest.jobId} does not match job ${job.id}`,
      };
    }
    if (basename(job.inputPath) !== parsed.manifest.inputName) {
      return {
        ok: false,
        error: `Invalid v2 manifest: inputName ${parsed.manifest.inputName} does not match input path basename ${basename(job.inputPath)}`,
      };
    }

    const jobId = job.id;
    assertSafeJobId(jobId);
    const remoteScratch = this.config.remoteScratchDir;
    const tmpBundleName = `${jobId}.tmp`;
    const finalBundleName = jobId;

    // 1. Create remote .tmp directory
    const tmpDir = `${remoteScratch}/inbox/${tmpBundleName}`;
    const finalDir = `${remoteScratch}/inbox/${finalBundleName}`;

    const quotedTmpDir = quotePosixShellWord(tmpDir);
    const quotedFinalDir = quotePosixShellWord(finalDir);
    const createDirCmd = `mkdir -p ${quotePosixShellWord(`${tmpDir}/input`)} ${quotePosixShellWord(`${tmpDir}/work`)} ${quotePosixShellWord(`${tmpDir}/artifacts`)} ${quotePosixShellWord(`${tmpDir}/logs`)}`;
    // Execute remote mkdir via SSH
    const mkdirResult = await this.sshExec(createDirCmd);
    if (!mkdirResult.ok) {
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        error: `Failed to create remote bundle dir: ${mkdirResult.error}`,
      };
    }

    // 2. Write manifest.json remotely
    const manifestContent = JSON.stringify(parsed.manifest, null, 2);
    const writeManifestCmd = `cat > ${quotePosixShellWord(`${tmpDir}/manifest.json`)} << 'MANIFEST_EOF'
${manifestContent}
MANIFEST_EOF`;
    const manifestResult = await this.sshExec(writeManifestCmd);
    if (!manifestResult.ok) {
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        error: `Failed to write remote manifest: ${manifestResult.error}`,
      };
    }

    // 3. Copy input file(s) from head to remote worker via SCP
    const inputCopyResult = await this.scpFile(job.inputPath, `${tmpDir}/input/`);
    if (!inputCopyResult.ok) {
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        error: `Failed to copy input to remote: ${inputCopyResult.error}`,
      };
    }

    // 4. Atomic rename .tmp → final
    const renameCmd = `mv ${quotedTmpDir} ${quotedFinalDir}`;
    const renameResult = await this.sshExec(renameCmd);
    if (!renameResult.ok) {
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        error: `Failed to finalize bundle: ${renameResult.error}`,
      };
    }

    // 5. Create READY marker
    const readyCmd = `touch ${quotePosixShellWord(`${finalDir}/READY`)}`;
    const readyResult = await this.sshExec(readyCmd);
    if (!readyResult.ok) {
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        error: `Failed to create READY marker: ${readyResult.error}`,
      };
    }

    return {
      ok: true,
      remoteBundlePath: finalDir,
    };
  }

  private async sshExec(command: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const result = await this.executor.run("ssh", this.buildSshArgs(command), {
        timeout: 30_000,
        maxOutputBytes: 1024,
      });
      return { ok: result.exitCode === 0, error: result.stderr || undefined };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * Copy a local file to the remote worker via SCP.
   */
  private async scpFile(
    localPath: string,
    remoteDest: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const result = await this.executor.run("scp", this.buildScpArgs(localPath, remoteDest), {
        timeout: 30_000,
        maxOutputBytes: 1024,
      });
      return { ok: result.exitCode === 0, error: result.stderr || undefined };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
