import { mkdir, readFile } from "node:fs/promises";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJson, digestCanonical } from "@eigengrid/scientific-schema";

export const ScientificPlanArtifactSchemaVersion = "eigengrid.scientific-plan-artifact.v1" as const;
const Sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const JsonObject = z.record(z.unknown());

const Objective = z
  .object({
    projectId: z.string().min(1),
    missionId: z.string().min(1),
    objectiveId: z.string().min(1),
    revision: z.number().int().positive(),
    digest: Sha256,
  })
  .strict();

/** Strict material envelope mirrored from docs/true-master-plan-v3/schemas/plan-artifact.schema.json. */
export const ScientificPlanArtifactSchema = z
  .object({
    schema: z.literal(ScientificPlanArtifactSchemaVersion),
    planId: z.string().min(1),
    revision: z.number().int().positive(),
    priorRevision: z.number().int().positive().nullable().optional(),
    objective: Objective,
    problem: z.string().min(1),
    nonGoals: z.array(z.string()),
    assumptions: z.array(JsonObject),
    contradictions: z.array(JsonObject),
    humanInputs: z.array(JsonObject),
    evidence: z.array(JsonObject),
    alternatives: z.array(JsonObject).min(1),
    selectedAlternative: z.string().min(1),
    scientificDecisions: z.array(JsonObject),
    workGraph: JsonObject,
    environments: z.array(JsonObject),
    resources: z.array(JsonObject),
    risks: z.array(JsonObject),
    approvalPolicy: JsonObject,
    validation: z.array(JsonObject).min(1),
    recovery: JsonObject,
    budgets: JsonObject,
    critiques: z.array(JsonObject),
    limitations: z.array(z.string()),
    materialDigest: Sha256,
  })
  .strict()
  .superRefine((value, ctx) => {
    const alternatives = value.alternatives
      .map((alternative) => alternative.id)
      .filter((id): id is string => typeof id === "string");
    if (alternatives.length > 0 && !alternatives.includes(value.selectedAlternative)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selectedAlternative"],
        message: "must reference an alternative id",
      });
    }
  });
export type ScientificPlanArtifact = z.infer<typeof ScientificPlanArtifactSchema>;

export function computePlanArtifactDigest(
  artifact: Omit<ScientificPlanArtifact, "materialDigest"> | ScientificPlanArtifact,
): `sha256:${string}` {
  const { materialDigest: _digest, ...material } = artifact as ScientificPlanArtifact;
  return `sha256:${digestCanonical(material)}`;
}

export function createPlanArtifact(
  input: Omit<ScientificPlanArtifact, "schema" | "materialDigest">,
): ScientificPlanArtifact {
  const material = { ...input, schema: ScientificPlanArtifactSchemaVersion } as Omit<
    ScientificPlanArtifact,
    "materialDigest"
  >;
  return ScientificPlanArtifactSchema.parse({
    ...material,
    materialDigest: computePlanArtifactDigest(material),
  });
}

export function verifyPlanArtifact(
  raw: unknown,
): { ok: true; artifact: ScientificPlanArtifact } | { ok: false; errors: string[] } {
  const parsed = ScientificPlanArtifactSchema.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  const expected = computePlanArtifactDigest(parsed.data);
  if (expected !== parsed.data.materialDigest) {
    return {
      ok: false,
      errors: [`materialDigest: expected ${expected}, got ${parsed.data.materialDigest}`],
    };
  }
  return { ok: true, artifact: parsed.data };
}

export interface PlanArtifactStore {
  put(artifact: ScientificPlanArtifact): Promise<ScientificPlanArtifact>;
  get(planId: string, revision?: number): Promise<ScientificPlanArtifact | undefined>;
  list(planId?: string): Promise<ScientificPlanArtifact[]>;
}

