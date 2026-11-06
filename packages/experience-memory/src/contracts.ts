import { createHash } from "node:crypto";
import { z } from "zod";

const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().trim().min(1).max(4000);
const at = z.string().datetime({ offset: true });
export const MemoryBoundarySchema = z.object({ projectId: id, ownerId: id }).strict();
export type MemoryBoundary = z.infer<typeof MemoryBoundarySchema>;
export const MemoryScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project") }).strict(),
  z.object({ kind: z.literal("session"), sessionId: id }).strict(),
  z.object({ kind: z.literal("installation"), installationId: id }).strict(),
]);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;
export const MemoryActorSchema = z
  .object({
    id,
    kind: z.enum(["human", "service", "model"]),
    role: z.enum(["observer", "author", "operational_reviewer", "scientific_reviewer"]),
  })
  .strict();
export type MemoryActor = z.infer<typeof MemoryActorSchema>;
export const EvidenceReferenceSchema = z.object({ id, digest }).strict();
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;
export const ExperienceOutcomeSchema = z.enum([
  "tool_succeeded",
  "tool_failed",
  "completed",
  "failed",
  "aborted",
  "budget_exhausted",
  "awaiting_approval",
  "uncertain_effect",
  "interrupted",
]);
export const ExperienceEvidenceSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.experience-evidence/v1"),
    id,
    boundary: MemoryBoundarySchema,
    scope: MemoryScopeSchema,
    origin: z
      .object({
        kind: z.enum(["tool_observation", "agent_session", "mission_evidence", "imported_record"]),
        reference: id,
        sessionId: id.optional(),
        missionId: id.optional(),
        operationId: id.optional(),
        toolName: id.optional(),
        sourceDigest: digest,
      })
      .strict(),
    outcome: ExperienceOutcomeSchema,
    // A tool observation records what the tool reported, not scientific truth.
    observation: text,
    observedAt: at,
    digest,
  })
  .strict();
export type ExperienceEvidence = z.infer<typeof ExperienceEvidenceSchema>;
export const LessonCandidateSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.experience-lesson/v1"),
    id,
    boundary: MemoryBoundarySchema,
    scope: MemoryScopeSchema,
    domain: z.enum(["operational", "scientific"]),
    title: z.string().trim().min(1).max(240),
    claim: text,
    rationale: text,
    // Exact, host-supplied facts must match before automatic retrieval.
    conditions: z.array(z.object({ key: id, value: z.string().min(1).max(512) }).strict()).max(24),
    evidence: z.array(EvidenceReferenceSchema).min(1).max(64),
    outcome: ExperienceOutcomeSchema,
    confidence: z
      .object({
        level: z.enum(["unknown", "low", "medium", "high"]),
        basis: text,
      })
      .strict(),
    validFrom: at,
    expiresAt: at,
    author: MemoryActorSchema,
    createdAt: at,
    digest,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Date.parse(value.expiresAt) <= Date.parse(value.validFrom))
      ctx.addIssue({ code: "custom", message: "Lesson validity interval is empty" });
    if (new Set(value.evidence.map((e) => e.id)).size !== value.evidence.length)
      ctx.addIssue({ code: "custom", message: "Duplicate evidence reference" });
    if (new Set(value.conditions.map((c) => c.key)).size !== value.conditions.length)
      ctx.addIssue({ code: "custom", message: "Duplicate applicability condition" });
  });
export type LessonCandidate = z.infer<typeof LessonCandidateSchema>;
export const LessonStateSchema = z.enum([
  "candidate",
  "evidence_verified",
  "reviewed",
  "promoted",
  "contested",
  "refuted",
  "superseded",
]);
export const LessonEventSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.experience-event/v1"),
    lessonId: id,
    candidateDigest: digest,
    sequence: z.number().int().positive(),
    previousDigest: digest,
    action: z.enum([
      "created",
      "verify",
      "review",
      "promote",
      "contradicts",
      "refutes",
      "supersedes",
      "resolve",
    ]),
    state: LessonStateSchema,
    actor: MemoryActorSchema,
    reason: text,
    evidence: z.array(EvidenceReferenceSchema).max(64),
    relatedLesson: EvidenceReferenceSchema.optional(),
    confidence: LessonCandidateSchema.innerType().shape.confidence,
    at,
    digest,
  })
  .strict();
export type LessonEvent = z.infer<typeof LessonEventSchema>;
export interface ExperienceLesson {
  candidate: LessonCandidate;
  current: LessonEvent;
  history: LessonEvent[];
}
export interface RetrievalContext {
  sessionId?: string;
  installationId?: string;
  facts?: Readonly<Record<string, string>>;
}
export const GENESIS = "0".repeat(64);
/** Deterministic bounded JSON, including tool snapshots. Reject cycles and host objects. */
export function canonical(value: unknown): string {
  const seen = new Set<object>();
  let nodes = 0,
    bytes = 0;
  const string = (text: string) => {
    bytes += Buffer.byteLength(text);
    if (bytes > 2 * 1024 * 1024) throw new Error("Experience JSON byte limit");
    return JSON.stringify(text);
  };
  const encode = (item: unknown, depth: number): string => {
    if (++nodes > 100000 || depth > 32) throw new Error("Experience JSON complexity limit");
    if (item === null) return "null";
    if (typeof item === "string") return string(item);
    if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)))
      return JSON.stringify(item);
    if (typeof item !== "object" || seen.has(item))
      throw new Error("Experience requires acyclic JSON");
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        if (item.length > 100000) throw new Error("Experience JSON array limit");
        const entries: string[] = [];
        for (let index = 0; index < item.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor || descriptor.get || descriptor.set)
            throw new Error("Experience JSON requires dense arrays without accessors");
          entries.push(encode(descriptor.value, depth + 1));
        }
        return "[" + entries.join(",") + "]";
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item)))
        throw new Error("Experience requires plain JSON objects");
      const entries = Object.entries(Object.getOwnPropertyDescriptors(item)).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      return (
        "{" +
        entries
          .flatMap(([key, descriptor]) => {
            if (descriptor.get || descriptor.set)
              throw new Error("Experience JSON cannot invoke accessors");
            return descriptor.value === undefined
              ? []
              : [string(key) + ":" + encode(descriptor.value, depth + 1)];
          })
          .join(",") +
        "}"
      );
    } finally {
      seen.delete(item);
    }
  };
  return encode(value, 0);
}
export function memoryDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function seal<T extends object>(value: T): T & { digest: string } {
  const { digest: _ignored, ...body } = value as T & { digest?: string };
  return { ...body, digest: memoryDigest(body) } as T & { digest: string };
}
export function assertIntegrity<T extends { digest: string }>(value: T): T {
  if (seal(value).digest !== value.digest) throw new Error("Experience memory integrity mismatch");
  return value;
}
