import {
  DigestSchema,
  MdMetricSeriesSchema,
  MdMetricSeriesSchemaVersion,
  IdSchema,
  computeMdMetricSeriesDigest,
  digestBytes,
  digestCanonical,
  type MdMetricSeries,
} from "@eigengrid/scientific-schema";
import { z } from "zod";
import {
  AnalysisDiagnosticSchema,
  CpptrajColumnSchema,
  CpptrajMetricSeriesSchemaVersion,
  CpptrajOutputProvenanceSchema,
  CpptrajTableParseSchemaVersion,
  ExactArtifactDigestSchema,
  ParserIdentitySchema,
  analysisDiagnostic,
  type AnalysisDiagnostic,
} from "./contracts";
import { resolveCpptrajAnalysisOutput } from "./cpptraj";

export { CpptrajColumnSchema } from "./contracts";

export const CpptrajParseObservationSchema = z
  .object({
    source: ExactArtifactDigestSchema,
    executionCompletion: z.enum(["confirmed", "unconfirmed"]),
    operationReceiptRef: IdSchema.optional(),
    exitCode: z.number().int().nonnegative().nullable(),
    signal: z.string().min(1).nullable(),
    parser: ParserIdentitySchema,
  })
  .strict()
  .superRefine((observation, context) => {
    if (
      observation.executionCompletion === "confirmed" &&
      (observation.operationReceiptRef === undefined ||
        (observation.exitCode === null) === (observation.signal === null))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operationReceiptRef"],
        message:
          "Confirmed CPPTRAJ output requires an exact receipt and one terminal exit or signal observation",
      });
    }
  });
export type CpptrajParseObservation = z.infer<typeof CpptrajParseObservationSchema>;

export const CpptrajTableParseRequestSchema = z
  .object({
    schemaVersion: z.literal(CpptrajTableParseSchemaVersion),
    provenance: CpptrajOutputProvenanceSchema,
    source: ExactArtifactDigestSchema,
    format: z.enum(["whitespace", "csv"]),
    headerStyle: z.enum(["plain", "commented"]),
    columns: z.array(CpptrajColumnSchema).min(2).max(64),
    expectedRowCount: z.number().int().nonnegative().optional(),
    executionCompletion: z.enum(["confirmed", "unconfirmed"]),
    operationReceiptRef: IdSchema.optional(),
    exitCode: z.number().int().nonnegative().nullable(),
    signal: z.string().min(1).nullable(),
    parser: ParserIdentitySchema,
  })
  .strict()
  .superRefine((request, context) => {
    const names = request.columns.map((column) => column.sourceName);
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["columns"],
        message: "CPPTRAJ table columns must have unique source names",
      });
    }
    const axisCount = request.columns.filter((column) =>
      ["frame", "time_ps", "index"].includes(column.semantic),
    ).length;
    if (axisCount !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["columns"],
        message: "CPPTRAJ tables require exactly one explicit axis",
      });
    }
    if (!request.columns.some((column) => column.semantic === "value")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["columns"],
        message: "CPPTRAJ tables require at least one value column",
      });
    }
    if (
      request.executionCompletion === "confirmed" &&
      (request.operationReceiptRef === undefined ||
        (request.exitCode === null) === (request.signal === null))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operationReceiptRef"],
        message:
          "Confirmed CPPTRAJ output requires an exact receipt and one terminal exit or signal observation",
      });
    }
  });
export type CpptrajTableParseRequest = z.infer<typeof CpptrajTableParseRequestSchema>;

/** Materialize a parse request without exposing semantic or frame-mapping overrides. */
export function createCpptrajTableParseRequest(
  planValue: unknown,
  outputNameValue: unknown,
  observationValue: unknown,
): CpptrajTableParseRequest {
  const { analysis, provenance } = resolveCpptrajAnalysisOutput(planValue, outputNameValue);
  const observation = CpptrajParseObservationSchema.parse(observationValue);
  return CpptrajTableParseRequestSchema.parse({
    schemaVersion: CpptrajTableParseSchemaVersion,
    provenance,
    source: observation.source,
    format: analysis.outputContract.format,
    headerStyle: analysis.outputContract.headerStyle,
    columns: analysis.outputContract.columns,
    expectedRowCount: analysis.outputContract.expectedRowCount,
    executionCompletion: observation.executionCompletion,
    operationReceiptRef: observation.operationReceiptRef,
    exitCode: observation.exitCode,
    signal: observation.signal,
    parser: observation.parser,
  });
}