/** Append-only JSONL store; each revision is immutable and replayable after restart. */
export class DurablePlanArtifactStore implements PlanArtifactStore {
  private readonly records = new Map<string, ScientificPlanArtifact>();
  private loaded = false;
  private loading: Promise<void> | undefined;
  private loadFailure: Error | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath?: string) {}

  async open(): Promise<void> {
    if (this.loaded) return;
    if (this.loadFailure) throw this.loadFailure;
    if (this.loading) return this.loading;
    this.loading = this.loadFromDisk();
    try {
      await this.loading;
    } finally {
      this.loading = undefined;
    }
  }

  private async loadFromDisk(): Promise<void> {
    if (!this.filePath) {
      this.loaded = true;
      return;
    }
    try {
      const source = await readFile(this.filePath, "utf8");
      if (source.length > 0 && !source.endsWith("\n"))
        throw new Error("invalid plan artifact journal: unterminated final record");
      const loaded = new Map<string, ScientificPlanArtifact>();
      for (const line of source.split("\n")) {
        if (!line.trim()) continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch (error) {
          throw new Error(`invalid plan artifact JSON: ${String(error)}`);
        }
        const parsed = verifyPlanArtifact(value);
        if (!parsed.ok)
          throw new Error(`invalid plan artifact in journal: ${parsed.errors.join("; ")}`);
        const key = this.key(parsed.artifact.planId, parsed.artifact.revision);
        const existing = loaded.get(key);
        if (existing && existing.materialDigest !== parsed.artifact.materialDigest)
          throw new Error(`invalid plan artifact journal: conflicting revision ${key}`);
        loaded.set(key, parsed.artifact);
      }
      this.records.clear();
      for (const [key, value] of loaded) this.records.set(key, value);
      this.loaded = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.loaded = true;
        return;
      }
      this.records.clear();
      const failure = error instanceof Error ? error : new Error(String(error));
      this.loadFailure = failure;
      throw failure;
    }
  }

  async put(artifact: ScientificPlanArtifact): Promise<ScientificPlanArtifact> {
    return this.enqueue(async () => {
      await this.open();
      const verified = verifyPlanArtifact(artifact);
      if (!verified.ok) throw new Error(`invalid plan artifact: ${verified.errors.join("; ")}`);
      let planLock: PlanArtifactLock | undefined;
      const lockPath = this.filePath ? `${this.filePath}.lock` : undefined;
      if (this.filePath) {
        await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
        planLock = acquirePlanLock(lockPath!);
        // A separate process may have appended a revision after this store
        // loaded. Refresh under the lock before assigning the next revision.
        await this.loadFromDisk();
      }
      try {
        const key = this.key(artifact.planId, artifact.revision);
        const previous = this.records.get(key);
        if (previous) {
          if (previous.materialDigest !== artifact.materialDigest)
            throw new Error(`immutable plan revision conflict: ${key}`);
          return previous;
        }
        const revisions = [...this.records.values()]
          .filter((entry) => entry.planId === artifact.planId)
          .sort((a, b) => a.revision - b.revision);
        const expected = revisions.length === 0 ? 1 : revisions[revisions.length - 1]!.revision + 1;
        if (artifact.revision !== expected)
          throw new Error(
            `plan revisions must be append-only; expected ${expected}, got ${artifact.revision}`,
          );
        if (artifact.revision === 1 && artifact.priorRevision != null)
          throw new Error("revision 1 cannot have priorRevision");
        if (artifact.revision > 1 && artifact.priorRevision !== artifact.revision - 1)
          throw new Error("priorRevision must reference the immediately previous revision");
        if (this.filePath) {
          const descriptor = openSync(
            this.filePath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
            0o600,
          );
          try {
            appendFileSync(descriptor, `${canonicalJson(artifact)}\n`, "utf8");
            fsyncSync(descriptor);
            chmodSync(this.filePath, 0o600);
          } finally {
            closeSync(descriptor);
          }
          syncDirectory(dirname(this.filePath));
        }
        this.records.set(key, artifact);
        return artifact;
      } finally {
        if (planLock !== undefined) {
          releasePlanLock(lockPath!, planLock);
          planLock = undefined;
        }
      }
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(operation, operation);
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async get(planId: string, revision?: number): Promise<ScientificPlanArtifact | undefined> {
    await this.open();
    if (revision != null) return this.records.get(this.key(planId, revision));
    return [...this.records.values()]
      .filter((entry) => entry.planId === planId)
      .sort((a, b) => b.revision - a.revision)[0];
  }

  async list(planId?: string): Promise<ScientificPlanArtifact[]> {
    await this.open();
    return [...this.records.values()]
      .filter((entry) => !planId || entry.planId === planId)
      .sort((a, b) => entryOrder(a, b));
  }

  private key(planId: string, revision: number): string {
    return `${planId}@${revision}`;
  }
}

function entryOrder(a: ScientificPlanArtifact, b: ScientificPlanArtifact): number {
  return a.planId.localeCompare(b.planId) || a.revision - b.revision;
}

function syncDirectory(path: string): void {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0),
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

type PlanArtifactLock = { fd: number; token: string };

function acquirePlanLock(path: string): PlanArtifactLock {
  const started = Date.now();
  const token = `${process.pid}:${randomUUID()}`;
  for (;;) {
    try {
      const descriptor = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      fsyncSync(descriptor);
      const bytes = Buffer.from(`${token}\n`, "utf8");
      // The lock is advisory but fenced: stale owners must not remove a lock
      // acquired by a later process after a recovery reclaim.
      const written = writeSync(descriptor, bytes, 0, bytes.byteLength);
      if (written !== bytes.byteLength) throw new Error("plan lock write was partial");
      fsyncSync(descriptor);
      return { fd: descriptor, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      let stale = false;
      try {
        stale = Date.now() - lstatSync(path).mtimeMs > 60_000;
        if (stale && !planLockOwnerIsDead(path)) stale = false;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException)?.code !== "ENOENT") throw statError;
      }
      if (stale) {
        rmSync(path, { force: true });
        continue;
      }
      if (Date.now() - started >= 2_000)
        throw new Error(`Plan artifact store is contended at ${path}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

function planLockOwnerIsDead(path: string): boolean {
  let owner: string;
  try {
    owner = readFileSync(path, "utf8").trim();
  } catch {
    return false;
  }
  const pidText = owner.split(":", 1)[0] ?? "";
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function releasePlanLock(path: string, lock: PlanArtifactLock): void {
  try {
    if (readFileSync(path, "utf8").trim() === lock.token) rmSync(path, { force: true });
  } finally {
    closeSync(lock.fd);
  }
}

export const PlanApprovalDecisionSchema = z.enum([
  "approved",
  "rejected",
  "changes_requested",
  "pending",
]);
export const PlanApprovalBindingSchema = z
  .object({
    approvalId: z.string().min(1),
    missionId: z.string().min(1),
    planId: z.string().min(1),
    planRevision: z.number().int().positive(),
    planDigest: Sha256,
    policyDigest: Sha256,
    decisionSet: z.array(z.string().min(1)),
    decision: PlanApprovalDecisionSchema,
    authorizedActor: z.object({ id: z.string().min(1), role: z.string().min(1) }).strict(),
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type PlanApprovalBinding = z.infer<typeof PlanApprovalBindingSchema>;

export function createPlanApproval(
  input: Omit<PlanApprovalBinding, "approvalId"> & { approvalId?: string },
): PlanApprovalBinding {
  return PlanApprovalBindingSchema.parse({
    approvalId: input.approvalId ?? randomUUID(),
    ...input,
  });
}

export function validateExactPlanApproval(
  approval: PlanApprovalBinding,
  expected: Pick<
    PlanApprovalBinding,
    "missionId" | "planId" | "planRevision" | "planDigest" | "policyDigest"
  >,
  now = new Date(),
): { ok: true } | { ok: false; reason: string } {
  if (approval.decision !== "approved")
    return { ok: false, reason: `approval decision is ${approval.decision}` };
  const issuedAt = Date.parse(approval.issuedAt);
  if (!Number.isFinite(issuedAt) || issuedAt > now.getTime())
    return { ok: false, reason: "approval is not yet valid" };
  if (Date.parse(approval.expiresAt) <= issuedAt)
    return { ok: false, reason: "approval expiry precedes issuance" };
  for (const key of [
    "missionId",
    "planId",
    "planRevision",
    "planDigest",
    "policyDigest",
  ] as const) {
    if (approval[key] !== expected[key])
      return { ok: false, reason: `approval ${key} does not match exact subject` };
  }
  if (Date.parse(approval.expiresAt) <= now.getTime())
    return { ok: false, reason: "approval expired" };
  return { ok: true };
}

export const PLAN_READ_ONLY_CAPABILITIES = new Set([
  "inspect.mission",
  "inspect.jobs",
  "inspect.nodes",
  "inspect.slurm",
  "inspect.artifacts",
  "inspect.environment",
  "research.retrieve",
  "evidence.retrieve",
  "skills.retrieve",
  "diagnostics.run",
  "resource.estimate",
  "plan.create",
  "plan.critique",
  "plan.render",
]);

export const PLAN_MUTATING_CAPABILITIES = new Set([
  "mission.mutate",
  "objective.mutate",
  "job.submit",
  "job.cancel",
  "job.collect",
  "ssh.mutate",
  "slurm.mutate",
  "worker.mutate",
  "node.mutate",
  "environment.install",
  "workspace.write",
  "skill.promote",
  "memory.promote",
  "approval.respond",
  "policy.mutate",
  "release.create",
  "shell.raw",
]);

export type PlanCapabilityDecision = { capability: string; allowed: boolean; reason: string };

/** Host-enforced Plan Mode capability intersection; substrate prompts are not consulted. */
export class PlanCapabilityRegistry {
  decide(capability: string): PlanCapabilityDecision {
    if (PLAN_MUTATING_CAPABILITIES.has(capability))
      return { capability, allowed: false, reason: "hard /plan zero-effect policy" };
    if (PLAN_READ_ONLY_CAPABILITIES.has(capability))
      return { capability, allowed: true, reason: "explicit read-only /plan allow-list" };
    return { capability, allowed: false, reason: "unknown capabilities fail closed" };
  }

  assertAllowed(capability: string): void {
    const decision = this.decide(capability);
    if (!decision.allowed)
      throw new Error(`Plan Mode denied capability ${capability}: ${decision.reason}`);
  }
}
