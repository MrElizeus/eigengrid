import { randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  AGENT_GENESIS,
  AGENT_JOURNAL_VERSION,
  agentDigest,
  canonicalAgentJson,
  type AgentCursor,
  type AgentEvent,
  type AgentRecord,
} from "./contracts";

export class AgentIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentIntegrityError";
  }
}
export class AgentConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConcurrencyError";
  }
}
export interface AgentJournal {
  load(sessionId: string): readonly AgentRecord[];
  append(sessionId: string, expected: AgentCursor, event: AgentEvent): AgentRecord;
}
export const ZERO_AGENT_CURSOR: AgentCursor = { sequence: 0, digest: AGENT_GENESIS };
function assertSessionId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(id) || id === "." || id === "..")
    throw new Error("Invalid agent session identifier");
}
export function verifyAgentRecords(
  sessionId: string,
  records: readonly AgentRecord[],
): AgentCursor {
  let cursor = ZERO_AGENT_CURSOR;
  if (records.length > 100_000) throw new AgentIntegrityError("Agent journal record limit");
  for (const rec of records) {
    if (
      rec.version !== AGENT_JOURNAL_VERSION ||
      rec.sessionId !== sessionId ||
      rec.sequence !== cursor.sequence + 1 ||
      rec.previousDigest !== cursor.digest
    )
      throw new AgentIntegrityError("Agent journal chain or sequence mismatch");
    const unsigned = {
      version: rec.version,
      sessionId: rec.sessionId,
      sequence: rec.sequence,
      previousDigest: rec.previousDigest,
      event: rec.event,
    };
    if (agentDigest(unsigned) !== rec.digest)
      throw new AgentIntegrityError("Agent journal digest mismatch");
    cursor = { sequence: rec.sequence, digest: rec.digest };
  }
  return cursor;
}
export function recordAgentEvent(
  sessionId: string,
  cursor: AgentCursor,
  event: AgentEvent,
): AgentRecord {
  assertSessionId(sessionId);
  const data = JSON.parse(canonicalAgentJson(event)) as AgentEvent;
  const unsigned = {
    version: AGENT_JOURNAL_VERSION,
    sessionId,
    sequence: cursor.sequence + 1,
    previousDigest: cursor.digest,
    event: data,
  };
  return { ...unsigned, digest: agentDigest(unsigned) };
}
export class InMemoryAgentJournal implements AgentJournal {
  private readonly records = new Map<string, AgentRecord[]>();
  load(sessionId: string): readonly AgentRecord[] {
    assertSessionId(sessionId);
    const r = this.records.get(sessionId) ?? [];
    verifyAgentRecords(sessionId, r);
    return r.map((x) => structuredClone(x));
  }
  append(sessionId: string, expected: AgentCursor, event: AgentEvent): AgentRecord {
    const records = this.load(sessionId);
    const cursor = verifyAgentRecords(sessionId, records);
    if (cursor.digest !== expected.digest || cursor.sequence !== expected.sequence)
      throw new AgentConcurrencyError("Stale agent journal cursor");
    const next = recordAgentEvent(sessionId, cursor, event);
    this.records.set(sessionId, [...records, next]);
    return structuredClone(next);
  }
}
/** Bounded JSONL journal. Exclusive per-session file lock serializes CAS across processes.
 * A crashed writer may leave .lock: it is never automatically stolen (fail-closed);
 * an operator must inspect process and journal before manually clearing it.
 */
export class JsonlAgentJournal implements AgentJournal {
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStat = lstatSync(directory);
    if (
      !directoryStat.isDirectory() ||
      (directoryStat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && directoryStat.uid !== process.getuid())
    ) {
      throw new AgentIntegrityError("Agent journal directory must be private and owned by Head");
    }
  }
  private path(id: string): string {
    assertSessionId(id);
    return join(this.directory, `${id}.jsonl`);
  }
  load(id: string): readonly AgentRecord[] {
    const path = this.path(id);
    if (!existsSync(path)) return [];
    const st = lstatSync(path);
    if (
      !st.isFile() ||
      st.size > 32 * 1024 * 1024 ||
      (st.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && st.uid !== process.getuid())
    )
      throw new AgentIntegrityError("Unsafe agent journal file");
    const bytes = readFileSync(path);
    if (bytes.length && bytes.at(-1) !== 10)
      throw new AgentIntegrityError("Incomplete trailing journal event");
    let records: AgentRecord[];
    try {
      records = bytes.length
        ? new TextDecoder("utf-8", { fatal: true })
            .decode(bytes)
            .trimEnd()
            .split("\n")
            .map((l) => JSON.parse(l) as AgentRecord)
        : [];
    } catch {
      throw new AgentIntegrityError("Invalid journal encoding or JSON");
    }
    verifyAgentRecords(id, records);
    return records;
  }
  append(id: string, expected: AgentCursor, event: AgentEvent): AgentRecord {
    const path = this.path(id);
    const lock = path + ".lock";
    let lockFd: number;
    try {
      lockFd = openSync(
        lock,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      throw new AgentConcurrencyError(
        "Agent journal lock occupied; operator reconciliation required",
      );
    }
    try {
      writeSync(lockFd, `${process.pid} ${randomUUID()}\n`);
      fsyncSync(lockFd);
      const current = this.load(id);
      const cursor = verifyAgentRecords(id, current);
      if (cursor.sequence !== expected.sequence || cursor.digest !== expected.digest)
        throw new AgentConcurrencyError("Stale agent journal cursor");
      const record = recordAgentEvent(id, cursor, event);
      const fd = openSync(
        path,
        constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeSync(fd, canonicalAgentJson(record) + "\n");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const dirFd = openSync(dirname(path), constants.O_RDONLY);
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
      return record;
    } finally {
      closeSync(lockFd);
      unlinkSync(lock);
    }
  }
}
