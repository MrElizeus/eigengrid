import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Config } from "@eigengrid/core";
import { generateId } from "@eigengrid/core";
import type { DatabaseLike } from "@eigengrid/db";
import {
  type CommandExecutor,
  DefaultCommandExecutor,
  assertRegularRunnerFile,
  atomicPromoteRunnerFile,
  ensurePrivateRunnerDirectory,
  quotePosixShellWord,
} from "@eigengrid/runners";
import { verifyWorkerReceipt, type WorkerReceipt } from "@eigengrid/worker";

// ────────────────────────────────────────────────────────────
// Sync Result Types
// ────────────────────────────────────────────────────────────

export interface SyncResult {
  ok: boolean;
  syncedJobs: number;
  errors: string[];
}

// ────────────────────────────────────────────────────────────
// SSH Options (mirrors SshRunner internals)
// ────────────────────────────────────────────────────────────

const SSH_OPTS: string[] = [
  "-o",
  "ControlMaster=auto",
  "-o",
  "ControlPath=/tmp/eigengrid-ssh-%r@%h:%p",
  "-o",
  "ControlPersist=30",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "ConnectTimeout=10",
];

const SAFE_JOB_ID = /^[A-Za-z0-9._-]{1,128}$/u;

function assertSafeJobId(jobId: string): void {
  if (!SAFE_JOB_ID.test(jobId)) throw new Error(`Unsafe worker job identifier: ${jobId}`);
}

