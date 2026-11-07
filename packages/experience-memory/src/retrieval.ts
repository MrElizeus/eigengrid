import type { ExperienceLesson, MemoryScope, RetrievalContext } from "./contracts";

export function scopeMatches(scope: MemoryScope, context: RetrievalContext): boolean {
  return (
    scope.kind === "project" ||
    (scope.kind === "session" && scope.sessionId === context.sessionId) ||
    (scope.kind === "installation" && scope.installationId === context.installationId)
  );
}
export function applicability(
  lesson: ExperienceLesson,
  context: RetrievalContext,
  now: number,
): string[] {
  const reasons: string[] = [];
  if (!["reviewed", "promoted"].includes(lesson.current.state)) reasons.push(lesson.current.state);
  if (Date.parse(lesson.candidate.validFrom) > now) reasons.push("not_yet_valid");
  if (Date.parse(lesson.candidate.expiresAt) <= now) reasons.push("expired");
  if (!scopeMatches(lesson.candidate.scope, context)) reasons.push("scope_mismatch");
  for (const condition of lesson.candidate.conditions)
    if (context.facts?.[condition.key] !== condition.value)
      reasons.push("condition:" + condition.key);
  return reasons;
}
export function normalizeSearchText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}
export function terms(value: string): string[] {
  return [
    ...new Set(
      normalizeSearchText(value)
        .split(/[^a-z0-9]+/u)
        .filter((x) => x.length > 2),
    ),
  ].slice(0, 32);
}
/** Lexical relevance only; state, scope and evidence eligibility are separate hard filters. */
export function relevance(lesson: ExperienceLesson, query: string): number {
  const title = new Set(terms(lesson.candidate.title));
  const body = new Set(terms(lesson.candidate.claim + " " + lesson.candidate.rationale));
  return terms(query).reduce(
    (score, word) => score + (title.has(word) ? 3 : 0) + (body.has(word) ? 1 : 0),
    0,
  );
}