export const ParsedCpptrajRowSchema = z
  .object({
    sourceLine: z.number().int().positive(),
    values: z.record(z.string(), z.number().finite()),
  })
  .strict();
export type ParsedCpptrajRow = z.infer<typeof ParsedCpptrajRowSchema>;

export const ParsedCpptrajTableSchema = z
  .object({
    schemaVersion: z.literal(CpptrajTableParseSchemaVersion),
    provenance: CpptrajOutputProvenanceSchema,
    source: ExactArtifactDigestSchema,
    format: z.enum(["whitespace", "csv"]),
    parser: ParserIdentitySchema,
    operationReceiptRef: IdSchema.optional(),
    exitCode: z.number().int().nonnegative().nullable(),
    signal: z.string().min(1).nullable(),
    status: z.enum(["complete", "partial", "invalid", "no_data"]),
    columns: z.array(CpptrajColumnSchema).min(2),
    rows: z.array(ParsedCpptrajRowSchema),
    diagnostics: z.array(AnalysisDiagnosticSchema),
    tableDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
  .superRefine((table, context) => {
    if (
      table.status === "complete" &&
      (table.operationReceiptRef === undefined || table.exitCode !== 0 || table.signal !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "A complete CPPTRAJ table requires a successful exact operation receipt",
      });
    }
  });
export type ParsedCpptrajTable = z.infer<typeof ParsedCpptrajTableSchema>;

export function computeParsedCpptrajTableDigest(
  value: Omit<ParsedCpptrajTable, "tableDigest"> | ParsedCpptrajTable,
): string {
  const { tableDigest: _tableDigest, ...payload } = value as ParsedCpptrajTable;
  return digestCanonical(payload);
}

export function assertParsedCpptrajTable(value: unknown): ParsedCpptrajTable {
  const table = ParsedCpptrajTableSchema.parse(value);
  if (table.tableDigest !== computeParsedCpptrajTableDigest(table)) {
    throw new Error(`CPPTRAJ parsed-table digest mismatch for ${table.source.artifactId}`);
  }
  return table;
}

function tokenize(line: string, format: "whitespace" | "csv"): string[] | null {
  if (format === "whitespace") return line.trim().split(/\s+/u);
  // CPPTRAJ numeric tables do not require quoted CSV fields. Rejecting them is
  // safer than implementing a permissive CSV dialect implicitly.
  if (line.includes('"')) return null;
  return line.split(",").map((token) => token.trim());
}

function numericToken(token: string): number | null {
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eEdD][-+]?\d+)?$/u.test(token)) return null;
  const parsed = Number(token.replace(/[dD]/u, "E"));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parses an explicitly declared CPPTRAJ tabular dialect. No delimiter or
 * column auto-detection is performed.
 */
