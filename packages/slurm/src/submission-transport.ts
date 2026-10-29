import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { userInfo } from "node:os";
import { z } from "zod";
import { SACCT_ENV, sacctContractForVersion } from "./accounting-contract";
import { hasControlCharacter } from "./script-builder";
import {
  BunExecutor,
  type CliExecutionOptions,
  type CliExecutor,
  type CliResult,
} from "./executor";
import {
  assertSlurmSubmissionBinding,
  parseSlurmSubmissionObservations,
  resolveSlurmSubmission,
  SLURM_SUBMISSION_ACCOUNTING_FORMAT,
  SLURM_SUBMISSION_QUEUE_FORMAT,
  slurmScriptDigest,
  slurmSubmissionJobName,
  slurmSubmissionMarker,
  type SlurmSubmissionBinding,
  type SlurmSubmissionObservation,
  type SlurmSubmissionResolution,
} from "./submission-identity";

const schedulerIdentifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u);
export const SlurmSubmissionProfileSchema = z
  .object({
    cluster: schedulerIdentifier,
    slurmVersion: z.string(),
    uid: z.number().int().positive().max(4_294_967_294),
    username: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/u),
    home: z.string(),
    submissionDirectory: z.string(),
    siteProfileDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    partition: schedulerIdentifier,
    node: schedulerIdentifier,
    account: schedulerIdentifier,
    cpuLimit: z.number().int().min(1).max(16),
    memoryMiBLimit: z.number().int().min(128).max(30_000),
    walltimeLimitSeconds: z.number().int().min(60).max(86_400),
    gpuType: schedulerIdentifier.optional(),
    gpuLimit: z.literal(1).optional(),
  })
  .strict()
  .superRefine((profile, context) => {
    if ((profile.gpuType === undefined) !== (profile.gpuLimit === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "GPU type and GPU limit must be provisioned together",
      });
    }
  });

/** Root-provisioned profile, never browser-supplied identity or executable paths. */
export type SlurmSubmissionProfile = z.infer<typeof SlurmSubmissionProfileSchema>;
export type SlurmSubmissionAcknowledgement =
  | { status: "acknowledged"; jobId: string; cluster: string; resubmitAllowed: false }
  | { status: "indeterminate"; reason: string; resubmitAllowed: false };

function complete(result: CliResult): boolean {
  return (
    result.exitCode === 0 && !result.timedOut && !result.stdoutTruncated && !result.stderrTruncated
  );
}

function utcSeconds(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid Slurm transport clock");
  return date.toISOString().slice(0, 19);
}

/**
 * Narrow CLI transport intended to run INSIDE the scientific user's submitter.
 * It owns no mission/attempt state and grants no authority. The caller must have
 * consumed the canonical durable admission and its one-shot transport claim.
 * Script bytes come from the trusted renderer, NEVER from a browser/model RPC.
 */
export class SlurmSubmissionTransport {
  private readonly profile: SlurmSubmissionProfile;
  private readonly options: CliExecutionOptions;

  constructor(
    profile: SlurmSubmissionProfile,
    private readonly executor: CliExecutor = new BunExecutor(),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.profile = SlurmSubmissionProfileSchema.parse(profile);
    sacctContractForVersion(profile.slurmVersion);
    this.assertLocalIdentity();
    this.options = {
      inheritEnv: false,
      env: {
        ...SACCT_ENV,
        PATH: "/usr/bin:/bin",
        HOME: profile.home,
        USER: profile.username,
        LOGNAME: profile.username,
      },
      cwd: profile.submissionDirectory,
      timeout: 10_000,
      maxOutputBytes: 1024 * 1024,
      maxErrorBytes: 64 * 1024,
    };
  }

  private assertLocalIdentity(): void {
    const profile = this.profile;
    if (
      process.platform !== "linux" ||
      process.getuid?.() !== profile.uid ||
      userInfo().username !== profile.username ||
      userInfo().homedir !== profile.home
    ) {
      throw new Error("Slurm submitter must run as its configured non-root scientific UID");
    }
    for (const path of [profile.home, profile.submissionDirectory]) {
      if (
        !isAbsolute(path) ||
        hasControlCharacter(path) ||
        resolve(path) !== path ||
        realpathSync(path) !== path
      ) {
        throw new Error("Slurm submitter directories must be canonical absolute paths");
      }
      const stat = statSync(path);
      if (!stat.isDirectory() || stat.uid !== profile.uid || (stat.mode & 0o022) !== 0) {
        throw new Error("Slurm submitter directories must belong to the configured UID");
      }
    }
    const suffix = relative(profile.home, profile.submissionDirectory);
    if (!suffix || suffix.startsWith("../") || suffix === ".." || isAbsolute(suffix)) {
      throw new Error("Slurm submission directory must be strictly inside the scientific home");
    }
    if ((statSync(profile.submissionDirectory).mode & 0o077) !== 0) {
      throw new Error("Slurm submission directory must be private to the scientific UID");
    }
  }

