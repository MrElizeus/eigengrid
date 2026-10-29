import { createHash } from "node:crypto";
import { z } from "zod";
import { hasControlCharacter } from "./script-builder";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u);
const timestamp = z.string().datetime({ precision: 3 });

/** Transport correlation, not an approval or permission to dispatch. */
export const SlurmSubmissionBindingSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.slurm-submission-binding/v1"),
    operationId: identifier,
    requestDigest: digest,
    admissionDigest: digest,
    scriptDigest: digest,
    siteProfileDigest: digest,
    cluster: identifier,
    uid: z.number().int().positive().max(4_294_967_294),
    notBefore: timestamp,
    expiresAt: timestamp,
    resources: z
      .object({
        partition: identifier,
        node: identifier,
        account: identifier,
        cpus: z.number().int().min(1).max(16),
        memoryMiB: z.number().int().min(128).max(30_000),
        walltimeSeconds: z.number().int().min(60).max(86_400),
        gpuCount: z.literal(1).optional(),
      })
      .strict(),
    bindingDigest: digest,
  })
  .strict();
export type SlurmSubmissionBinding = z.infer<typeof SlurmSubmissionBindingSchema>;
export type SlurmSubmissionBindingInput = Omit<
  SlurmSubmissionBinding,
  "schemaVersion" | "bindingDigest"
>;

export function slurmScriptDigest(script: Uint8Array): string {
  return createHash("sha256").update(script).digest("hex");
}