export function parseCpptrajTable(
  content: string,
  planValue: unknown,
  outputNameValue: unknown,
  observationValue: unknown,
): ParsedCpptrajTable {
  if (arguments.length !== 4) {
    throw new Error("CPPTRAJ parsing requires exactly plan, output name, and observation inputs");
  }
  const request = createCpptrajTableParseRequest(planValue, outputNameValue, observationValue);
  const diagnostics: AnalysisDiagnostic[] = [];
  const rows: ParsedCpptrajRow[] = [];
  if ((request.exitCode !== null && request.exitCode !== 0) || request.signal !== null) {
    diagnostics.push(
      analysisDiagnostic({
        code: "analysis_process_failed",
        severity: "error",
        message:
          request.signal === null
            ? `CPPTRAJ exited with non-zero status ${request.exitCode}`
            : `CPPTRAJ terminated after signal ${request.signal}`,
        evidenceRefs: [request.source.evidenceRef],
      }),
    );
  }
  if (digestBytes(content) !== request.source.contentDigest) {
    diagnostics.push(
      analysisDiagnostic({
        code: "source_digest_mismatch",
        severity: "fatal",
        message: "Injected table bytes do not match the exact source artifact digest",
        evidenceRefs: [request.source.evidenceRef],
      }),
    );
  }

  const lines = content.split(/\r?\n/u);
  let headerFound = false;
  let previousAxis: number | undefined;
  const axisColumn = request.columns.find((column) =>
    ["frame", "time_ps", "index"].includes(column.semantic),
  )!;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const raw = lines[lineIndex]!;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;

    if (!headerFound) {
      const isComment = trimmed.startsWith("#");
      if (
        (request.headerStyle === "commented" && !isComment) ||
        (request.headerStyle === "plain" && isComment)
      ) {
        diagnostics.push(
          analysisDiagnostic({
            code: "missing_expected_header",
            severity: "error",
            line: lineIndex + 1,
            message: `Expected a ${request.headerStyle} header before CPPTRAJ data`,
            evidenceRefs: [request.source.evidenceRef],
          }),
        );
        break;
      }
      const headerText = isComment ? trimmed.slice(1).trim() : trimmed;
      const header = tokenize(headerText, request.format);
      if (header === null) {
        diagnostics.push(
          analysisDiagnostic({
            code: "unsupported_quoted_csv",
            severity: "error",
            line: lineIndex + 1,
            message: "Quoted CSV is outside the supported CPPTRAJ numeric-table dialect",
            evidenceRefs: [request.source.evidenceRef],
          }),
        );
        break;
      }
      const expected = request.columns.map((column) => column.sourceName);
      if (
        header.length !== expected.length ||
        header.some((name, index) => name !== expected[index])
      ) {
        diagnostics.push(
          analysisDiagnostic({
            code: "column_contract_mismatch",
            severity: "error",
            line: lineIndex + 1,
            message: "Observed table header does not exactly match the declared column contract",
            evidenceRefs: [request.source.evidenceRef],
          }),
        );
        break;
      }
      headerFound = true;
      continue;
    }

    if (trimmed.startsWith("#")) continue;
    const tokens = tokenize(trimmed, request.format);
    if (tokens === null) {
      diagnostics.push(
        analysisDiagnostic({
          code: "unsupported_quoted_csv",
          severity: "error",
          line: lineIndex + 1,
          message: "Quoted CSV is outside the supported CPPTRAJ numeric-table dialect",
          evidenceRefs: [request.source.evidenceRef],
        }),
      );
      continue;
    }
    if (tokens.length !== request.columns.length) {
      diagnostics.push(
        analysisDiagnostic({
          code: "column_count_mismatch",
          severity: "error",
          line: lineIndex + 1,
          message: `Expected ${request.columns.length} values but observed ${tokens.length}`,
          evidenceRefs: [request.source.evidenceRef],
        }),
      );
      continue;
    }

    const values: Record<string, number> = {};
    let validRow = true;
    for (const [columnIndex, column] of request.columns.entries()) {
      const value = numericToken(tokens[columnIndex]!);
      if (value === null || (column.valueKind === "integer" && !Number.isSafeInteger(value))) {
        diagnostics.push(
          analysisDiagnostic({
            code: "invalid_numeric_value",
            severity: "error",
            line: lineIndex + 1,
            message: `Column ${column.sourceName} is not a finite ${column.valueKind}`,
            evidenceRefs: [request.source.evidenceRef],
          }),
        );
        validRow = false;
      } else {
        values[column.sourceName] = value;
      }
    }
    if (!validRow) continue;

    const axis = values[axisColumn.sourceName]!;
    if (previousAxis !== undefined && axis <= previousAxis) {
      diagnostics.push(
        analysisDiagnostic({
          code: "non_monotonic_axis",
          severity: "error",
          line: lineIndex + 1,
          message: "CPPTRAJ table axis must be strictly increasing",
          evidenceRefs: [request.source.evidenceRef],
        }),
      );
      continue;
    }
    previousAxis = axis;
    rows.push({ sourceLine: lineIndex + 1, values });
  }

  if (!headerFound && diagnostics.length === 0) {
    diagnostics.push(
      analysisDiagnostic({
        code: "missing_expected_header",
        severity: "error",
        message: "CPPTRAJ table contains no declared header",
        evidenceRefs: [request.source.evidenceRef],
      }),
    );
  }

  if (request.expectedRowCount !== undefined) {
    if (
      rows.length < request.expectedRowCount &&
      !diagnostics.some((item) => item.severity === "error" || item.severity === "fatal")
    ) {
      diagnostics.push(
        analysisDiagnostic({
          code: "partial_row_count",
          severity: "warning",
          message: `Expected ${request.expectedRowCount} rows but observed ${rows.length}`,
          evidenceRefs: [request.source.evidenceRef],
        }),
      );
    } else if (rows.length > request.expectedRowCount) {
      diagnostics.push(
        analysisDiagnostic({
          code: "unexpected_row_count",
          severity: "error",
          message: `Expected ${request.expectedRowCount} rows but observed ${rows.length}`,
          evidenceRefs: [request.source.evidenceRef],
        }),
      );
    }
  }

  const invalid = diagnostics.some((item) => ["error", "fatal"].includes(item.severity));
  const partial =
    request.executionCompletion === "unconfirmed" ||
    (request.expectedRowCount !== undefined && rows.length < request.expectedRowCount);
  const status: ParsedCpptrajTable["status"] = invalid
    ? "invalid"
    : rows.length === 0
      ? "no_data"
      : partial
        ? "partial"
        : "complete";
  const unsigned = {
    schemaVersion: CpptrajTableParseSchemaVersion,
    provenance: request.provenance,
    source: request.source,
    format: request.format,
    parser: request.parser,
    operationReceiptRef: request.operationReceiptRef,
    exitCode: request.exitCode,
    signal: request.signal,
    status,
    columns: request.columns,
    rows,
    diagnostics,
  };
  return ParsedCpptrajTableSchema.parse({
    ...unsigned,
    tableDigest: computeParsedCpptrajTableDigest(unsigned),
  });
}

