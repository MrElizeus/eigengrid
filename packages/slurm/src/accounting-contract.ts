/** Qualified wire contract for the installed Ubuntu Slurm 23.11 line.
 * Field order is shared by the query and decoder; no positional guess/fallback.
 * https://manpages.ubuntu.com/manpages/noble/man1/sacct.1.html
 */
export const SACCT_23_11_FIELDS = Object.freeze([
  "JobID%128",
  "State%64",
  "ExitCode",
  "Elapsed",
  "MaxRSS",
  "ReqMem",
  "NNodes",
  "AllocCPUS",
  "DerivedExitCode",
  "UID",
  "Submit",
  "Cluster",
  "NodeList",
  "Reason",
] as const);

// The Head and worker may have different local timezones. Neither locale nor
// a user's SLURM_TIME_FORMAT may change an execution identity's submission time.
export const SACCT_ENV = Object.freeze({
  LC_ALL: "C",
  TZ: "UTC",
  SLURM_TIME_FORMAT: "%Y-%m-%dT%H:%M:%SZ",
});

export interface SacctContract {
  schema: "slurm-23.11/parsable2-v1";
  version: string;
  fields: readonly string[];
  format: string;
}

export function sacctContractForVersion(version: string): SacctContract {
  if (!/^23\.11\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/u.test(version)) {
    throw new Error(`Unqualified Slurm accounting version: ${version}`);
  }
  return Object.freeze({
    schema: "slurm-23.11/parsable2-v1",
    version,
    fields: SACCT_23_11_FIELDS,
    format: SACCT_23_11_FIELDS.join(","),
  });
}

export interface SacctRecord {
  jobId: string;
  allocationId: string;
  kind: "allocation" | "batch" | "external" | "step";
  stepId?: string;
  rawState: string;
  state: string;
  exitCode?: number;
  /** Text sacct 23.11 loses the high exit bit. Retained after native corroboration. */
  rawTextExitCode?: number;
  signal?: number;
  derivedExitCode?: number;
  derivedSignal?: number;
  elapsed: string;
  maxRss: string;
  reqMem: string;
  nNodes?: number;
  nCpus?: number;
  uid?: number;
  submittedAt: string;
  cluster: string;
  nodeList: string;
  reason: string;
}

function integer(value: string, label: string): number | undefined {
  if (value === "") return undefined;
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`Invalid sacct ${label}`);
  }
  return Number(value);
}

function exitPair(value: string): { exitCode?: number; signal?: number } {
  if (!value) return {};
  const match = /^(\d+):(\d+)$/u.exec(value);
  if (!match || Number(match[1]) > 255 || Number(match[2]) > 127) {
    throw new Error("Invalid sacct exit:signal pair");
  }
  return { exitCode: Number(match[1]), signal: Number(match[2]) };
}

/** Decode complete output or fail closed. Malformed rows are not silently skipped. */
export function parseSacctRecords(stdout: string, contract: SacctContract): SacctRecord[] {
  const names = contract.fields.map((field) => field.split("%")[0]);
  const records: SacctRecord[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const fields = line.split("|").map((field) => field.trim());
    if (fields.length !== names.length) throw new Error("sacct column contract mismatch");
    if (fields[0] === "JobID") {
      if (fields.some((field, index) => field !== names[index])) {
        throw new Error("sacct header contract mismatch");
      }
      continue;
    }
    const values = Object.fromEntries(names.map((name, index) => [name, fields[index]]));
    const identity = /^(\d+(?:_\d+)?(?:\+\d+)?)(?:\.(batch|extern|\d+))?$/u.exec(values.JobID);
    if (!identity) throw new Error("Invalid sacct job identity");
    const stepId = identity[2];
    const exit = exitPair(values.ExitCode);
    const derived = exitPair(values.DerivedExitCode);
    const rawState = values.State;
    // A '+' is truncated output, not sufficient terminal evidence. Unknown
    // states survive as rawState and cannot be promoted to a known terminal.
    const state = /^CANCELLED(?: by \d+)?$/u.test(rawState)
      ? "CANCELLED"
      : /^[A-Z_]+$/u.test(rawState)
        ? rawState
        : "UNKNOWN";
    records.push({
      jobId: values.JobID,
      allocationId: identity[1],
      stepId,
      kind:
        stepId === undefined
          ? "allocation"
          : stepId === "batch"
            ? "batch"
            : stepId === "extern"
              ? "external"
              : "step",
      rawState,
      state,
      ...exit,
      derivedExitCode: derived.exitCode,
      derivedSignal: derived.signal,
      elapsed: values.Elapsed,
      maxRss: values.MaxRSS,
      reqMem: values.ReqMem,
      nNodes: integer(values.NNodes, "NNodes"),
      nCpus: integer(values.AllocCPUS, "AllocCPUS"),
      uid: integer(values.UID, "UID"),
      submittedAt: values.Submit,
      cluster: values.Cluster,
      nodeList: values.NodeList,
      reason: values.Reason,
    });
  }
  return records;
}