function bindingDigest(binding: Omit<SlurmSubmissionBinding, "bindingDigest">): string {
  // A closed, ordered wire representation, independent of caller property order.
  const { resources } = binding;
  const material: unknown[] = [
    binding.schemaVersion,
    binding.operationId,
    binding.requestDigest,
    binding.admissionDigest,
    binding.scriptDigest,
    binding.siteProfileDigest,
    binding.cluster,
    binding.uid,
    binding.notBefore,
    binding.expiresAt,
    resources.partition,
    resources.node,
    resources.account,
    resources.cpus,
    resources.memoryMiB,
    resources.walltimeSeconds,
  ];
  // Keep the historical CPU identity bytes stable. GPU allocation becomes
  // part of the binding digest only when the optional field is present.
  if (resources.gpuCount !== undefined) material.push(resources.gpuCount);
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

export function createSlurmSubmissionBinding(
  input: SlurmSubmissionBindingInput,
): SlurmSubmissionBinding {
  const parsed = SlurmSubmissionBindingSchema.parse({
    ...input,
    schemaVersion: "eigengrid.slurm-submission-binding/v1",
    bindingDigest: "0".repeat(64),
  });
  return assertSlurmSubmissionBinding({ ...parsed, bindingDigest: bindingDigest(parsed) });
}

export function assertSlurmSubmissionBinding(value: unknown): SlurmSubmissionBinding {
  const binding = SlurmSubmissionBindingSchema.parse(value);
  const duration = Date.parse(binding.expiresAt) - Date.parse(binding.notBefore);
  if (duration < 1_000 || duration > 600_000) {
    throw new Error("Slurm submission window must be between one second and ten minutes");
  }
  if (binding.bindingDigest !== bindingDigest(binding)) {
    throw new Error("Slurm submission binding digest mismatch");
  }
  return binding;
}

export function slurmSubmissionMarker(binding: SlurmSubmissionBinding): string {
  return `egv1:${assertSlurmSubmissionBinding(binding).bindingDigest}`;
}

export function slurmSubmissionJobName(binding: SlurmSubmissionBinding): string {
  return `egv1-${assertSlurmSubmissionBinding(binding).bindingDigest}`;
}

export const SLURM_SUBMISSION_ACCOUNTING_FORMAT =
  "JobIDRaw,Cluster%128,UID,Submit,JobName%128,Comment%128";
export const SLURM_SUBMISSION_QUEUE_FORMAT = "%i|%U|%V|%j|%k";

export interface SlurmSubmissionObservation {
  source: "sacct" | "squeue";
  jobId: string;
  cluster: string;
  uid: number;
  submittedAt: string;
  jobName: string;
  marker: string;
}

/** Strict 23.11 allocation-only wire parser; malformed/partial rows are not skipped. */
export function parseSlurmSubmissionObservations(
  stdout: string,
  source: "sacct" | "squeue",
  localCluster: string,
): SlurmSubmissionObservation[] {
  const rows: SlurmSubmissionObservation[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (line === "") continue;
    const fields = line.split("|");
    if (fields.length !== (source === "sacct" ? 6 : 5)) {
      throw new Error("Slurm submission observation column mismatch");
    }
    const [jobId, cluster, uid, submittedAt, jobName, marker] =
      source === "sacct" ? fields : [fields[0], localCluster, ...fields.slice(1)];
    if (
      !/^[1-9]\d{0,19}$/u.test(jobId) ||
      !identifier.safeParse(cluster).success ||
      !/^[1-9]\d{0,9}$/u.test(uid) ||
      Number(uid) > 4_294_967_294 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(submittedAt) ||
      !Number.isFinite(Date.parse(submittedAt)) ||
      new Date(submittedAt).toISOString() !== submittedAt.replace("Z", ".000Z") ||
      jobName.length > 128 ||
      marker.length > 128 ||
      hasControlCharacter(jobName + marker)
    ) {
      throw new Error("Invalid Slurm submission observation");
    }
    rows.push({ source, jobId, cluster, uid: Number(uid), submittedAt, jobName, marker });
    if (rows.length > 256) throw new Error("Too many Slurm submission observations");
  }
  return rows;
}

export type SlurmSubmissionResolution = {
  status: "matched" | "indeterminate" | "conflict";
  /** Deliberately no outcome of this read-only operation authorizes resubmission. */
  resubmitAllowed: false;
  reason: string;
  observations: SlurmSubmissionObservation[];
  markerEvidence?: "accounting_comment" | "durable_name_and_queue_comment";
  identity?: { jobId: string; cluster: string; uid: number; submittedAt: string };
};

export function resolveSlurmSubmission(
  bindingValue: SlurmSubmissionBinding,
  observations: SlurmSubmissionObservation[],
  complete: { accounting: boolean; queue: boolean },
): SlurmSubmissionResolution {
  const binding = assertSlurmSubmissionBinding(bindingValue);
  const base = { observations, resubmitAllowed: false as const };
  if (observations.length > 512) {
    return { ...base, status: "conflict", reason: "Too many submission observations" };
  }
  const lower = Math.floor(Date.parse(binding.notBefore) / 1_000) * 1_000;
  const upper = Math.ceil(Date.parse(binding.expiresAt) / 1_000) * 1_000;
  const expectedName = slurmSubmissionJobName(binding);
  const expectedMarker = slurmSubmissionMarker(binding);
  const identities = new Map<string, SlurmSubmissionObservation>();
  const seenSources = new Set<string>();
  for (const observation of observations) {
    if (
      !["sacct", "squeue"].includes(observation.source) ||
      !/^[1-9]\d{0,19}$/u.test(observation.jobId) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(observation.submittedAt) ||
      !Number.isFinite(Date.parse(observation.submittedAt)) ||
      new Date(observation.submittedAt).toISOString() !==
        observation.submittedAt.replace("Z", ".000Z") ||
      observation.cluster !== binding.cluster ||
      observation.uid !== binding.uid ||
      observation.jobName !== expectedName ||
      (observation.marker !== expectedMarker &&
        !(observation.source === "sacct" && observation.marker === "")) ||
      Date.parse(observation.submittedAt) < lower ||
      Date.parse(observation.submittedAt) > upper
    ) {
      return {
        ...base,
        status: "conflict",
        reason: "Submission evidence differs from its binding",
      };
    }
    const key = JSON.stringify([
      observation.cluster,
      observation.uid,
      observation.jobId,
      observation.submittedAt,
    ]);
    const sourceKey = `${observation.source}:${key}`;
    if (seenSources.has(sourceKey)) {
      return { ...base, status: "conflict", reason: "Duplicate submission evidence in one source" };
    }
    seenSources.add(sourceKey);
    identities.set(key, observation);
  }
  if (identities.size > 1) {
    return { ...base, status: "conflict", reason: "Multiple scheduler identities for one binding" };
  }
  if (!complete.accounting || !complete.queue) {
    return {
      ...base,
      status: "indeterminate",
      reason: "Scheduler evidence is unavailable or partial",
    };
  }
  const allocation = observations.find((observation) => observation.source === "sacct");
  if (!allocation) {
    return { ...base, status: "indeterminate", reason: "No durable accounting match yet" };
  }
  // Slurm 23.11.4 stores JobName at submission but the job Comment may only
  // arrive with completion (observed job 43). The FULL binding digest is also
  // the durable JobName, not a truncated display label. While that Comment is
  // absent, require the exact live queue marker for the SAME unique identity.
  const markerEvidence =
    allocation.marker === expectedMarker
      ? "accounting_comment"
      : observations.some((observation) => observation.source === "squeue")
        ? "durable_name_and_queue_comment"
        : undefined;
  if (!markerEvidence) {
    return { ...base, status: "indeterminate", reason: "Accounting comment is still pending" };
  }
  return {
    ...base,
    status: "matched",
    markerEvidence,
    reason: "One exact durable scheduler identity; this is not execution or scientific success",
    identity: {
      jobId: allocation.jobId,
      cluster: allocation.cluster,
      uid: allocation.uid,
      submittedAt: allocation.submittedAt,
    },
  };
}
