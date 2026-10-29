export type DiagnosticSeverity = "warning" | "error";

export interface ParsedDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  line: number;
  message: string;
}

export interface LeapParseResult {
  terminalReason: "completed" | "fatal" | "nonzero_exit" | "partial_output" | "no_output";
  completed: boolean;
  errorCount: number | null;
  warnings: ParsedDiagnostic[];
  errors: ParsedDiagnostic[];
}

function cleanLine(line: string): string {
  return line.trim().replace(/\s+/g, " ").slice(0, 2048);
}

/** Adapter-owned LEaP diagnostics; durable MD telemetry belongs to md-analysis. */
export function parseLeapOutput(text: string, exitCode?: number | null): LeapParseResult {
  const warnings: ParsedDiagnostic[] = [];
  const errors: ParsedDiagnostic[] = [];
  let declaredErrors: number | null = null;
  let completionMarker = false;
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = cleanLine(lines[index]!);
    if (line.length === 0) continue;
    const errorCountMatch = line.match(/Errors\s*=\s*(\d+)/i);
    if (errorCountMatch) {
      declaredErrors = Number(errorCountMatch[1]);
      completionMarker = /Exiting\s+LEaP/i.test(line);
    }

    let errorCode: string | undefined;
    if (/FATAL/i.test(line)) errorCode = "leap_fatal";
    else if (/Could not find (?:bond|angle|torsion|dihedral|improper) parameter/i.test(line)) {
      errorCode = "missing_parameter";
    } else if (/does not have a type/i.test(line) || /No atom type/i.test(line)) {
      errorCode = "missing_atom_type";
    } else if (/Unknown residue|Could not open file|syntax error/i.test(line)) {
      errorCode = "invalid_input";
    } else if (errorCountMatch && Number(errorCountMatch[1]) > 0) {
      errorCode = "reported_errors";
    }
    if (errorCode !== undefined) {
      errors.push({ code: errorCode, severity: "error", line: index + 1, message: line });
      continue;
    }

    if (/\bWARNING\b/i.test(line)) {
      const code = /charge.*not integral|unperturbed charge.*non-integral/i.test(line)
        ? "non_integral_charge"
        : /close contact|bond.*very long/i.test(line)
          ? "geometry_warning"
          : "leap_warning";
      warnings.push({ code, severity: "warning", line: index + 1, message: line });
    }
  }

  if (exitCode !== undefined && exitCode !== null && exitCode !== 0) {
    return {
      terminalReason: "nonzero_exit",
      completed: false,
      errorCount: declaredErrors,
      warnings,
      errors,
    };
  }
  if (errors.length > 0 || (declaredErrors !== null && declaredErrors > 0)) {
    return {
      terminalReason: "fatal",
      completed: false,
      errorCount: declaredErrors,
      warnings,
      errors,
    };
  }
  if (completionMarker && declaredErrors === 0) {
    return {
      terminalReason: "completed",
      completed: true,
      errorCount: declaredErrors,
      warnings,
      errors,
    };
  }
  return {
    terminalReason: text.trim().length === 0 ? "no_output" : "partial_output",
    completed: false,
    errorCount: declaredErrors,
    warnings,
    errors,
  };
}