  private assertBinding(value: SlurmSubmissionBinding): SlurmSubmissionBinding {
    const binding = assertSlurmSubmissionBinding(value);
    const profile = this.profile;
    const resources = binding.resources;
    if (
      binding.uid !== profile.uid ||
      binding.cluster !== profile.cluster ||
      binding.siteProfileDigest !== profile.siteProfileDigest ||
      resources.partition !== profile.partition ||
      resources.node !== profile.node ||
      resources.account !== profile.account ||
      resources.cpus > profile.cpuLimit ||
      resources.memoryMiB > profile.memoryMiBLimit ||
      resources.walltimeSeconds > profile.walltimeLimitSeconds ||
      (resources.gpuCount !== undefined &&
        (profile.gpuType === undefined || profile.gpuLimit !== resources.gpuCount))
    ) {
      throw new Error("Slurm submission differs from the provisioned identity or site limits");
    }
    return binding;
  }

  private async verifyController(): Promise<void> {
    const result = await this.executor.run("/usr/bin/scontrol", ["show", "config"], this.options);
    if (!complete(result)) throw new Error("Slurm controller preflight unavailable");
    const field = (name: string) => {
      const values = [
        ...result.stdout.matchAll(new RegExp(`^${name}[ \\t]*=[ \\t]*(.*?)[ \\t]*$`, "gmu")),
      ];
      return values.length === 1 ? values[0][1] : undefined;
    };
    const version = field("SLURM_VERSION");
    const flags = field("AccountingStoreFlags")
      ?.toLowerCase()
      .split(",")
      .map((value) => value.trim());
    if (
      field("ClusterName") !== this.profile.cluster ||
      version !== this.profile.slurmVersion.split(/[-+]/u)[0] ||
      field("AccountingStorageType") !== "accounting_storage/slurmdbd" ||
      !flags?.includes("job_comment")
    ) {
      throw new Error("Slurm controller identity or durable comment contract differs from profile");
    }
  }

  async sendAdmitted(
    bindingValue: SlurmSubmissionBinding,
    script: Uint8Array,
    beforeEffect?: () => Promise<void>,
  ): Promise<SlurmSubmissionAcknowledgement> {
    const binding = this.assertBinding(bindingValue);
    this.assertLocalIdentity();
    if (script.byteLength === 0 || script.byteLength > 256 * 1024) {
      throw new Error("Slurm transport requires the exact bounded generated Bash script bytes");
    }
    // Snapshot BEFORE the first await; callers cannot mutate a Uint8Array while
    // the controller preflight is pending and change already verified bytes.
    const submittedScript = new Uint8Array(script);
    if (
      slurmScriptDigest(submittedScript) !== binding.scriptDigest ||
      !Buffer.from(submittedScript).subarray(0, 12).equals(Buffer.from("#!/bin/bash\n"))
    ) {
      throw new Error("Slurm transport requires the exact bounded generated Bash script bytes");
    }
    // The approved renderer's directive surface is closed. In particular, an
    // array or heterogeneous job must not turn one logical effect into many jobs.
    const allowedDirectives = new Set([
      "job-name",
      "no-requeue",
      "partition",
      "account",
      "cpus-per-task",
      "mem",
      "time",
      "nodes",
      "ntasks",
      "output",
      "error",
      "chdir",
    ]);
    const scriptText = Buffer.from(submittedScript).toString("utf8");
    if (
      scriptText.includes("\0") ||
      !Buffer.from(scriptText).equals(Buffer.from(submittedScript))
    ) {
      throw new Error("Slurm transport requires NUL-free UTF-8 script bytes");
    }
    for (const line of scriptText.split("\n")) {
      if (/^\s*#SBATCH/u.test(line)) {
        const match =
          /^#SBATCH --([a-z-]+)(?:=("(?:[^"\\]|\\[\\"])*"|[A-Za-z0-9_./%+:@=-]+))?$/u.exec(line);
        if (
          !match ||
          hasControlCharacter(line) ||
          !allowedDirectives.has(match[1]) ||
          (match[1] === "no-requeue" ? match[2] !== undefined : match[2] === undefined)
        ) {
          throw new Error("Unqualified directive in generated Slurm submission script");
        }
      }
    }
    await this.verifyController();
    // Optional INTERNAL service guard; never a request field. The installed
    // submitter rechecks root policy after slow controller IO, before sbatch.
    await beforeEffect?.();
    const now = this.now().getTime();
    if (
      !Number.isFinite(now) ||
      now < Date.parse(binding.notBefore) ||
      now >= Date.parse(binding.expiresAt)
    ) {
      throw new Error("Slurm submission authority is outside its bounded dispatch window");
    }
    const resources = binding.resources;
    // Command-line restrictions override script directives. No shell expansion,
    // login-shell environment, requeue, arrays, MPI, unbound GPU or alternate args.
    const args = [
      "--parsable",
      "--no-requeue",
      "--export=NIL",
      `--job-name=${slurmSubmissionJobName(binding)}`,
      `--comment=${slurmSubmissionMarker(binding)}`,
      `--partition=${resources.partition}`,
      `--account=${resources.account}`,
      `--nodelist=${resources.node}`,
      "--nodes=1",
      "--ntasks=1",
      `--cpus-per-task=${resources.cpus}`,
      `--mem=${resources.memoryMiB}M`,
      `--time=${Math.floor(resources.walltimeSeconds / 60)}:${String(resources.walltimeSeconds % 60).padStart(2, "0")}`,
      ...(resources.gpuCount === undefined
        ? []
        : [`--gres=gpu:${this.profile.gpuType}:${resources.gpuCount}`]),
    ];
    try {
      const result = await this.executor.run("/usr/local/bin/cluster-sbatch", args, {
        ...this.options,
        stdin: submittedScript,
        maxOutputBytes: 64 * 1024,
      });
      if (complete(result)) {
        const parsed = /^([1-9]\d{0,19})(?:;([a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}))?$/u.exec(
          result.stdout.trim(),
        );
        if (parsed && (!parsed[2] || parsed[2] === binding.cluster)) {
          return {
            status: "acknowledged",
            jobId: parsed[1],
            cluster: binding.cluster,
            resubmitAllowed: false,
          };
        }
      }
    } catch {
      // Even an exception may occur after the external effect. Never retry here.
    }
    return {
      status: "indeterminate",
      reason: "Submission may have crossed the scheduler boundary; reconcile its exact marker",
      resubmitAllowed: false,
    };
  }