export const CpptrajMetricProvenanceSchema = CpptrajOutputProvenanceSchema.extend({
  source: ExactArtifactDigestSchema,
  operationReceiptRef: IdSchema,
  parser: ParserIdentitySchema,
  parsedTableDigest: DigestSchema,
}).strict();
export type CpptrajMetricProvenance = z.infer<typeof CpptrajMetricProvenanceSchema>;

function normalizedSeriesId(
  provenance: CpptrajMetricProvenance,
  metric: MdMetricSeries["metric"],
  customMetricName?: string,
): string {
  return `md-series-${digestCanonical({
    provenance,
    metric,
    ...(customMetricName === undefined ? {} : { customMetricName }),
  })}`;
}

export const CpptrajNormalizedMetricSeriesSchema = z
  .object({
    schemaVersion: z.literal(CpptrajMetricSeriesSchemaVersion),
    provenance: CpptrajMetricProvenanceSchema,
    series: MdMetricSeriesSchema,
    provenanceDigest: DigestSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.provenanceDigest !== digestCanonical(result.provenance)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provenanceDigest"],
        message: "CPPTRAJ metric provenance digest does not match its exact content",
      });
    }
    if (result.series.seriesDigest !== computeMdMetricSeriesDigest(result.series)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["series", "seriesDigest"],
        message: "CPPTRAJ normalized metric series digest is invalid",
      });
    }
    if (
      result.series.id !==
      normalizedSeriesId(result.provenance, result.series.metric, result.series.customMetricName)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["series", "id"],
        message: "CPPTRAJ metric series identifier does not bind its exact provenance",
      });
    }
    if (
      result.series.stageResultId !== result.provenance.stageResultId ||
      result.series.replicaId !== result.provenance.replicaId ||
      result.series.sourceArtifactRef !== result.provenance.source.artifactId ||
      result.series.parserVersion !== result.provenance.parser.version
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["series"],
        message: "CPPTRAJ metric series does not match its exact plan and parser provenance",
      });
    }
  });
