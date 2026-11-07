import type { Database } from "bun:sqlite";
import {
  assertIntegrity,
  canonical,
  ExperienceEvidenceSchema,
  GENESIS,
  LessonCandidateSchema,
  LessonEventSchema,
  MemoryActorSchema,
  MemoryBoundarySchema,
  memoryDigest,
  seal,
  type ExperienceEvidence,
  type ExperienceLesson,
  type LessonCandidate,
  type LessonEvent,
  type MemoryActor,
  type MemoryBoundary,
  type RetrievalContext,
} from "./contracts";
import { openExperienceDatabase } from "./database";
import { redactMemory } from "./privacy";
import { applicability, relevance, terms, normalizeSearchText } from "./retrieval";

type EvidenceInput = Omit<ExperienceEvidence, "schemaVersion" | "boundary" | "digest">;
export type LessonInput = Omit<
  LessonCandidate,
  "schemaVersion" | "boundary" | "digest" | "createdAt" | "author"
>;
const terminal = new Set(["refuted", "superseded"]);
function json(body: string): unknown {
  if (Buffer.byteLength(body) > 128 * 1024) throw new Error("Oversized experience record");
  return JSON.parse(body);
}
function reviewer(actor: MemoryActor, lesson: LessonCandidate, boundary: MemoryBoundary): void {
  MemoryActorSchema.parse(actor);
  if (
    actor.kind !== "human" ||
    actor.id !== boundary.ownerId ||
    !["operational_reviewer", "scientific_reviewer"].includes(actor.role) ||
    (lesson.domain === "scientific" && actor.role !== "scientific_reviewer")
  )
    throw new Error("A scope-owning human reviewer with the required role is necessary");
}

