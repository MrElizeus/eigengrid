import type { SlurmNode, SlurmPartition } from "./types";

export interface SacctParsedRow {
  jobId: string;
  state: string;
  exitCode: number;
  elapsed: string;
  maxRss: string;
  reqMem: string;
  nNodes: number;
  nCpus: number;
}

function parseIntOrZero(value: string): number {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function parseOptionalInt(value: string): number | undefined {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isHeaderLine(fields: string[]): boolean {
  return fields[0] === "JobID" || fields[1] === "State" || fields.join("|").includes("JobID|State");
}

function isMainJob(jobId: string): boolean {
  return /^\d+$/.test(jobId.trim());
}

function parseNodeList(nodeList: string): string[] {
  return nodeList
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** @deprecated Historical eight-column decoder only. Live Slurm uses parseSacctRecords. */
export function parseSacctOutput(stdout: string): SacctParsedRow[] {
  const rows: SacctParsedRow[] = [];

  for (const line of stdout.trim().split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const fields = trimmed.split("|");
    if (fields.length < 8 || isHeaderLine(fields)) {
      continue;
    }

    const [jobId, state, exitCodeRaw, elapsed, maxRss, reqMem, nNodesRaw, nCpusRaw] = fields;

    if (!isMainJob(jobId)) {
      continue;
    }

    const exitPair = /^(\d+):(\d+)$/u.exec(exitCodeRaw);
    if (!exitPair || Number(exitPair[1]) > 255 || Number(exitPair[2]) > 127) continue;
    const exitCodeStatus = exitPair[1];

    rows.push({
      jobId: jobId.trim(),
      state: state.trim(),
      exitCode: parseIntOrZero(exitCodeStatus),
      elapsed: elapsed.trim(),
      maxRss: maxRss.trim(),
      reqMem: reqMem.trim(),
      nNodes: parseIntOrZero(nNodesRaw),
      nCpus: parseIntOrZero(nCpusRaw),
    });
  }

  return rows;
}

export function parseSinfoNodes(stdout: string): SlurmNode[] {
  const nodes: SlurmNode[] = [];

  for (const line of stdout.trim().split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const fields = trimmed.split("|");
    if (fields.length < 6 || fields[0] === "NodeName") {
      continue;
    }

    const [name, state, cpus, memoryMb, freeMemoryMb] = fields;

    nodes.push({
      name: name.trim(),
      state: state.trim(),
      cpus: parseIntOrZero(cpus),
      memoryMb: parseOptionalInt(memoryMb),
      freeMemoryMb: parseOptionalInt(freeMemoryMb),
      partitions: [],
    });
  }

  return nodes;
}

export function parseSinfoPartitions(stdout: string): SlurmPartition[] {
  const partitions: SlurmPartition[] = [];

  for (const line of stdout.trim().split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const fields = trimmed.split("|");
    if (fields.length < 6 || fields[0] === "Partition") {
      continue;
    }

    const [name, state, defaultTime, maxTime, , nodeList] = fields;

    partitions.push({
      name: name.trim(),
      state: state.trim(),
      defaultTime: defaultTime.trim() || undefined,
      maxTime: maxTime.trim() || undefined,
      nodes: parseNodeList(nodeList.trim()),
    });
  }

  return partitions;
}