export type CpptrajNormalizedMetricSeries = z.infer<typeof CpptrajNormalizedMetricSeriesSchema>;

export function assertCpptrajNormalizedMetricSeries(value: unknown): CpptrajNormalizedMetricSeries {
  return CpptrajNormalizedMetricSeriesSchema.parse(value);
}

/**
 * Converts a complete table using only the semantic identity, unit, and frame
 * mapping carried by the exact digested plan output. Callers cannot override
 * those scientific meanings at normalization time.
 */
export function normalizeCpptrajMetricSeries(
  tableValue: unknown,
  planValue: unknown,
  outputNameValue: unknown,
): CpptrajNormalizedMetricSeries {
  if (arguments.length !== 3) {
    throw new Error("CPPTRAJ normalization does not accept semantic or frame-mapping overrides");
  }
  const table = assertParsedCpptrajTable(tableValue);
  const {
    plan,
    analysis,
    provenance: expectedProvenance,
  } = resolveCpptrajAnalysisOutput(planValue, outputNameValue);
  if (table.status !== "complete") {
    throw new Error(`Cannot normalize a ${table.status} CPPTRAJ table`);
  }
  if (
    digestCanonical(table.provenance) !== digestCanonical(expectedProvenance) ||
    table.format !== analysis.outputContract.format ||
    digestCanonical(table.columns) !== digestCanonical(analysis.outputContract.columns)
  ) {
    throw new Error("Parsed CPPTRAJ table does not match the exact plan output contract");
  }
  const normalization = analysis.outputContract.normalization;
  if (normalization === null) {
    throw new Error(`CPPTRAJ output ${analysis.name} has no approved frame-series normalization`);
  }
  const valueColumn = table.columns.find(
    (column) => column.sourceName === normalization.valueColumn,
  );
  const frameColumn = table.columns.find(
    (column) => column.sourceName === normalization.frameMapping.frameColumn,
  );
  if (
    valueColumn?.semantic !== "value" ||
    valueColumn.unit !== normalization.unit ||
    frameColumn?.semantic !== "frame"
  ) {
    throw new Error("Plan output contract contains an invalid metric, unit, or frame mapping");
  }
  const points = table.rows.map((row) => {
    const frame = row.values[normalization.frameMapping.frameColumn]!;
    const offset = frame - normalization.frameMapping.firstFrame;
    if (!Number.isInteger(frame) || offset < 0 || !Number.isInteger(offset)) {
      throw new Error("Observed frame is incompatible with the explicit frame mapping");
    }
    return {
      step: normalization.frameMapping.firstStep + offset * normalization.frameMapping.cadenceSteps,
      timePs:
        normalization.frameMapping.firstTimePs + offset * normalization.frameMapping.cadenceTimePs,
      value: row.values[normalization.valueColumn]!,
    };
  });
  if (table.operationReceiptRef === undefined) {
    throw new Error("A normalized CPPTRAJ metric requires an exact operation receipt");
  }
  const provenance = CpptrajMetricProvenanceSchema.parse({
    ...expectedProvenance,
    source: table.source,
    operationReceiptRef: table.operationReceiptRef,
    parser: table.parser,
    parsedTableDigest: table.tableDigest,
  });
  const id = normalizedSeriesId(provenance, normalization.metric, normalization.customMetricName);
  const unsigned = {
    schemaVersion: MdMetricSeriesSchemaVersion,
    id,
    stageResultId: plan.stageResult.id,
    replicaId: plan.segment.replicaId,
    metric: normalization.metric,
    ...(normalization.customMetricName === undefined
      ? {}
      : { customMetricName: normalization.customMetricName }),
    unit: normalization.unit,
    points,
    sourceArtifactRef: table.source.artifactId,
    parserVersion: table.parser.version,
  };
  const series: MdMetricSeries = MdMetricSeriesSchema.parse({
    ...unsigned,
    seriesDigest: computeMdMetricSeriesDigest(unsigned),
  });
  return CpptrajNormalizedMetricSeriesSchema.parse({
    schemaVersion: CpptrajMetricSeriesSchemaVersion,
    provenance,
    series,
    provenanceDigest: digestCanonical(provenance),
  });
}
