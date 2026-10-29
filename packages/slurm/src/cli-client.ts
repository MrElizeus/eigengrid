import { parseSinfoNodes, parseSinfoPartitions } from "./accounting-mapper";
import {
  parseSacctRecords,
  SACCT_ENV,
  sacctContractForVersion,
  type SacctContract,
} from "./accounting-contract";
import { BunExecutor, type CliExecutor } from "./executor";
import { corroborateNativeAccounting, NATIVE_ACCOUNTING_SCHEMA } from "./native-accounting";
import {
  isSlurmTerminal,
  mapSlurmState,
  parseSbatchOutput,
  parseSqueueState,
} from "./state-mapper";
import type {
  SlurmAccountingRecord,
  SlurmClient,
  SlurmJobState,
  SlurmJobStatus,
  SlurmNode,
  SlurmPartition,
  SlurmSubmitOptions,
  SlurmSubmitResult,
} from "./types";

const SACCT_TIMEOUT_MS = 10_000;
const SBATCH_OUTPUT_LIMIT = 64 * 1024;
const SCHEDULER_OUTPUT_LIMIT = 1024 * 1024;
const SCHEDULER_ERROR_LIMIT = 512 * 1024;

const knownStates = new Set<SlurmJobState>([
  "PENDING",
  "RUNNING",
  "COMPLETING",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
  "TIMEOUT",
  "NODE_FAIL",
  "PREEMPTED",
  "BOOT_FAIL",
  "OUT_OF_MEMORY",
  "SUSPENDED",
  "REQUEUED",
  "RESIZING",
  "CONFIGURING",
  "SIGNALING",
  "STAGE_OUT",
  "STOPPED",
  "SPECIAL_EXIT",
  "REVOKED",
  "DEADLINE",
  "RESV_DEL_HOLD",
  "REQUEUE_HOLD",
  "REQUEUE_FED",
  "UNKNOWN",
]);

function toSlurmState(state: string): SlurmJobState {
  const trimmed = state.trim().toUpperCase();
  return knownStates.has(trimmed as SlurmJobState) ? (trimmed as SlurmJobState) : "UNKNOWN";
}

function firstLine(stdout: string): string {
  return (
    stdout
      .trim()
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ""
  );
}

function errorMessage(
  result: { stderr: string; stdout: string; exitCode: number },
  fallback: string,
): string {
  return result.stderr.trim() || result.stdout.trim() || fallback;
}

/** Slurm identities are returned by the scheduler, never arbitrary shell text. */
function assertSafeJobIdentity(slurmJobId: string): void {
  if (
    !/^[1-9]\d*(?:_\d+)?(?:\+\d+)?(?:\.(?:batch|extern|\d+))?$/u.test(slurmJobId) ||
    slurmJobId.length > 128
  ) {
    throw new Error("invalid Slurm job identity");
  }
}

function assertSafeScriptPath(scriptPath: string): void {
  if (
    !scriptPath ||
    scriptPath.startsWith("-") ||
    scriptPath.includes(String.fromCharCode(0)) ||
    /[\r\n]/u.test(scriptPath)
  ) {
    throw new Error("invalid Slurm submission script path");
  }
}

export class SlurmCliClient implements SlurmClient {
  private readonly executor: CliExecutor;
  private readonly accountingContract: SacctContract;

  constructor(executor: CliExecutor = new BunExecutor(), slurmVersion = "23.11.4") {
    this.executor = executor;
    this.accountingContract = sacctContractForVersion(slurmVersion);
  }

  async submitJob(scriptPath: string, _opts?: SlurmSubmitOptions): Promise<SlurmSubmitResult> {
    assertSafeScriptPath(scriptPath);
    const result = await this.executor.run("sbatch", ["--parsable", scriptPath], {
      maxOutputBytes: SBATCH_OUTPUT_LIMIT,
      maxErrorBytes: SCHEDULER_ERROR_LIMIT,
    });

    if (result.stdoutTruncated || result.stderrTruncated) {
      return {
        slurmJobId: "",
        success: false,
        ambiguous: true,
        error: "sbatch output exceeded the bounded capture limit",
      };
    }

    if (result.exitCode !== 0) {
      return {
        slurmJobId: "",
        success: false,
        ambiguous: result.timedOut === true || result.exitCode === undefined,
        error: errorMessage(result, `sbatch exited with code ${result.exitCode}`),
      };
    }

    const parsed = parseSbatchOutput(result.stdout);
    return parsed.success ? parsed : { slurmJobId: "", ...parsed, ambiguous: true };
  }