/** Append-only local evidence and lessons. Host code supplies identity; model tools never receive review methods. */
export class ExperienceMemory {
  private readonly db: Database;
  readonly boundary: Readonly<MemoryBoundary>;
  private readonly boundaryKey: string;
  constructor(
    path: string,
    boundary: MemoryBoundary,
    private readonly now = Date.now,
  ) {
    this.boundary = Object.freeze(MemoryBoundarySchema.parse(boundary));
    this.boundaryKey = memoryDigest(this.boundary);
    this.db = openExperienceDatabase(path);
  }
  close() {
    this.db.close();
  }
  private transaction<T>(work: () => T): T {
    return this.db.transaction(work).immediate();
  }
  private body(table: "evidence" | "lessons", id: string): string | undefined {
    return this.db
      .query<
        { body: string },
        [string, string]
      >(`SELECT body FROM experience_${table}_v1 WHERE boundary=? AND id=?`)
      .get(this.boundaryKey, id)?.body;
  }
  private checkBoundary(boundary: MemoryBoundary): void {
    if (canonical(boundary) !== canonical(this.boundary))
      throw new Error("Experience scope mismatch");
  }
  /** Trusted observation ingestion. Imported records are observations, never independently authenticated mission evidence. */
  observe(input: EvidenceInput): ExperienceEvidence {
    const value = seal(
      ExperienceEvidenceSchema.parse({
        ...input,
        observation: redactMemory(input.observation),
        schemaVersion: "eigengrid.experience-evidence/v1",
        boundary: this.boundary,
        digest: GENESIS,
      }),
    );
    return this.transaction(() => {
      const old = this.body("evidence", value.id);
      if (old) {
        const existing = this.evidence(value.id);
        if (existing.digest !== seal({ ...value, observedAt: existing.observedAt }).digest)
          throw new Error("Evidence identity conflict");
        return existing;
      }
      this.db
        .query("INSERT INTO experience_evidence_v1 VALUES (?, ?, ?)")
        .run(this.boundaryKey, value.id, canonical(value));
      return value;
    });
  }
  evidence(id: string): ExperienceEvidence {
    const body = this.body("evidence", id);
    if (!body) throw new Error("Evidence unavailable in this scope");
    const value = assertIntegrity(ExperienceEvidenceSchema.parse(json(body)));
    if (value.id !== id) throw new Error("Evidence identity mismatch");
    this.checkBoundary(value.boundary);
    return value;
  }
  recentEvidence(limit = 20): ExperienceEvidence[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Invalid evidence limit");
    return this.db
      .query<{ id: string }, [string, number]>(
        "SELECT id FROM experience_evidence_v1 WHERE boundary=? ORDER BY rowid DESC LIMIT ?",
      )
      .all(this.boundaryKey, limit)
      .map((row) => this.evidence(row.id));
  }
  propose(input: LessonInput, actor: MemoryActor): ExperienceLesson {
    const value = seal(
      LessonCandidateSchema.parse({
        ...input,
        schemaVersion: "eigengrid.experience-lesson/v1",
        boundary: this.boundary,
        digest: GENESIS,
        author: MemoryActorSchema.parse(actor),
        createdAt: new Date(this.now()).toISOString(),
        title: redactMemory(input.title, 240),
        claim: redactMemory(input.claim),
        rationale: redactMemory(input.rationale),
        conditions: input.conditions.map((c) => ({ ...c, value: redactMemory(c.value, 512) })),
        confidence: { ...input.confidence, basis: redactMemory(input.confidence.basis) },
      }),
    );
    return this.transaction(() => {
      if (this.body("lessons", value.id)) {
        const old = this.get(value.id);
        // Retry identity does not depend on the ingestion clock.
        if (
          memoryDigest({ ...value, createdAt: old.candidate.createdAt, digest: null }) !==
          memoryDigest({ ...old.candidate, digest: null })
        )
          throw new Error("Lesson identity conflict");
        return old;
      }
      this.checkEvidence(value);
      this.db
        .query("INSERT INTO experience_lessons_v1 VALUES (?, ?, ?)")
        .run(this.boundaryKey, value.id, canonical(value));
      this.append(
        value,
        undefined,
        "created",
        "candidate",
        actor,
        "Unverified candidate; no scientific or execution authority",
      );
      return this.get(value.id);
    });
  }
  get(id: string): ExperienceLesson {
    const body = this.body("lessons", id);
    if (!body) throw new Error("Lesson unavailable in this scope");
    const candidate = assertIntegrity(LessonCandidateSchema.parse(json(body)));
    this.checkBoundary(candidate.boundary);
    if (candidate.id !== id) throw new Error("Lesson identity mismatch");
    const rows = this.db
      .query<
        { body: string },
        [string, string]
      >("SELECT body FROM experience_events_v1 WHERE boundary=? AND id=? ORDER BY sequence LIMIT 129")
      .all(this.boundaryKey, id);
    if (!rows.length || rows.length > 128) throw new Error("Invalid experience history length");
    const history = rows.map((row) => assertIntegrity(LessonEventSchema.parse(json(row.body))));
    for (const [index, event] of history.entries())
      if (
        event.lessonId !== id ||
        event.candidateDigest !== candidate.digest ||
        event.sequence !== index + 1 ||
        event.previousDigest !== (history[index - 1]?.digest ?? GENESIS)
      )
        throw new Error("Experience history chain mismatch");
    return { candidate, current: history.at(-1)!, history };
  }
  private checkEvidence(candidate: LessonCandidate): ExperienceEvidence[] {
    return candidate.evidence.map((ref) => {
      const evidence = this.evidence(ref.id);
      if (
        evidence.digest !== ref.digest ||
        canonical(evidence.scope) !== canonical(candidate.scope)
      )
        throw new Error("Evidence digest or applicability scope mismatch");
      return evidence;
    });
  }
  private active(id: string, expected: string): ExperienceLesson {
    const lesson = this.get(id);
    if (lesson.current.digest !== expected) throw new Error("Stale experience revision");
    if (terminal.has(lesson.current.state)) throw new Error("Lesson is permanently retired");
    if (
      Date.parse(lesson.candidate.validFrom) > this.now() ||
      Date.parse(lesson.candidate.expiresAt) <= this.now()
    )
      throw new Error("Lesson is outside its validity interval");
    return lesson;
  }
  private append(
    candidate: LessonCandidate,
    previous: LessonEvent | undefined,
    action: LessonEvent["action"],
    state: LessonEvent["state"],
    actor: MemoryActor,
    reason: string,
    confidence = previous?.confidence ?? candidate.confidence,
    relatedLesson?: LessonEvent["relatedLesson"],
  ): void {
    if ((previous?.sequence ?? 0) >= 128)
      throw new Error("Experience history limit; create a new candidate");
    const event = seal(
      LessonEventSchema.parse({
        schemaVersion: "eigengrid.experience-event/v1",
        lessonId: candidate.id,
        digest: GENESIS,
        candidateDigest: candidate.digest,
        sequence: (previous?.sequence ?? 0) + 1,
        previousDigest: previous?.digest ?? GENESIS,
        action,
        state,
        actor,
        reason: redactMemory(reason),
        evidence: candidate.evidence,
        confidence,
        relatedLesson,
        at: new Date(this.now()).toISOString(),
      }),
    );
    this.db
      .query("INSERT INTO experience_events_v1 VALUES (?, ?, ?, ?)")
      .run(this.boundaryKey, candidate.id, event.sequence, canonical(event));
  }
  verify(id: string, expected: string, actor: MemoryActor): ExperienceLesson {
    if (MemoryActorSchema.parse(actor).kind === "model")
      throw new Error("Models cannot verify evidence");
    return this.transaction(() => {
      const value = this.active(id, expected);
      if (value.current.state !== "candidate") throw new Error("Verification requires a candidate");
      this.checkEvidence(value.candidate);
      this.append(
        value.candidate,
        value.current,
        "verify",
        "evidence_verified",
        actor,
        "Referenced retained observations match their digests and scope. This verifies provenance, not the claim's causal or scientific validity.",
      );
      return this.get(id);
    });
  }
  review(
    id: string,
    expected: string,
    actor: MemoryActor,
    reason: string,
    confidence: LessonCandidate["confidence"],
  ): ExperienceLesson {
    return this.transaction(() => {
      const value = this.active(id, expected);
      reviewer(actor, value.candidate, this.boundary);
      if (value.current.state !== "evidence_verified")
        throw new Error("Review requires verified evidence");
      this.checkEvidence(value.candidate);
      this.append(value.candidate, value.current, "review", "reviewed", actor, reason, {
        ...confidence,
        basis: redactMemory(confidence.basis),
      });
      return this.get(id);
    });
  }
  promote(id: string, expected: string, actor: MemoryActor, reason: string): ExperienceLesson {
    return this.transaction(() => {
      const value = this.active(id, expected);
      reviewer(actor, value.candidate, this.boundary);
      if (value.current.state !== "reviewed")
        throw new Error("Promotion requires exact reviewed evidence");
      this.checkEvidence(value.candidate);
      this.append(value.candidate, value.current, "promote", "promoted", actor, reason);
      return this.get(id);
    });
  }
  relate(
    input: {
      sourceId: string;
      sourceExpected: string;
      targetId: string;
      targetExpected: string;
      kind: "contradicts" | "refutes" | "supersedes";
      reason: string;
    },
    actor: MemoryActor,
  ): { source: ExperienceLesson; target: ExperienceLesson } {
    MemoryActorSchema.parse(actor);
    return this.transaction(() => {
      if (input.sourceId === input.targetId) throw new Error("A lesson cannot relate to itself");
      const source = this.active(input.sourceId, input.sourceExpected);
      const target = this.active(input.targetId, input.targetExpected);
      if (
        canonical(source.candidate.scope) !== canonical(target.candidate.scope) ||
        source.candidate.domain !== target.candidate.domain
      )
        throw new Error("Relation scope or domain mismatch");
      this.checkEvidence(source.candidate);
      this.checkEvidence(target.candidate);
      if (input.kind !== "contradicts") {
        reviewer(actor, source.candidate, this.boundary);
        if (!["reviewed", "promoted"].includes(source.current.state))
          throw new Error("Refutation and replacement require a reviewed source lesson");
      }
      this.append(
        source.candidate,
        source.current,
        input.kind,
        input.kind === "contradicts" ? "contested" : source.current.state,
        actor,
        input.reason,
        source.current.confidence,
        { id: target.candidate.id, digest: target.candidate.digest },
      );
      this.append(
        target.candidate,
        target.current,
        input.kind,
        input.kind === "contradicts"
          ? "contested"
          : input.kind === "refutes"
            ? "refuted"
            : "superseded",
        actor,
        input.reason,
        { level: "unknown", basis: "Conflicting or replacing evidence requires fresh review" },
        { id: source.candidate.id, digest: source.candidate.digest },
      );
      return { source: this.get(input.sourceId), target: this.get(input.targetId) };
    });
  }
  resolve(id: string, expected: string, actor: MemoryActor, reason: string): ExperienceLesson {
    return this.transaction(() => {
      const value = this.active(id, expected);
      reviewer(actor, value.candidate, this.boundary);
      if (value.current.state !== "contested")
        throw new Error("Resolution requires a contested lesson");
      this.append(value.candidate, value.current, "resolve", "candidate", actor, reason, {
        level: "unknown",
        basis: "Resolved dispute; evidence and claim require fresh review",
      });
      return this.get(id);
    });
  }
  /** Semantic providers may contribute IDs only. Their scores never establish trust or broaden scope. */
  search(
    query: string,
    context: RetrievalContext = {},
    options: {
      limit?: number;
      includeIneligible?: boolean;
      semanticIds?: readonly string[];
    } = {},
  ): Array<{ lesson: ExperienceLesson; score: number; excludedBy: string[] }> {
    const limit = options.limit ?? 5;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || query.length > 4000)
      throw new Error("Invalid memory search bounds");
    const words = terms(query);
    const semantic = [...new Set(options.semanticIds ?? [])].slice(0, 100);
    // SQLite LIKE does not fold accents. Normalize both sides before the candidate
    // limit, streaming only this boundary without rewriting append-only records.
    const rows: Array<{ id: string }> = [];
    const candidates = this.db
      .query<
        { id: string; body: string },
        [string]
      >("SELECT id,body FROM experience_lessons_v1 WHERE boundary=? ORDER BY rowid DESC")
      .iterate(this.boundaryKey);
    for (const row of candidates) {
      const body = normalizeSearchText(row.body);
      if (
        (!words.length && !semantic.length) ||
        words.some((word) => body.includes(word)) ||
        semantic.includes(row.id)
      ) {
        rows.push({ id: row.id });
        if (rows.length === 500) break;
      }
    }
    const ranked = rows
      .map((row) => this.get(row.id))
      .map((lesson) => ({ lesson, lexical: relevance(lesson, query) }))
      .filter(
        ({ lesson, lexical }) =>
          !words.length || lexical > 0 || semantic.includes(lesson.candidate.id),
      )
      .sort((a, b) => b.lexical - a.lexical);
    return ranked
      .map(({ lesson, lexical }, index) => {
        this.checkEvidence(lesson.candidate);
        const semanticRank = semantic.indexOf(lesson.candidate.id);
        return {
          lesson,
          score:
            (lexical > 0 ? 1 / (60 + index + 1) : 0) +
            (semanticRank >= 0 ? 1 / (60 + semanticRank + 1) : 0),
          excludedBy: applicability(lesson, context, this.now()),
        };
      })
      .filter((hit) => options.includeIneligible || !hit.excludedBy.length)
      .sort(
        (a, b) => b.score - a.score || a.lesson.candidate.id.localeCompare(b.lesson.candidate.id),
      )
      .slice(0, limit);
  }
}
