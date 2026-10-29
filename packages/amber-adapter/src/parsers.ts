import type { ParsedDiagnostic } from "./leap-diagnostics";

export { parseLeapOutput } from "./leap-diagnostics";
export type { DiagnosticSeverity, LeapParseResult, ParsedDiagnostic } from "./leap-diagnostics";

function cleanLine(line: string): string {
  return line.trim().replace(/\s+/g, " ").slice(0, 2048);
}

/** Fake-engine-only telemetry; durable AMBER parsing is owned by md-analysis. */
export interface FakeMdTelemetrySample {
  step?: number;
  timePs?: number;
  temperatureK?: number;
  pressureBar?: number;
  totalEnergyKcalMol?: number;
  potentialEnergyKcalMol?: number;
  kineticEnergyKcalMol?: number;
  volumeA3?: number;
  densityGmL?: number;
}

export interface FakeMdOutputParseResult {
  source: "mdout" | "mdinfo";
  terminalReason: "completed" | "engine_fatal" | "nonzero_exit" | "partial_output" | "no_data";
  completed: boolean;
  samples: FakeMdTelemetrySample[];
  warnings: ParsedDiagnostic[];
  errors: ParsedDiagnostic[];
  lastStep: number | null;
  lastTimePs: number | null;
}

const observedKeys: Record<string, keyof FakeMdTelemetrySample> = {
  NSTEP: "step",
  "TIME(PS)": "timePs",
  "TEMP(K)": "temperatureK",
  PRESS: "pressureBar",
  ETOT: "totalEnergyKcalMol",
  EPTOT: "potentialEnergyKcalMol",
  EKTOT: "kineticEnergyKcalMol",
  VOLUME: "volumeA3",
  DENSITY: "densityGmL",
};

function numericValue(token: string): number | null {
  if (/\*+/.test(token)) return null;
  const parsed = Number(token.replace(/[dD]/, "E"));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseFakeMdOutput(
  text: string,
  options: { source: "mdout" | "mdinfo"; exitCode?: number | null },
): FakeMdOutputParseResult {
  const warnings: ParsedDiagnostic[] = [];
  const errors: ParsedDiagnostic[] = [];
  const samples: FakeMdTelemetrySample[] = [];
  let current: FakeMdTelemetrySample = {};
  let completionMarker = false;

  const flush = () => {
    if (Object.keys(current).length > 0) samples.push(current);
    current = {};
  };
  const lines = text.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const raw = lines[lineIndex]!;
    const line = cleanLine(raw);
    if (line.length === 0) continue;
    if (/Total wall time|Final Performance Info|^5\.\s+TIMINGS/i.test(line)) {
      completionMarker = true;
    }

    let diagnostic: ParsedDiagnostic | undefined;
    if (/SHAKE cannot be accomplished|Coordinate resetting.*SHAKE/i.test(line)) {
      diagnostic = {
        code: "shake_failure",
        severity: "error",
        line: lineIndex + 1,
        message: line,
      };
    } else if (/SANDER BOMB|PMEMD BOMB|FATAL|segmentation fault/i.test(line)) {
      diagnostic = {
        code: "engine_fatal",
        severity: "error",
        line: lineIndex + 1,
        message: line,
      };
    } else if (/vlimit exceeded/i.test(line)) {
      diagnostic = {
        code: "velocity_limit",
        severity: "warning",
        line: lineIndex + 1,
        message: line,
      };
    } else if (/NaN|Infinity/i.test(line)) {
      diagnostic = {
        code: "non_finite_value",
        severity: "error",
        line: lineIndex + 1,
        message: line,
      };
    } else if (/\bWARNING\b/i.test(line)) {
      diagnostic = {
        code: "engine_warning",
        severity: "warning",
        line: lineIndex + 1,
        message: line,
      };
    }
    if (diagnostic?.severity === "error") errors.push(diagnostic);
    else if (diagnostic !== undefined) warnings.push(diagnostic);

    const pairs = [...raw.matchAll(/([A-Za-z][A-Za-z0-9()/_-]*)\s*=\s*([^\s]+)/g)];
    for (const pair of pairs) {
      const key = pair[1]!.toUpperCase();
      const field = observedKeys[key];
      if (field === undefined) continue;
      if (field === "step" && Object.keys(current).length > 0 && current.step !== undefined)
        flush();
      const value = numericValue(pair[2]!);
      if (value === null) {
        const overflow: ParsedDiagnostic = {
          code: "numeric_overflow",
          severity: "error",
          line: lineIndex + 1,
          message: line,
        };
        errors.push(overflow);
      } else {
        current[field] = value;
      }
    }
  }
  flush();

  let terminalReason: FakeMdOutputParseResult["terminalReason"];
  if (options.exitCode !== undefined && options.exitCode !== null && options.exitCode !== 0) {
    terminalReason = "nonzero_exit";
  } else if (errors.length > 0) {
    terminalReason = "engine_fatal";
  } else if (completionMarker) {
    terminalReason = "completed";
  } else if (samples.length > 0 || text.trim().length > 0) {
    terminalReason = "partial_output";
  } else {
    terminalReason = "no_data";
  }
  const last = samples.at(-1);
  return {
    source: options.source,
    terminalReason,
    completed: terminalReason === "completed",
    samples,
    warnings,
    errors,
    lastStep: last?.step ?? null,
    lastTimePs: last?.timePs ?? null,
  };
}

export function parseFakeMdout(text: string, exitCode?: number | null): FakeMdOutputParseResult {
  return parseFakeMdOutput(text, { source: "mdout", exitCode });
}

export function parseFakeMdinfo(text: string): FakeMdOutputParseResult {
  return parseFakeMdOutput(text, { source: "mdinfo" });
}

export interface FakeCpptrajTableParseResult {
  columns: string[];
  rows: number[][];
  completed: boolean;
  errors: ParsedDiagnostic[];
}

/** Parses CPPTRAJ's native whitespace table; callers may serialize normalized CSV separately. */
export function parseFakeCpptrajTable(text: string): FakeCpptrajTableParseResult {
  const errors: ParsedDiagnostic[] = [];
  let columns: string[] = [];
  const rows: number[][] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) {
      if (columns.length === 0)
        columns = line
          .slice(1)
          .trim()
          .split(/[\s,]+/);
      continue;
    }
    const values = line.split(/[\s,]+/).map(numericValue);
    if (values.some((value) => value === null)) {
      errors.push({
        code: "invalid_cpptraj_number",
        severity: "error",
        line: index + 1,
        message: cleanLine(line),
      });
      continue;
    }
    if (columns.length === 0) {
      columns = values.map((_, column) => `column_${column + 1}`);
    }
    if (values.length !== columns.length) {
      errors.push({
        code: "cpptraj_column_mismatch",
        severity: "error",
        line: index + 1,
        message: cleanLine(line),
      });
      continue;
    }
    rows.push(values as number[]);
  }
  return { columns, rows, completed: rows.length > 0 && errors.length === 0, errors };
}
