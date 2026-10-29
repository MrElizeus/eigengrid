import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { digestBytes, digestCanonical, DigestSchema } from "@eigengrid/scientific-schema";

/** Retrieved research is evidence data, never executable policy. */
export const ResearchEvidenceSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.research-evidence/v1"),
    evidenceId: z.string().min(1).max(256),
    source: z
      .object({
        title: z.string().min(1).max(512),
        url: z.string().url().optional(),
        doi: z
          .string()
          .regex(/^10\.\d{4,9}\/\S+$/u)
          .optional(),
        publicationVersion: z.string().min(1).max(256).optional(),
        accessedAt: z.string().datetime({ offset: true }),
      })
      .strict()
      .refine(
        (value) => value.url !== undefined || value.doi !== undefined,
        "source requires URL or DOI",
      ),
    claim: z.string().min(1).max(4_000),
    contentDigest: DigestSchema,
    evidenceText: z.string().max(50_000),
    trustClass: z.literal("untrusted_retrieved_text"),
    confidence: z.enum(["low", "medium", "high"]),
    relationship: z
      .object({
        decisionIds: z.array(z.string().min(1)).max(128),
        notes: z.string().max(2_000).optional(),
      })
      .strict(),
    injectionRisk: z.enum(["none_detected", "suspected"]).default("none_detected"),
    recordedBy: z
      .object({
        id: z.string().min(1),
        kind: z.enum(["human", "service", "model"]),
        role: z.string().min(1),
      })
      .strict(),
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ResearchEvidence = z.infer<typeof ResearchEvidenceSchema>;

const INJECTION_MARKERS = [
  /ignore\s+(?:all\s+)?previous\s+instructions/iu,
  /system\s+message/iu,
  /reveal\s+(?:the\s+)?secret/iu,
  /run\s+(?:this|the)\s+command/iu,
  /developer\s+instructions/iu,
];

export function detectResearchPromptInjection(text: string): "none_detected" | "suspected" {
  return INJECTION_MARKERS.some((marker) => marker.test(text)) ? "suspected" : "none_detected";
}

export function createResearchEvidence(
  input: Omit<
    ResearchEvidence,
    "schemaVersion" | "contentDigest" | "injectionRisk" | "evidenceText"
  > & { content: string },
): ResearchEvidence {
  const { content, ...rest } = input;
  return ResearchEvidenceSchema.parse({
    ...rest,
    schemaVersion: "eigengrid.research-evidence/v1",
    evidenceText: content,
    contentDigest: digestBytes(content),
    injectionRisk: detectResearchPromptInjection(content),
  });
}

export function verifyResearchEvidence(value: unknown): ResearchEvidence {
  const parsed = ResearchEvidenceSchema.parse(value);
  if (digestBytes(parsed.evidenceText) !== parsed.contentDigest)
    throw new Error("research evidence content digest mismatch");
  return parsed;
}

export interface ResearchEvidenceStore {
  append(evidence: ResearchEvidence): Promise<void>;
  list(): Promise<ResearchEvidence[]>;
}

export class DurableResearchEvidenceStore implements ResearchEvidenceStore {
  constructor(private readonly path: string) {}
  async append(evidence: ResearchEvidence): Promise<void> {
    const parsed = verifyResearchEvidence(evidence);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const fd = openSync(this.path, "a", 0o600);
    try {
      appendFileSync(fd, `${JSON.stringify(parsed)}\n`, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  async list(): Promise<ResearchEvidence[]> {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => verifyResearchEvidence(JSON.parse(line)));
  }
}

export function researchEvidenceDigest(evidence: ResearchEvidence): string {
  return digestCanonical(verifyResearchEvidence(evidence));
}
