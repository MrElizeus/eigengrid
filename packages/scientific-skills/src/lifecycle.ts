import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { DigestSchema, digestCanonical } from "@eigengrid/scientific-schema";

export const SkillLifecycleStateSchema = z.enum([
  "draft",
  "evaluated",
  "reviewed",
  "promoted",
  "superseded",
  "deprecated",
]);
export type SkillLifecycleState = z.infer<typeof SkillLifecycleStateSchema>;

export const SkillLifecycleRecordSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.skill-lifecycle/v1"),
    eventId: z.string().min(1),
    skillId: z.string().min(3),
    version: z.string().min(1),
    contentDigest: DigestSchema,
    state: SkillLifecycleStateSchema,
    actor: z
      .object({
        id: z.string().min(1),
        kind: z.enum(["human", "service", "model"]),
        role: z.string().min(1),
      })
      .strict(),
    evaluationDigest: DigestSchema.optional(),
    evidenceIds: z.array(z.string().min(1)).max(256),
    replacementVersion: z.string().min(1).optional(),
    reason: z.string().min(1).max(2_000).optional(),
    at: z.string().datetime({ offset: true }),
  })
  .strict();
export type SkillLifecycleRecord = z.infer<typeof SkillLifecycleRecordSchema>;

const transitions: Record<SkillLifecycleState, readonly SkillLifecycleState[]> = {
  draft: ["evaluated", "deprecated"],
  evaluated: ["reviewed", "deprecated"],
  reviewed: ["promoted", "deprecated"],
  promoted: ["superseded", "deprecated"],
  superseded: [],
  deprecated: [],
};

function ensureTransition(from: SkillLifecycleState | undefined, to: SkillLifecycleState): void {
  if (from === undefined && to !== "draft")
    throw new Error(`skill lifecycle must start at draft, got ${to}`);
  if (from !== undefined && !transitions[from].includes(to))
    throw new Error(`illegal skill lifecycle transition ${from} -> ${to}`);
}

export interface SkillLifecycleJournal {
  append(record: SkillLifecycleRecord): Promise<void>;
  read(): Promise<SkillLifecycleRecord[]>;
}

export class DurableSkillLifecycleJournal implements SkillLifecycleJournal {
  constructor(private readonly path: string) {}

  async append(record: SkillLifecycleRecord): Promise<void> {
    const parsed = SkillLifecycleRecordSchema.parse(record);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const fd = openSync(this.path, "a", 0o600);
    try {
      appendFileSync(fd, `${JSON.stringify(parsed)}\n`, { encoding: "utf8" });
      fsyncSync(fd);
      chmodSync(this.path, 0o600);
    } finally {
      closeSync(fd);
    }
  }