  async getJobStatus(slurmJobId: string): Promise<SlurmJobStatus> {
    assertSafeJobIdentity(slurmJobId);
    const accounting = await this.getAccounting(slurmJobId).catch(() => null);
    if (accounting && accounting.state !== "UNKNOWN") {
      return {
        slurmJobId,
        state: accounting.state,
        stateCompact: mapSlurmState(accounting.state),
        elapsed: accounting.elapsed,
        exitCode: accounting.exitCode,
        signal: accounting.signal,
        derivedExitCode: accounting.derivedExitCode,
        derivedSignal: accounting.derivedSignal,
        rawState: accounting.rawState,
        source: "sacct",
        nodeName: accounting.nodeName,
        reason: accounting.reason,
      };
    }

    const squeue = await this.executor.run(
      "squeue",
      ["--job", slurmJobId, "--noheader", "--format", "%t"],
      {
        timeout: SACCT_TIMEOUT_MS,
        maxOutputBytes: SCHEDULER_OUTPUT_LIMIT,
        maxErrorBytes: SCHEDULER_ERROR_LIMIT,
      },
    );

    const squeueState = firstLine(squeue.stdout);
    if (
      squeue.exitCode === 0 &&
      !squeue.stdoutTruncated &&
      !squeue.stderrTruncated &&
      squeueState
    ) {
      const observedState = parseSqueueState(squeueState);
      // Queue/controller cache alone cannot establish durable terminal truth.
      const state = isSlurmTerminal(observedState) ? "UNKNOWN" : observedState;
      return {
        slurmJobId,
        state,
        stateCompact: mapSlurmState(state),
        rawState: squeueState,
        source: "squeue",
        accountingPending: true,
      };
    }

    return {
      slurmJobId,
      state: "UNKNOWN",
      stateCompact: "unknown",
      accountingPending: true,
    };
  }

  async cancelJob(
    slurmJobId: string,
  ): Promise<{ success: boolean; error?: string; ambiguous?: boolean }> {
    assertSafeJobIdentity(slurmJobId);
    const result = await this.executor.run("scancel", ["--quiet", slurmJobId], {
      maxOutputBytes: SBATCH_OUTPUT_LIMIT,
      maxErrorBytes: SCHEDULER_ERROR_LIMIT,
    });

    if (result.exitCode === 0) {
      return { success: true };
    }

    return {
      success: false,
      ambiguous: result.timedOut === true || result.exitCode === undefined,
      error: errorMessage(result, `scancel exited with code ${result.exitCode}`),
    };
  }

  async getNodes(): Promise<SlurmNode[]> {
    const result = await this.executor.run(
      "sinfo",
      ["--noheader", "--format", "%N|%t|%c|%m|%e|%O"],
      {
        maxOutputBytes: SCHEDULER_OUTPUT_LIMIT,
        maxErrorBytes: SCHEDULER_ERROR_LIMIT,
      },
    );
    return result.exitCode === 0 && !result.stdoutTruncated && !result.stderrTruncated
      ? parseSinfoNodes(result.stdout)
      : [];
  }

  async getPartitions(): Promise<SlurmPartition[]> {
    const result = await this.executor.run(
      "sinfo",
      ["--noheader", "--format", "%P|%a|%l|%L|%D|%N"],
      {
        maxOutputBytes: SCHEDULER_OUTPUT_LIMIT,
        maxErrorBytes: SCHEDULER_ERROR_LIMIT,
      },
    );
    return result.exitCode === 0 && !result.stdoutTruncated && !result.stderrTruncated
      ? parseSinfoPartitions(result.stdout)
      : [];
  }

