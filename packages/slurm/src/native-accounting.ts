import type { SacctContract, SacctRecord } from "./accounting-contract";

export const NATIVE_ACCOUNTING_SCHEMA = "slurm-23.11/data_parser-v0.0.40";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid native accounting object");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid native accounting array");
  return value;
}

function optionalNumber(value: unknown, maximum: number): number | undefined {
  const entry = object(value);
  if (typeof entry.set !== "boolean" || entry.infinite !== false) {
    throw new Error("Indeterminate native accounting number");
  }
  if (!entry.set) return undefined;
  if (
    !Number.isSafeInteger(entry.number) ||
    Number(entry.number) < 0 ||
    Number(entry.number) > maximum
  ) {
    throw new Error("Invalid native accounting number");
  }
  return Number(entry.number);
}

function exitPair(value: unknown): { exitCode: number; signal: number } {
  const exit = object(value);
  const status = array(exit.status);
  const code = optionalNumber(exit.return_code, 255);
  const signal = optionalNumber(object(exit.signal).id, 127);
  if (
    status.length !== 1 ||
    !["SUCCESS", "ERROR", "SIGNALED", "CORE_DUMPED"].includes(String(status[0]))
  ) {
    throw new Error("Indeterminate native exit status");
  }
  if (code === undefined && (signal === undefined || signal === 0)) {
    throw new Error("Native exit has neither a return code nor a signal");
  }
  if ((code ?? 0) !== 0 && (signal ?? 0) !== 0) throw new Error("Conflicting native exit status");
  if (status[0] === "SUCCESS" && (code !== 0 || (signal ?? 0) !== 0)) {
    throw new Error("Conflicting native success status");
  }
  return { exitCode: code ?? 0, signal: signal ?? 0 };
}

/** Slurm 23.11 sacct/print.c subtracts 128 from normal exits >=128.
 * Text therefore cannot distinguish exit 9 from exit 137, even after parsing
 * its exit:signal pair correctly. Never guess the missing bit. Corroborate a
 * terminal snapshot with the installed, version-checked native JSON serializer.
 * https://github.com/SchedMD/slurm/blob/slurm-23-11-4-1/src/sacct/print.c
 */
export function corroborateNativeAccounting(
  stdout: string,
  records: SacctRecord[],
  contract: SacctContract,
): SacctRecord[] {
  const document = object(JSON.parse(stdout));
  const meta = object(document.meta);
  const plugin = object(meta.plugin);
  if (
    plugin.data_parser !== "data_parser/v0.0.40" ||
    plugin.accounting_storage !== "accounting_storage/slurmdbd" ||
    object(meta.slurm).release !== contract.version.replace(/[-+].*$/u, "") ||
    array(document.errors).length !== 0 ||
    array(document.warnings).length !== 0
  ) {
    throw new Error("Unqualified or incomplete native accounting response");
  }
  const allocations = records.filter((record) => record.kind === "allocation");
  if (allocations.length !== 1 || !/^[1-9]\d*$/u.test(allocations[0].jobId)) {
    throw new Error("Native V1 accounting requires one non-array allocation");
  }
  const allocation = allocations[0];
  const jobs = array(document.jobs)
    .map(object)
    .filter((job) => String(job.job_id) === allocation.jobId);
  if (jobs.length !== 1) throw new Error("Native accounting job identity is ambiguous");
  const job = jobs[0];
  // UTC is fixed at query time. The no-suffix form is accepted for historical
  // captured UTC fixtures, not interpreted using the process's local timezone.
  const submitted = Date.parse(allocation.submittedAt.replace(/Z?$/u, "Z"));
  if (
    !Number.isFinite(submitted) ||
    object(job.time).submission !== submitted / 1000 ||
    job.cluster !== allocation.cluster
  ) {
    throw new Error("Accounting snapshots refer to different submissions");
  }
  const steps = array(job.steps).map(object);
  if (steps.length !== records.length - 1)
    throw new Error("Accounting step set changed between observations");
  const seen = new Set<string>();
  return records.map((record) => {
    const candidates =
      record.kind === "allocation"
        ? [job]
        : steps.filter((step) => object(step.step).id === record.jobId);
    if (candidates.length !== 1 || seen.has(record.jobId))
      throw new Error("Ambiguous native step identity");
    seen.add(record.jobId);
    const native = candidates[0];
    const states = array(
      record.kind === "allocation" ? object(native.state).current : native.state,
    );
    if (states.length !== 1 || states[0] !== record.state)
      throw new Error("Accounting state changed between observations");
    const exact = exitPair(native.exit_code);
    if (record.exitCode !== exact.exitCode % 128 || record.signal !== exact.signal) {
      throw new Error("Accounting exit observations disagree");
    }
    const derived = record.kind === "allocation" ? exitPair(native.derived_exit_code) : undefined;
    if (
      derived &&
      (record.derivedExitCode !== derived.exitCode || record.derivedSignal !== derived.signal)
    ) {
      throw new Error("Accounting derived exit observations disagree");
    }
    return {
      ...record,
      rawTextExitCode: record.exitCode,
      ...exact,
      ...(derived ? { derivedExitCode: derived.exitCode, derivedSignal: derived.signal } : {}),
    };
  });
}