  async read(): Promise<SkillLifecycleRecord[]> {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line, index) => {
        try {
          return SkillLifecycleRecordSchema.parse(JSON.parse(line));
        } catch (error) {
          throw new Error(
            `invalid skill lifecycle record ${this.path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
  }
}

export class MemorySkillLifecycleJournal implements SkillLifecycleJournal {
  readonly records: SkillLifecycleRecord[] = [];
  async append(record: SkillLifecycleRecord): Promise<void> {
    this.records.push(SkillLifecycleRecordSchema.parse(record));
  }
  async read(): Promise<SkillLifecycleRecord[]> {
    return [...this.records];
  }
}

export class SkillLifecycleRegistry {
  private readonly states = new Map<string, SkillLifecycleRecord>();

  constructor(private readonly journal: SkillLifecycleJournal) {}

  async load(): Promise<void> {
    this.states.clear();
    for (const record of await this.journal.read()) {
      const key = `${record.skillId}@${record.version}`;
      const current = this.states.get(key);
      ensureTransition(current?.state, record.state);
      if (
        current &&
        (current.contentDigest !== record.contentDigest ||
          current.skillId !== record.skillId ||
          current.version !== record.version)
      )
        throw new Error(`skill lifecycle identity drift for ${key}`);
      this.states.set(key, record);
    }
  }

  get(skillId: string, version: string): SkillLifecycleRecord | undefined {
    return this.states.get(`${skillId}@${version}`);
  }
  all(): readonly SkillLifecycleRecord[] {
    return [...this.states.values()].sort((a, b) =>
      `${a.skillId}@${a.version}`.localeCompare(`${b.skillId}@${b.version}`),
    );
  }

  async transition(input: {
    skillId: string;
    version: string;
    contentDigest: string;
    state: SkillLifecycleState;
    actor: SkillLifecycleRecord["actor"];
    evaluationDigest?: string;
    evidenceIds?: string[];
    replacementVersion?: string;
    reason?: string;
    at?: string;
  }): Promise<SkillLifecycleRecord> {
    const parsedDigest = DigestSchema.parse(input.contentDigest);
    const key = `${input.skillId}@${input.version}`;
    const current = this.states.get(key);
    ensureTransition(current?.state, input.state);
    if (input.state === "promoted" && (!input.evaluationDigest || !input.evidenceIds?.length))
      throw new Error("promotion requires evaluation digest and evidence");
    if (input.state === "promoted" && input.actor.kind === "model")
      throw new Error("model actors cannot promote scientific skills");
    if (input.state === "superseded" && !input.replacementVersion)
      throw new Error("superseded skill requires replacementVersion");
    if (input.state === "deprecated" && !input.reason)
      throw new Error("deprecated skill requires reason");
    if (current && current.contentDigest !== parsedDigest)
      throw new Error(`content digest changed for ${key}; create a new version`);
    const record = SkillLifecycleRecordSchema.parse({
      schemaVersion: "eigengrid.skill-lifecycle/v1",
      eventId: `${key}:${input.state}:${Date.now()}`,
      skillId: input.skillId,
      version: input.version,
      contentDigest: parsedDigest,
      state: input.state,
      actor: input.actor,
      ...(input.evaluationDigest
        ? { evaluationDigest: DigestSchema.parse(input.evaluationDigest) }
        : {}),
      evidenceIds: input.evidenceIds ?? [],
      ...(input.replacementVersion ? { replacementVersion: input.replacementVersion } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      at: input.at ?? new Date().toISOString(),
    });
    await this.journal.append(record);
    this.states.set(key, record);
    return record;
  }

  async submitDraft(input: Omit<Parameters<SkillLifecycleRegistry["transition"]>[0], "state">) {
    return this.transition({ ...input, state: "draft" });
  }
  async recordEvaluation(
    input: Omit<Parameters<SkillLifecycleRegistry["transition"]>[0], "state"> & {
      evaluationDigest: string;
    },
  ) {
    return this.transition({ ...input, state: "evaluated" });
  }
  async review(
    input: Omit<Parameters<SkillLifecycleRegistry["transition"]>[0], "state"> & {
      evaluationDigest: string;
      evidenceIds: string[];
    },
  ) {
    return this.transition({ ...input, state: "reviewed" });
  }
  async promote(
    input: Omit<Parameters<SkillLifecycleRegistry["transition"]>[0], "state"> & {
      evaluationDigest: string;
      evidenceIds: string[];
    },
  ) {
    return this.transition({ ...input, state: "promoted" });
  }
  async supersede(
    input: Omit<Parameters<SkillLifecycleRegistry["transition"]>[0], "state"> & {
      replacementVersion: string;
    },
  ) {
    return this.transition({ ...input, state: "superseded" });
  }
  async deprecate(
    input: Omit<Parameters<SkillLifecycleRegistry["transition"]>[0], "state"> & { reason: string },
  ) {
    return this.transition({ ...input, state: "deprecated" });
  }
}

export function skillLifecycleDigest(record: SkillLifecycleRecord): string {
  return digestCanonical({ ...record, eventId: undefined });
}