  /** Read-only; zero matches, timeout and partial accounting never permit retry. */
  async discover(bindingValue: SlurmSubmissionBinding): Promise<SlurmSubmissionResolution> {
    const binding = this.assertBinding(bindingValue);
    this.assertLocalIdentity();
    const observations: SlurmSubmissionObservation[] = [];
    const sources = { accounting: false, queue: false };
    const end = this.now();
    if (end.getTime() < Date.parse(binding.notBefore)) {
      throw new Error("Cannot reconcile a Slurm submission from the future");
    }
    // Query up to NOW, not the dispatch expiry: jobs may remain queued beyond it.
    // Filter exact Submit timestamps after decoding. No state/default-midnight filter.
    const queries = [
      {
        source: "sacct" as const,
        cmd: "/usr/bin/sacct",
        args: [
          "--allocations",
          "--duplicates",
          "--noheader",
          "--parsable2",
          `--clusters=${binding.cluster}`,
          `--user=${binding.uid}`,
          `--name=${slurmSubmissionJobName(binding)}`,
          `--starttime=${utcSeconds(new Date(Date.parse(binding.notBefore) - 1_000))}`,
          `--endtime=${utcSeconds(new Date(end.getTime() + 1_000))}`,
          `--format=${SLURM_SUBMISSION_ACCOUNTING_FORMAT}`,
        ],
      },
      {
        source: "squeue" as const,
        cmd: "/usr/bin/squeue",
        args: [
          "--local",
          "--noheader",
          `--user=${binding.uid}`,
          `--name=${slurmSubmissionJobName(binding)}`,
          `--format=${SLURM_SUBMISSION_QUEUE_FORMAT}`,
        ],
      },
    ];
    // At most three bounded calls per observation. Polling/backoff is the Head's
    // responsibility; this transport does not create a scheduler polling loop.
    try {
      await this.verifyController();
    } catch {
      return resolveSlurmSubmission(binding, observations, sources);
    }
    for (const query of queries) {
      try {
        const result = await this.executor.run(query.cmd, query.args, this.options);
        if (!complete(result)) continue;
        const parsed = parseSlurmSubmissionObservations(
          result.stdout,
          query.source,
          binding.cluster,
        );
        observations.push(...parsed);
        sources[query.source === "sacct" ? "accounting" : "queue"] = true;
      } catch {
        // Preserve all usable evidence, but do not turn a malformed source into
        // an empty successful query. An incomplete observation cannot be adopted.
      }
    }
    return resolveSlurmSubmission(binding, observations, sources);
  }
}
