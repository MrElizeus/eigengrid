import { z } from "zod";
import type { ToolRegistry } from "@eigengrid/tool-registry";
import {
  ExperienceEvidenceSchema,
  LessonCandidateSchema,
  LessonEventSchema,
  memoryDigest,
  applicability,
  type ExperienceMemory,
  type RetrievalContext,
} from "@eigengrid/experience-memory";

const lessonSchema = z.object({
  candidate: LessonCandidateSchema,
  current: LessonEventSchema,
});
const proposalSchema = LessonCandidateSchema.innerType().omit({
  schemaVersion: true,
  id: true,
  boundary: true,
  scope: true,
  author: true,
  createdAt: true,
  digest: true,
});
const model = { id: "operator-model", kind: "model", role: "author" } as const;
const verifier = { id: "experience-tools", kind: "service", role: "observer" } as const;
const inspectSchema = z
  .object({
    kind: z.enum(["lesson", "evidence"]),
    id: z.string().min(1).max(160),
    offset: z.number().int().min(0).max(63).default(0),
    limit: z.number().int().min(1).max(5).default(3),
  })
  .strict();
const searchSchema = z
  .object({
    query: z.string().max(1000),
    includeCandidates: z.boolean().default(false),
    limit: z.number().int().min(1).max(10).default(3),
  })
  .strict();
const contestSchema = z
  .object({
    sourceId: z.string().min(1).max(160),
    sourceExpected: z.string().regex(/^[a-f0-9]{64}$/u),
    targetId: z.string().min(1).max(160),
    targetExpected: z.string().regex(/^[a-f0-9]{64}$/u),
    reason: z.string().min(1).max(4000),
  })
  .strict();

/** The host binds both scope and identity. There is deliberately no model review/promotion tool. */
export function registerExperienceTools(
  registry: ToolRegistry,
  memory: ExperienceMemory,
  context: RetrievalContext,
): void {
  registry.register({
    name: "inspect-experience",
    description:
      "Read an exact local lesson or retained evidence ID, including old observations. Lesson evidence is paginated: follow nextOffset until absent. Excluded lessons and tool reports remain untrusted observations, not current facts or approval.",
    inputSchema: inspectSchema,
    outputSchema: z.object({
      authority: z.literal("context_only"),
      lesson: lessonSchema.optional(),
      excludedBy: z.array(z.string()),
      evidence: z.array(ExperienceEvidenceSchema),
      nextOffset: z.number().int().optional(),
    }),
    async execute(_ctx, raw) {
      const input = inspectSchema.parse(raw);
      if (input.kind === "evidence")
        return {
          ok: true,
          data: {
            authority: "context_only" as const,
            excludedBy: [],
            evidence: [memory.evidence(input.id)],
          },
        };
      const lesson = memory.get(input.id),
        refs = lesson.candidate.evidence;
      if (input.offset >= refs.length) throw new Error("Invalid lesson evidence offset");
      const evidence = refs.slice(input.offset, input.offset + input.limit).map((ref) => {
        const value = memory.evidence(ref.id);
        if (value.digest !== ref.digest) throw new Error("Lesson evidence digest mismatch");
        return value;
      });
      const next = input.offset + evidence.length;
      return {
        ok: true,
        data: {
          authority: "context_only" as const,
          lesson,
          evidence,
          excludedBy: applicability(lesson, context, Date.now()),
          nextOffset: next < refs.length ? next : undefined,
        },
      };
    },
  });
  registry.register({
    name: "search-experiences",
    description:
      "Inspect local experiences and recent tool evidence. Candidates, disputed and expired lessons are inspection material only. Similarity is not authority. Use exact evidence IDs and digests when proposing a lesson. No network search.",
    inputSchema: searchSchema,
    outputSchema: z.object({
      authority: z.literal("context_only"),
      lessons: z.array(z.object({ lesson: lessonSchema, excludedBy: z.array(z.string()) })),
      recentObservations: z.array(ExperienceEvidenceSchema),
    }),
    async execute(_ctx, raw) {
      const input = searchSchema.parse(raw);
      const hits = memory.search(input.query, context, {
        limit: input.limit,
        includeIneligible: input.includeCandidates,
      });
      return {
        ok: true,
        data: {
          authority: "context_only" as const,
          lessons: hits.map(({ lesson, excludedBy }) => ({
            lesson: { candidate: lesson.candidate, current: lesson.current },
            excludedBy,
          })),
          // This is explicitly a recent observation window, not complete semantic retrieval.
          recentObservations: memory.recentEvidence(input.limit),
        },
      };
    },
  });
  registry.register({
    name: "propose-lesson",
    description:
      "Propose an unreviewed lesson supported by exact retained tool evidence. Specify when it applies and expires, distinguish hypotheses from results, and account for counterexamples. Host verifies snapshot integrity only; a human must review the claim.",
    inputSchema: proposalSchema,
    outputSchema: lessonSchema,
    async execute(_ctx, raw) {
      const input = proposalSchema.parse(raw);
      const lesson = memory.propose(
        { ...input, id: "proposal:" + memoryDigest(input), scope: { kind: "project" } },
        model,
      );
      const checked =
        lesson.current.state === "candidate"
          ? memory.verify(lesson.candidate.id, lesson.current.digest, verifier)
          : lesson;
      return { ok: true, data: { candidate: checked.candidate, current: checked.current } };
    },
  });
  registry.register({
    name: "contest-lesson",
    description:
      "Record a contradiction between two evidenced lessons in this scope, using their exact current revision digests. Both are excluded from automatic context until human resolution. This cannot refute, replace, review or promote a lesson.",
    inputSchema: contestSchema,
    outputSchema: z.object({ source: lessonSchema, target: lessonSchema }),
    async execute(_ctx, raw) {
      const input = contestSchema.parse(raw);
      const { source, target } = memory.relate({ ...input, kind: "contradicts" }, model);
      return { ok: true, data: { source, target } };
    },
  });
}
