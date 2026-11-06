import { createInterface } from "node:readline/promises";
import type { ExperienceLesson, MemoryActor } from "@eigengrid/experience-memory";

/** Local human ceremony, not a remote identity provider. Callers still need store revision checks. */
export async function confirmExperienceReview(
  action: string,
  lesson: ExperienceLesson,
  expected: string,
  evidence: unknown,
): Promise<MemoryActor> {
  if (lesson.current.digest !== expected) throw new Error("Stale experience revision");
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new Error(
      "Memory review requires an interactive operator terminal; model tools cannot review or promote lessons",
    );
  const preview = JSON.stringify(
    { action, candidate: lesson.candidate, revision: lesson.current, evidence },
    null,
    2,
  );
  process.stderr.write(
    preview +
      "\nReview concerns this exact revision and retained observations, not protocol approval.\n",
  );
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await terminal.question(`Type the full revision digest to ${action}: `);
    if (answer.trim() !== expected) throw new Error("Memory review cancelled");
  } finally {
    terminal.close();
  }
  return {
    id: lesson.candidate.boundary.ownerId,
    kind: "human",
    role: lesson.candidate.domain === "scientific" ? "scientific_reviewer" : "operational_reviewer",
  };
}