function assertSafeRemoteScratchDir(remoteDir: string): void {
  if (
    !remoteDir.startsWith("/") ||
    remoteDir.includes(String.fromCharCode(0)) ||
    /[\r\n\s'"`$;&|<>*?()[\]\\]/u.test(remoteDir) ||
    remoteDir.split("/").includes("..")
  ) {
    throw new Error(`Unsafe worker remote scratch directory: ${remoteDir}`);
  }
}

function assertSafeEndpointPart(value: string, label: string): void {
  if (
    !value ||
    value.includes(String.fromCharCode(0)) ||
    /[\r\n\s]/u.test(value) ||
    value.startsWith("-")
  ) {
    throw new Error(`Unsafe SSH ${label}`);
  }
}

function quoteRemotePath(path: string): string {
  // All remote paths are generated from a validated absolute scratch root and
  // bounded identifiers. Keep shell quoting at the final command boundary.
  return quotePosixShellWord(path);
}

function parseBundleNames(output: string): string[] {
  const names = output ? output.trim().split("\n").filter(Boolean) : [];
  for (const name of names) assertSafeJobId(name);
  return names;
}

function assertSafeRelativeArtifactPath(relativePath: string): void {
  if (
    !relativePath ||
    relativePath.startsWith("/") ||
    relativePath.split("/").some((part) => part === ".." || part === "") ||
    relativePath.includes(String.fromCharCode(0)) ||
    /[\r\n]/u.test(relativePath)
  ) {
    throw new Error(`Unsafe worker artifact path: ${relativePath}`);
  }
}

function digestLocalArtifact(path: string): `sha256:${string}` {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`worker artifact destination is not a regular file: ${path}`);
  }
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function assertSafeLocalDestination(root: string, path: string): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}/`)) {
    throw new Error(`worker artifact destination escapes jobs directory: ${path}`);
  }
  let current = dirname(resolvedPath);
  while (current.startsWith(resolvedRoot) && current !== resolvedRoot) {
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error(`worker artifact destination contains a symlink: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    current = dirname(current);
  }
  try {
    if (lstatSync(resolvedPath).isSymbolicLink())
      throw new Error(`worker artifact destination is a symlink: ${resolvedPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}

// ────────────────────────────────────────────────────────────
// Worker Sync Service
// ────────────────────────────────────────────────────────────

/**
 * Syncs worker daemon status from remote worker nodes.
 *
 * Reads remote status.json/events.jsonl over SSH and reconciles
 * the head database. Also collects completed artifacts from
 * worker nodes.
 */
export class WorkerSyncService {
  private executor: CommandExecutor;
  private readonly strictLifecycle: boolean;

  constructor(
    private db: DatabaseLike,
    private config: Config,
    executor?: CommandExecutor,
    options: { strictLifecycle?: boolean } = {},
  ) {
    this.executor = executor ?? new DefaultCommandExecutor();
    // Production uses the default executor and therefore fails closed. Legacy
    // injected test seams can opt into historical observation semantics while
    // characterization fixtures remain reproducible.
    this.strictLifecycle = options.strictLifecycle ?? executor === undefined;
  }

  private sshOptions(): string[] {
    const knownHosts = this.config.knownHostsPath ?? process.env.EIGENGRID_KNOWN_HOSTS;
    if (!knownHosts && this.executor instanceof DefaultCommandExecutor) {
      throw new Error(
        "SSH host identity is not configured; set knownHostsPath or EIGENGRID_KNOWN_HOSTS",
      );
    }
    // Injected executors are test seams; production always carries an explicit
    // known-hosts path and StrictHostKeyChecking=yes.
    return [...SSH_OPTS, "-o", `UserKnownHostsFile=${knownHosts ?? "/dev/null"}`];
  }

  /** Download into a private temporary path, then atomically publish it. */
  private async pullArtifact(
    sshHost: string,
    remoteFile: string,
    localFile: string,
    port: number,
    keyPath: string | undefined,
  ): Promise<{ exitCode: number | undefined; stderr: string }> {
    const parent = dirname(localFile);
    ensurePrivateRunnerDirectory(parent);
    const temporary = join(
      parent,
      `.${localFile.slice(localFile.lastIndexOf("/") + 1)}.${process.pid}.${randomUUID()}.download`,
    );
    try {
      const scpArgs = [
        ...this.sshOptions(),
        ...(keyPath ? ["-i", keyPath] : []),
        "-P",
        String(port),
        `${sshHost}:${quoteRemotePath(remoteFile)}`,
        temporary,
      ];
      const result = await this.executor.run("scp", scpArgs, {
        timeout: 60_000,
        maxOutputBytes: 1024,
      });
      if (result.exitCode === 0) {
        assertRegularRunnerFile(temporary, "worker artifact temporary file");
        atomicPromoteRunnerFile(temporary, localFile);
      }
      return { exitCode: result.exitCode, stderr: result.stderr };
    } finally {
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Preserve the primary transfer/publication result.
      }
    }
  }

  // ── Public API ───────────────────────────────────────────

  /**
   * Sync worker status for a specific node.
   *
   * SSHes into the node, reads `done/` and `failed/` directories,
   * reconciles job/attempt status in the head DB, and appends
   * canonical events.
   */
  async syncNode(nodeName: string): Promise<SyncResult> {
    const errors: string[] = [];
    let syncedJobs = 0;

    try {
      // 1. Resolve node
      const resolvedId = await this.db.resolveNodeId(nodeName);
      if (!resolvedId) {
        return { ok: false, syncedJobs: 0, errors: [`Node not found: ${nodeName}`] };
      }

      const node = await this.db.getNode(resolvedId);
      if (!node) {
        return { ok: false, syncedJobs: 0, errors: [`Node record not found: ${resolvedId}`] };
      }

      const host = node.host as string;
      const user = node.user as string;
      assertSafeEndpointPart(host, "host");
      assertSafeEndpointPart(user, "user");
      const port = (node.port as number) ?? 22;
      const keyPath = node.privateKeyPath ?? undefined;
      const remoteDir = node.remoteScratchDir ?? "/scratch/eigengrid";
      assertSafeRemoteScratchDir(remoteDir);
      const sshHost = `${user}@${host}`;

      // 2. Read done/ and failed/ directories from remote
      const doneResult = await this.sshExec(
        sshHost,
        port,
        keyPath,
        `ls -1 ${quoteRemotePath(`${remoteDir}/done/`)} 2>/dev/null || true`,
      );
      const failedResult = await this.sshExec(
        sshHost,
        port,
        keyPath,
        `ls -1 ${quoteRemotePath(`${remoteDir}/failed/`)} 2>/dev/null || true`,
      );

      if (doneResult.stdoutTruncated || failedResult.stdoutTruncated) {
        throw new Error("worker terminal bundle listing exceeded the bounded capture limit");
      }

      const doneBundles = parseBundleNames(doneResult.stdout);
      const failedBundles = parseBundleNames(failedResult.stdout);

      // A worker must never expose the same job in both terminal namespaces.
      // Processing both would create two competing authoritative receipts and
      // could make a later sync project a different terminal state. Refuse the
      // node snapshot as a whole until the operator reconciles the conflict.
      const doneSet = new Set(doneBundles);
      const conflictingBundles = failedBundles.filter((jobId) => doneSet.has(jobId));
      if (conflictingBundles.length > 0) {
        throw new Error(
          `worker exposes a job in both done and failed bundles: ${conflictingBundles.join(", ")}`,
        );
      }

      // 3. Process done bundles
      for (const jobId of doneBundles) {
        try {
          const synced = await this.syncCompletedBundle(
            sshHost,
            port,
            keyPath,
            remoteDir,
            jobId,
            "done",
          );
          if (synced) syncedJobs++;
        } catch (err) {
          errors.push(`Failed to sync done bundle ${jobId}: ${(err as Error).message}`);
        }
      }

      // 4. Process failed bundles
      for (const jobId of failedBundles) {
        try {
          const synced = await this.syncCompletedBundle(
            sshHost,
            port,
            keyPath,
            remoteDir,
            jobId,
            "failed",
          );
          if (synced) syncedJobs++;
        } catch (err) {
          errors.push(`Failed to sync failed bundle ${jobId}: ${(err as Error).message}`);
        }
      }

      return { ok: errors.length === 0, syncedJobs, errors };
    } catch (err) {
      return {
        ok: false,
        syncedJobs,
        errors: [...errors, `syncNode error: ${(err as Error).message}`],
      };
    }
  }

  /**
   * Collect completed artifacts from a worker for a specific job.
   *
   * Looks up the job's attempt to determine the node, SSHes into
   * it, reads the job bundle from done/<jobId>/ or failed/<jobId>/,
   * copies artifacts to the local jobs directory, and registers
   * them in the DB.
   */
  async collectArtifacts(jobId: string, nodeName?: string): Promise<SyncResult> {
    const errors: string[] = [];

    try {
      // 1. Resolve job ID
      let resolvedId: string;
      try {
        resolvedId = await this.db.resolveJobId(jobId);
      } catch {
        return { ok: false, syncedJobs: 0, errors: [`Job not found: ${jobId}`] };
      }
      assertSafeJobId(resolvedId);

      // 2. Get job and latest attempt
      const job = await this.db.getJob(resolvedId);
      if (!job) {
        return { ok: false, syncedJobs: 0, errors: [`Job not found: ${resolvedId}`] };
      }

      const attempts = await this.db.listJobAttempts(resolvedId);
      const latestAttempt = attempts[attempts.length - 1];
      if (!latestAttempt) {
        return { ok: false, syncedJobs: 0, errors: [`No attempts found for job ${resolvedId}`] };
      }

      // 3. Determine the node — prefer explicit nodeName, fallback to attempt inference
      let host: string;
      let user: string;
      let port: number;
      let keyPath: string | undefined;
      let remoteScratchDir: string;

      if (nodeName) {
        try {
          const resolvedNodeId = await this.db.resolveNodeId(nodeName);
          const nodeRecord = await this.db.getNode(resolvedNodeId);
          if (nodeRecord) {
            host = nodeRecord.host as string;
            user = nodeRecord.user as string;
            port = (nodeRecord.port as number) ?? 22;
            keyPath = nodeRecord.privateKeyPath ?? undefined;
            remoteScratchDir = nodeRecord.remoteScratchDir ?? "/scratch/eigengrid";
          } else {
            throw new Error(`Node record not found: ${nodeName}`);
          }
        } catch {
          // Fallback: infer node from attempt metadata
          const remoteBase = latestAttempt.cwd ?? "";
          remoteScratchDir = remoteBase.split("/").slice(0, -2).join("/") || "/scratch/eigengrid";

          const nodes = await this.db.listNodes();
          const node = nodes.find(
            (n) => n.remoteScratchDir === remoteScratchDir || n.runner === "worker-daemon",
          );

          if (!node) {
            return {
              ok: false,
              syncedJobs: 0,
              errors: [
                "Could not determine remote node. Use --node <name> to specify the worker node explicitly.",
              ],
            };
          }

          host = node.host;
          user = node.user;
          port = node.port ?? 22;
          keyPath = node.privateKeyPath ?? undefined;
        }
      } else {
        // No explicit node — infer from attempt metadata
        const remoteBase = latestAttempt.cwd ?? "";
        remoteScratchDir = remoteBase.split("/").slice(0, -2).join("/") || "/scratch/eigengrid";

        const nodes = await this.db.listNodes();
        const node = nodes.find(
          (n) => n.remoteScratchDir === remoteScratchDir || n.runner === "worker-daemon",
        );

        if (!node) {
          return {
            ok: false,
            syncedJobs: 0,
            errors: [
              "Could not determine remote node. Use --node <name> to specify the worker node explicitly.",
            ],
          };
        }

        host = node.host;
        user = node.user;
        port = node.port ?? 22;
        keyPath = node.privateKeyPath ?? undefined;
      }

      assertSafeEndpointPart(host, "host");
      assertSafeEndpointPart(user, "user");
      assertSafeRemoteScratchDir(remoteScratchDir);
      const sshHost = `${user}@${host}`;

      // 4. Look for bundle in done/ or failed/
      const doneStatusPath = `${remoteScratchDir}/done/${resolvedId}/status.json`;
      const failedStatusPath = `${remoteScratchDir}/failed/${resolvedId}/status.json`;
      const checkResult = await this.sshExec(
        sshHost,
        port,
        keyPath,
        `ls ${quoteRemotePath(doneStatusPath)} 2>/dev/null || ls ${quoteRemotePath(failedStatusPath)} 2>/dev/null || true`,
      );

      if (checkResult.stdoutTruncated) {
        throw new Error("worker bundle status-path response exceeded the bounded capture limit");
      }

      if (!checkResult.stdout.trim()) {
        return {
          ok: false,
          syncedJobs: 0,
          errors: [`No completed bundle found for job ${resolvedId} on ${host}`],
        };
      }

      // Determine which directory has the bundle
      const observedStatusPath = checkResult.stdout.trim();
      if (observedStatusPath !== doneStatusPath && observedStatusPath !== failedStatusPath) {
        throw new Error("worker returned an unexpected bundle status path");
      }
      const bundleDir = observedStatusPath.slice(0, -"/status.json".length);

      // 5. List files in the bundle directory
      const filesResult = await this.sshExec(
        sshHost,
        port,
        keyPath,
        `find ${quoteRemotePath(bundleDir)} -type f 2>/dev/null`,
      );
      if (filesResult.stdoutTruncated) {
        throw new Error("worker artifact listing exceeded the bounded capture limit");
      }
      const metadataFiles = new Set([
        "manifest.json",
        "status.json",
        "receipt.json",
        "receipts.jsonl",
        "events.jsonl",
        "pid",
        "exit.status",
      ]);
      const files = filesResult.stdout
        ? filesResult.stdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .filter((file) => !metadataFiles.has(file.slice(file.lastIndexOf("/") + 1)))
        : [];
      const bundlePrefix = `${bundleDir}/`;
      for (const remoteFile of files) {
        if (!remoteFile.startsWith(bundlePrefix)) {
          throw new Error("worker returned an artifact outside the selected bundle");
        }
        assertSafeRelativeArtifactPath(remoteFile.slice(bundlePrefix.length));
      }

      // 6. Read status.json for exit code and state
      const statusJsonResult = await this.sshExec(
        sshHost,
        port,
        keyPath,
        `cat ${quoteRemotePath(`${bundleDir}/status.json`)} 2>/dev/null || true`,
      );
      if (statusJsonResult.stdoutTruncated) {
        throw new Error("worker status.json exceeded the bounded capture limit");
      }
      let exitCode: number | undefined;
      let state: string | undefined;
      if (statusJsonResult.stdout.trim()) {
        try {
          const statusData = JSON.parse(statusJsonResult.stdout.trim());
          exitCode = statusData.exitCode;
          state = statusData.state;
        } catch (error) {
          if (this.strictLifecycle) {
            throw new Error(
              `worker status.json is invalid: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }

      // Terminal worker observations are authoritative only when accompanied
      // by the signed-by-digest durable receipt emitted by the worker. Legacy
      // injected executors remain readable for characterization tests.
      const receiptJsonResult = await this.sshExec(
        sshHost,
        port,
        keyPath,
        `cat ${quoteRemotePath(`${bundleDir}/receipt.json`)} 2>/dev/null || true`,
      );
      if (receiptJsonResult.stdoutTruncated) {
        throw new Error("worker receipt.json exceeded the bounded capture limit");
      }
      let receipt: WorkerReceipt | undefined;
      if (receiptJsonResult.stdout.trim()) {
        const verified = verifyWorkerReceipt(JSON.parse(receiptJsonResult.stdout.trim()));
        if (!verified.ok) throw new Error(`invalid worker receipt: ${verified.errors.join("; ")}`);
        receipt = verified.receipt;
      } else if (this.strictLifecycle) {
        throw new Error("completed worker bundle has no durable receipt.json");
      }
      if (receipt) {
        if (receipt.jobId !== resolvedId || receipt.attemptId !== latestAttempt.id) {
          throw new Error("worker receipt identity does not match the persisted attempt");
        }
        state =
          receipt.state === "completed"
            ? "completed"
            : receipt.state === "failed"
              ? "failed"
              : state;
        exitCode = receipt.exitCode ?? exitCode;

        if (this.strictLifecycle) {
          const expectedFiles = new Set(Object.keys(receipt.artifactDigests));
          const observedFiles = new Set(files);
          if (
            expectedFiles.size !== observedFiles.size ||
            [...expectedFiles].some((file) => !observedFiles.has(`${bundleDir}/${file}`))
          ) {
            throw new Error("worker artifact listing does not match the receipt digest set");
          }
        }
      }

      // 7. Copy artifacts to local jobs directory
      const localJobDir = `${this.config.jobsDir}/${resolvedId}`;
      ensurePrivateRunnerDirectory(this.config.jobsDir);
      ensurePrivateRunnerDirectory(localJobDir);

      let pulledCount = 0;
      for (const remoteFile of files) {
        const fileName = remoteFile.replace(`${bundleDir}/`, "");
        assertSafeRelativeArtifactPath(fileName);
        const localFile = `${localJobDir}/${fileName}`;
        assertSafeLocalDestination(this.config.jobsDir, localFile);
        ensurePrivateRunnerDirectory(localFile.substring(0, localFile.lastIndexOf("/")));

        const pullResult = await this.pullArtifact(sshHost, remoteFile, localFile, port, keyPath);

        if (pullResult.exitCode === 0) {
          if (this.strictLifecycle) {
            const expectedDigest = receipt?.artifactDigests[fileName];
            if (!expectedDigest) {
              throw new Error(`worker receipt has no digest for artifact ${fileName}`);
            }
            const actualDigest = digestLocalArtifact(localFile);
            if (actualDigest !== expectedDigest) {
              throw new Error(
                `worker artifact digest mismatch for ${fileName}: expected ${expectedDigest}, got ${actualDigest}`,
              );
            }
          }
          // Register artifact
          const artifact = {
            id: generateId("artifact"),
            jobId: resolvedId,
            attemptId: latestAttempt.id,
            kind: fileName.endsWith(".log") ? "log" : "output",
            path: localFile,
            label: fileName,
            mimeType: "text/plain",
            sizeBytes: statSync(localFile).size,
          } as const;
          const inserted =
            typeof this.db.createArtifactIfAbsent === "function"
              ? await this.db.createArtifactIfAbsent(artifact)
              : !(await this.db.listArtifacts(resolvedId)).some(
                  (existing) =>
                    existing.attemptId === artifact.attemptId &&
                    existing.kind === artifact.kind &&
                    existing.path === artifact.path,
                ) && (await this.db.createArtifact(artifact), true);
          if (inserted) pulledCount++;
        }
      }

      // 8. Update job status in DB
      if (state === "completed" || state === "failed") {
        const terminalExitCode = exitCode ?? (state === "completed" ? 0 : 1);
        const terminalFinishedAt = receipt?.finishedAt ?? Date.now();
        if (this.strictLifecycle) {
          // The production path commits attempt, aggregate, and terminal
          // event as one provider transaction. Separate writes can expose a
          // terminal event while the aggregate remains queued/running.
          await this.db.materializeTerminalAttempt({
            jobId: resolvedId,
            attemptId: latestAttempt.id,
            status: state,
            exitCode: terminalExitCode,
            finishedAt: terminalFinishedAt,
            source: "cli",
            payload: { exitCode: terminalExitCode, host, artifactsPulled: pulledCount },
          });
        } else {
          // Preserve the historical injected-executor characterization path;
          // it is never selected by the application composition root.
          await this.db.updateJobStatus(resolvedId, state);
          await this.db.updateJobAttemptStatus(latestAttempt.id, state, {
            exitCode: terminalExitCode,
            finishedAt: terminalFinishedAt,
          });
          await this.db.appendEvent({
            id: generateId("evt"),
            type: state === "completed" ? "process.completed" : "process.failed",
            at: Date.now(),
            source: "cli",
            jobId: resolvedId,
            attemptId: latestAttempt.id,
            payload: { exitCode: terminalExitCode, host, artifactsPulled: pulledCount },
          });
        }
      }

      return { ok: true, syncedJobs: 1, errors };
    } catch (err) {
      return {
        ok: false,
        syncedJobs: 0,
        errors: [...errors, `collectArtifacts error: ${(err as Error).message}`],
      };
    }
  }

  // ── Private Helpers ──────────────────────────────────────

  /**
   * Sync a single completed bundle (from done/ or failed/) to the head DB.
   */
  private async syncCompletedBundle(
    sshHost: string,
    port: number,
    keyPath: string | undefined,
    remoteDir: string,
    jobId: string,
    subDir: "done" | "failed",
  ): Promise<boolean> {
    assertSafeJobId(jobId);
    assertSafeRemoteScratchDir(remoteDir);
    const bundleDir = `${remoteDir}/${subDir}/${jobId}`;
    const statusPath = `${bundleDir}/status.json`;

    // Read status.json from remote
    const statusResult = await this.sshExec(
      sshHost,
      port,
      keyPath,
      `cat ${quoteRemotePath(statusPath)} 2>/dev/null || true`,
    );

    if (statusResult.stdoutTruncated) {
      throw new Error("worker status.json exceeded the bounded capture limit");
    }

    if (!statusResult.stdout.trim()) return false;

    let statusData: Record<string, unknown>;
    try {
      statusData = JSON.parse(statusResult.stdout.trim());
    } catch {
      return false;
    }

    const statusJobId = statusData.jobId as string;
    assertSafeJobId(statusJobId);
    if (statusJobId !== jobId) return false;
    const state = statusData.state as string;
    const exitCode = statusData.exitCode as number | undefined;
    const finishedAt = statusData.finishedAt as number | undefined;

    if (!statusJobId) return false;

    const receiptResult = await this.sshExec(
      sshHost,
      port,
      keyPath,
      `cat ${quoteRemotePath(`${bundleDir}/receipt.json`)} 2>/dev/null || true`,
    );
    if (receiptResult.stdoutTruncated) {
      throw new Error("worker receipt.json exceeded the bounded capture limit");
    }
    let receipt: WorkerReceipt | undefined;
    if (receiptResult.stdout.trim()) {
      const verified = verifyWorkerReceipt(JSON.parse(receiptResult.stdout.trim()));
      if (!verified.ok) throw new Error(`invalid worker receipt: ${verified.errors.join("; ")}`);
      receipt = verified.receipt;
    } else if (this.strictLifecycle) {
      throw new Error(`worker bundle ${statusJobId} has no durable receipt.json`);
    }
    const attempts = await this.db.listJobAttempts(statusJobId);
    const latestAttempt = attempts[attempts.length - 1];
    if (
      receipt &&
      (!latestAttempt || receipt.jobId !== statusJobId || receipt.attemptId !== latestAttempt.id)
    ) {
      throw new Error("worker receipt identity does not match the persisted attempt");
    }
    const authoritativeState =
      receipt?.state === "completed" ? "completed" : receipt?.state === "failed" ? "failed" : state;
    const authoritativeExitCode = receipt?.exitCode ?? exitCode;
    const authoritativeFinishedAt = receipt?.finishedAt ?? finishedAt;

    // A worker receipt is not authoritative until the corresponding aggregate
    // transition succeeds. Surface the error to syncNode rather than claiming
    // success with a contradictory terminal event.
    if (authoritativeState === "completed" || authoritativeState === "failed") {
      const newStatus = authoritativeState === "completed" ? "completed" : "failed";
      const terminalExitCode =
        authoritativeExitCode ?? (authoritativeState === "completed" ? 0 : 1);
      const terminalFinishedAt = authoritativeFinishedAt ?? Date.now();
      if (this.strictLifecycle) {
        if (!latestAttempt) throw new Error("worker terminal bundle has no persisted attempt");
        // Commit the complete terminal projection through the provider's
        // atomic materializer; it owns the attempt/job transition and event.
        await this.db.materializeTerminalAttempt({
          jobId: statusJobId,
          attemptId: latestAttempt.id,
          status: newStatus,
          exitCode: terminalExitCode,
          finishedAt: terminalFinishedAt,
          source: "cli",
          payload: {
            exitCode: terminalExitCode,
            syncFrom: "worker-daemon",
            remotePath: bundleDir,
          },
        });
      } else {
        // Historical injected-executor characterization only.
        try {
          await this.db.updateJobStatus(statusJobId, newStatus);
        } catch (error) {
          if (this.strictLifecycle) throw error;
        }
        if (latestAttempt) {
          try {
            await this.db.updateJobAttemptStatus(latestAttempt.id, newStatus, {
              exitCode: terminalExitCode,
              finishedAt: terminalFinishedAt,
            });
          } catch (error) {
            if (this.strictLifecycle) throw error;
          }
        }
      }
    }

    // The strict branch above lets materializeTerminalAttempt own the
    // terminal event. Only the legacy characterization path appends it here.
    if (!this.strictLifecycle) {
      await this.db.appendEvent({
        id: generateId("evt"),
        type: authoritativeState === "completed" ? "process.completed" : "process.failed",
        at: Date.now(),
        source: "cli",
        jobId: statusJobId,
        attemptId: latestAttempt?.id,
        payload: {
          exitCode: authoritativeExitCode,
          syncFrom: "worker-daemon",
          remotePath: bundleDir,
        },
      });
    }

    return true;
  }

  /**
   * Execute a remote SSH command and return stdout/stderr/exitCode.
   */
  private async sshExec(
    sshHost: string,
    port: number,
    keyPath: string | undefined,
    command: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; stdoutTruncated: boolean }> {
    assertSafeEndpointPart(sshHost, "endpoint");
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`Invalid SSH port: ${port}`);
    }
    const args = [
      "-T",
      ...this.sshOptions(),
      "-p",
      String(port),
      ...(keyPath ? ["-i", keyPath] : []),
      sshHost,
      command,
    ];
    const result = await this.executor.run("ssh", args, {
      timeout: 30_000,
      maxOutputBytes: 10240,
    });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
    };
  }
}