  async getAccounting(slurmJobId: string): Promise<SlurmAccountingRecord | null> {
    assertSafeJobIdentity(slurmJobId);
    const result = await this.executor.run(
      "sacct",
      [
        "--jobs",
        slurmJobId,
        "--noheader",
        "--parsable2",
        "--format",
        this.accountingContract.format,
      ],
      {
        env: SACCT_ENV,
        timeout: SACCT_TIMEOUT_MS,
        maxOutputBytes: SCHEDULER_OUTPUT_LIMIT,
        maxErrorBytes: SCHEDULER_ERROR_LIMIT,
      },
    );

    if (
      result.exitCode !== 0 ||
      result.timedOut ||
      result.stdoutTruncated ||
      result.stderrTruncated
    ) {
      return null;
    }

    let records;
    try {
      records = parseSacctRecords(result.stdout, this.accountingContract);
    } catch {
      return null;
    }
    const allocations = records.filter(
      (row) => row.kind === "allocation" && row.jobId === slurmJobId,
    );
    if (allocations.length !== 1) {
      return null;
    }
    let row = allocations[0];
    records = records.filter((record) => record.allocationId === slurmJobId);
    let nativeAccountingSchema: string | undefined;
    if (isSlurmTerminal(toSlurmState(row.state))) {
      if (
        row.exitCode === undefined ||
        row.signal === undefined ||
        row.derivedExitCode === undefined ||
        row.derivedSignal === undefined
      )
        return null;
      try {
        const native = await this.executor.run("sacct", ["--jobs", slurmJobId, "--json"], {
          env: SACCT_ENV,
          timeout: SACCT_TIMEOUT_MS,
          maxOutputBytes: SCHEDULER_OUTPUT_LIMIT,
          maxErrorBytes: SCHEDULER_ERROR_LIMIT,
        });
        if (
          native.exitCode !== 0 ||
          native.timedOut ||
          native.stdoutTruncated ||
          native.stderrTruncated
        )
          return null;
        records = corroborateNativeAccounting(native.stdout, records, this.accountingContract);
        row = records.find((record) => record.kind === "allocation")!;
        nativeAccountingSchema = NATIVE_ACCOUNTING_SCHEMA;
      } catch {
        return null;
      }
    }
    let state = toSlurmState(row.state);
    let reason = row.reason || undefined;
    if (isSlurmTerminal(state) && (row.exitCode === undefined || row.signal === undefined)) {
      state = "UNKNOWN";
      reason = "accounting_exit_pending";
    }
    if (state === "COMPLETED") {
      if (row.derivedExitCode === undefined || row.derivedSignal === undefined) {
        state = "UNKNOWN";
        reason = "accounting_derived_exit_pending";
      } else if (
        records.some(
          (record) =>
            (record.exitCode ?? 0) !== 0 ||
            (record.signal ?? 0) !== 0 ||
            (record.derivedExitCode ?? 0) !== 0 ||
            (record.derivedSignal ?? 0) !== 0 ||
            (isSlurmTerminal(toSlurmState(record.state)) && record.state !== "COMPLETED"),
        )
      ) {
        state = records.some((record) => record.state === "OUT_OF_MEMORY")
          ? "OUT_OF_MEMORY"
          : "FAILED";
        reason = "accounting_inconsistent_completion";
      }
    }

    return {
      slurmJobId: row.jobId,
      state,
      exitCode: row.exitCode,
      signal: row.signal,
      derivedExitCode: row.derivedExitCode,
      derivedSignal: row.derivedSignal,
      rawState: row.rawState,
      reason,
      uid: row.uid,
      submittedAt: row.submittedAt || undefined,
      cluster: row.cluster || undefined,
      nodeName: row.nodeList || undefined,
      accountingSchema: this.accountingContract.schema,
      nativeAccountingSchema,
      records,
      elapsed: row.elapsed || undefined,
      maxRss: row.maxRss || undefined,
      reqMem: row.reqMem || undefined,
      nNodes: row.nNodes,
      nCpus: row.nCpus,
    };
  }
}
