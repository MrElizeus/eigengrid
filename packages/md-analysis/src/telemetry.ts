import {
  MdArtifactReferenceSchema,
  MdMetricSeriesSchema,
  MdMetricSeriesSchemaVersion,
  MdStageResultSchema,
  IdSchema,
  SemverSchema,
  assertMdStageResultDigest,
  computeMdMetricSeriesDigest,
  digestBytes,
  digestCanonical,
  type MdMetricName,
  type MdMetricSeries,
} from "@eigengrid/scientific-schema";
import { z } from "zod";
import {
  AnalysisDiagnosticSchema,
  MdAnalysisParseSchemaVersion,
  analysisDiagnostic,
  cleanDiagnosticLine,
  type AnalysisDiagnostic,
} from "./contracts";

export const AmberTelemetryMetricSchema = z.enum([
  "total_energy",
  "potential_energy",
  "kinetic_energy",
  "temperature",
  "pressure",
  "volume",
  "density",
]);
export type AmberTelemetryMetric = z.infer<typeof AmberTelemetryMetricSchema>;

export const AmberTelemetryUnits = {
  total_energy: "kcal/mol",
  potential_energy: "kcal/mol",
  kinetic_energy: "kcal/mol",
  temperature: "K",
  pressure: "bar",
  volume: "angstrom^3",
  density: "g/mL",
} as const satisfies Record<AmberTelemetryMetric, string>;

export const AmberTelemetryUnitsSchema = z
  .object({
    total_energy: z.literal("kcal/mol"),
    potential_energy: z.literal("kcal/mol"),
    kinetic_energy: z.literal("kcal/mol"),
    temperature: z.literal("K"),
    pressure: z.literal("bar"),
    volume: z.literal("angstrom^3"),
    density: z.literal("g/mL"),
  })
  .strict();

const FieldByAmberKey = {
  ETOT: "total_energy",
  EPTOT: "potential_energy",
  EKTOT: "kinetic_energy",
  "TEMP(K)": "temperature",
  PRESS: "pressure",
  VOLUME: "volume",
  DENSITY: "density",
} as const satisfies Record<string, AmberTelemetryMetric>;

export const AmberTelemetryParseRequestSchema = z
  .object({
    schemaVersion: z.literal(MdAnalysisParseSchemaVersion),
    sourceKind: z.enum(["mdout", "mdinfo"]),
    missionId: IdSchema,
    source: MdArtifactReferenceSchema,
    stageResult: MdStageResultSchema,
    parserVersion: SemverSchema,
    executionCompletion: z.enum(["confirmed", "unconfirmed"]),
    operationReceiptRef: IdSchema.optional(),
    exitCode: z.number().int().nonnegative().nullable(),
    signal: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((request, context) => {
    const resultArtifact = request.stageResult.artifacts.find(
      (artifact) => artifact.role === request.sourceKind,
    );
    if (
      request.stageResult.missionId !== request.missionId ||
      request.source.role !== request.sourceKind ||
      resultArtifact === undefined ||
      digestCanonical(resultArtifact) !== digestCanonical(request.source)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source"],
        message: "Telemetry source must be an exact artifact of the exact mission stage result",
      });
    }
    if (
      request.exitCode !== request.stageResult.exitCode ||
      request.signal !== request.stageResult.signal ||
      (request.operationReceiptRef !== undefined &&
        request.operationReceiptRef !== request.stageResult.operationReceiptId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stageResult"],
        message: "Telemetry termination and receipt observations must match the exact stage result",
      });
    }
    if (
      request.executionCompletion === "confirmed" &&
      (request.operationReceiptRef === undefined ||
        (request.exitCode === null) === (request.signal === null))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executionCompletion"],
        message:
          "Confirmed process completion requires an exact receipt and one terminal exit or signal observation",
      });
    }
  });
export type AmberTelemetryParseRequest = z.infer<typeof AmberTelemetryParseRequestSchema>;

export const AmberTelemetrySampleSchema = z
  .object({
    sourceLine: z.number().int().positive(),
    step: z.number().int().nonnegative().optional(),
    timePs: z.number().nonnegative().optional(),
    values: z.record(AmberTelemetryMetricSchema, z.number().finite()),
  })
  .strict();
export type AmberTelemetrySample = z.infer<typeof AmberTelemetrySampleSchema>;

export const AmberTelemetryParseResultSchema = z
  .object({
    schemaVersion: z.literal(MdAnalysisParseSchemaVersion),
    sourceKind: z.enum(["mdout", "mdinfo"]),
    missionId: IdSchema,
    stageResult: z
      .object({
        id: IdSchema,
        revision: z.number().int().positive(),
        resultDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    source: MdArtifactReferenceSchema,
    operationReceiptRef: IdSchema.optional(),
    exitCode: z.number().int().nonnegative().nullable(),
    signal: z.string().min(1).nullable(),
    status: z.enum(["completed", "partial", "fatal", "nonzero_exit", "no_data"]),
    terminalMarkerObserved: z.boolean(),
    samples: z.array(AmberTelemetrySampleSchema),
    units: AmberTelemetryUnitsSchema,
    metricSeries: z.array(MdMetricSeriesSchema),
    seriesEligible: z.boolean(),
    diagnostics: z.array(AnalysisDiagnosticSchema),
    lastStep: z.number().int().nonnegative().nullable(),
    lastTimePs: z.number().nonnegative().nullable(),
    parseDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.status === "completed" &&
      (result.operationReceiptRef === undefined || result.exitCode !== 0 || result.signal !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "Completed telemetry requires a successful exact operation receipt",
      });
    }
    if (result.seriesEligible !== (result.status === "completed")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["seriesEligible"],
        message: "Only a completed mdout parse may emit durable metric series",
      });
    }
    if (!result.seriesEligible && result.metricSeries.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["metricSeries"],
        message: "Partial or failed telemetry may not be promoted to durable metric series",
      });
    }
  });
export type AmberTelemetryParseResult = z.infer<typeof AmberTelemetryParseResultSchema>;

export function computeAmberTelemetryParseDigest(
  value: Omit<AmberTelemetryParseResult, "parseDigest"> | AmberTelemetryParseResult,
): string {
  const { parseDigest: _parseDigest, ...payload } = value as AmberTelemetryParseResult;
  return digestCanonical(payload);
}

export function assertAmberTelemetryParseResult(value: unknown): AmberTelemetryParseResult {
  const result = AmberTelemetryParseResultSchema.parse(value);
  if (result.parseDigest !== computeAmberTelemetryParseDigest(result)) {
    throw new Error(`AMBER telemetry parse digest mismatch for ${result.source.artifactId}`);
  }
  return result;
}

function numericValue(token: string): number | null {
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eEdD][-+]?\d+)?$/u.test(token)) return null;
  const parsed = Number(token.replace(/[dD]/u, "E"));
  return Number.isFinite(parsed) ? parsed : null;
}

function diagnosticForLine(
  line: string,
  lineNumber: number,
  evidenceRef: string,
): AnalysisDiagnostic | undefined {
  const message = cleanDiagnosticLine(line);
  if (/SHAKE cannot be accomplished|Coordinate resetting.*SHAKE/iu.test(line)) {
    return analysisDiagnostic({
      code: "shake_failure",
      severity: "fatal",
      line: lineNumber,
      message,
      evidenceRefs: [evidenceRef],
    });
  }
  if (/SANDER BOMB|PMEMD BOMB|\bFATAL\b|segmentation fault/iu.test(line)) {
    return analysisDiagnostic({
      code: "engine_fatal",
      severity: "fatal",
      line: lineNumber,
      message,
      evidenceRefs: [evidenceRef],
    });
  }
  if (/Error opening unit|Could not open file|Allocation failed|malloc failed/iu.test(line)) {
    return analysisDiagnostic({
      code: "engine_io_failure",
      severity: "fatal",
      line: lineNumber,
      message,
      evidenceRefs: [evidenceRef],
    });
  }
  if (/\b(?:NaN|Infinity)\b/iu.test(line)) {
    return analysisDiagnostic({
      code: "non_finite_value",
      severity: "fatal",
      line: lineNumber,
      message,
      evidenceRefs: [evidenceRef],
    });
  }
  if (/vlimit exceeded/iu.test(line)) {
    return analysisDiagnostic({
      code: "velocity_limit",
      severity: "warning",
      line: lineNumber,
      message,
      evidenceRefs: [evidenceRef],
    });
  }
  if (/\bWARNING\b/iu.test(line)) {
    return analysisDiagnostic({
      code: "engine_warning",
      severity: "warning",
      line: lineNumber,
      message,
      evidenceRefs: [evidenceRef],
    });
  }
  return undefined;
}

function buildMetricSeries(
  samples: readonly AmberTelemetrySample[],
  request: AmberTelemetryParseRequest,
): MdMetricSeries[] {
  const result: MdMetricSeries[] = [];
  for (const metric of AmberTelemetryMetricSchema.options) {
    const points = samples.flatMap((sample) => {
      const value = sample.values[metric];
      if (sample.step === undefined || sample.timePs === undefined || value === undefined)
        return [];
      return [{ step: sample.step, timePs: sample.timePs, value }];
    });
    if (points.length === 0) continue;
    const id = `md-series-${digestCanonical({
      stageResultId: request.stageResult.id,
      replicaId: request.stageResult.replicaId,
      sourceArtifactId: request.source.artifactId,
      metric,
    })}`;
    const unsigned = {
      schemaVersion: MdMetricSeriesSchemaVersion,
      id,
      stageResultId: request.stageResult.id,
      replicaId: request.stageResult.replicaId,
      metric: metric as MdMetricName,
      unit: AmberTelemetryUnits[metric],
      points,
      sourceArtifactRef: request.source.artifactId,
      parserVersion: request.parserVersion,
    };
    result.push(
      MdMetricSeriesSchema.parse({
        ...unsigned,
        seriesDigest: computeMdMetricSeriesDigest(unsigned),
      }),
    );
  }
  return result;
}

/**
 * Normalizes the stable key/value subset shared by representative AMBER mdout
 * and mdinfo files. A durable series is emitted only for confirmed, normally
 * terminated mdout output; mdinfo remains monitoring evidence.
 */
export function parseAmberMdTelemetry(
  content: string,
  requestValue: unknown,
): AmberTelemetryParseResult {
  const request = AmberTelemetryParseRequestSchema.parse(requestValue);
  assertMdStageResultDigest(request.stageResult);
  const diagnostics: AnalysisDiagnostic[] = [];
  const samples: AmberTelemetrySample[] = [];
  let current: AmberTelemetrySample | undefined;
  let terminalMarkerObserved = false;
  let inFinalResults = false;

  if (digestBytes(content) !== request.source.contentDigest) {
    diagnostics.push(
      analysisDiagnostic({
        code: "source_digest_mismatch",
        severity: "fatal",
        message: "Injected telemetry bytes do not match the exact source artifact digest",
        evidenceRefs: [request.source.evidenceRef],
      }),
    );
  }

  const flush = (): void => {
    if (current === undefined) return;
    samples.push(AmberTelemetrySampleSchema.parse(current));
    current = undefined;
  };
  const lines = content.split(/\r?\n/u);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const raw = lines[lineIndex]!;
    if (
      /^\s*FINAL RESULTS\s*$/iu.test(raw) ||
      /^\s*A\s+V\s+E\s+R\s+A\s+G\s+E\s+S\s+O\s+V\s+E\s+R/iu.test(raw) ||
      /^\s*R\s+M\s+S\s+F\s+L\s+U\s+C\s+T\s+U\s+A\s+T\s+I\s+O\s+N\s+S/iu.test(raw)
    ) {
      inFinalResults = true;
    }
    if (/Total wall time|Final Performance Info|^\s*5\.\s+TIMINGS/iu.test(raw)) {
      terminalMarkerObserved = true;
    }
    const lineDiagnostic = diagnosticForLine(raw, lineIndex + 1, request.source.evidenceRef);
    if (lineDiagnostic !== undefined) diagnostics.push(lineDiagnostic);
    // FINAL RESULTS ends telemetry extraction only. Diagnostics remain
    // authoritative through the rest of the mdout, including trailing summaries.
    if (inFinalResults) continue;

    const pairs = [
      ...raw.matchAll(
        /(NSTEP|TIME\(PS\)|TEMP\(K\)|PRESS|Etot|EKtot|EPtot|VOLUME|Density)\s*=\s*([^\s]+)/giu,
      ),
    ];
    for (const pair of pairs) {
      const key = pair[1]!.toUpperCase();
      if (key === "NSTEP" && current?.step !== undefined) flush();
      current ??= { sourceLine: lineIndex + 1, values: {} };
      const value = numericValue(pair[2]!);
      if (value === null) {
        diagnostics.push(
          analysisDiagnostic({
            code: "numeric_overflow",
            severity: "fatal",
            line: lineIndex + 1,
            message: cleanDiagnosticLine(raw),
            evidenceRefs: [request.source.evidenceRef],
          }),
        );
        continue;
      }
      if (key === "NSTEP") {
        if (!Number.isSafeInteger(value) || value < 0) {
          diagnostics.push(
            analysisDiagnostic({
              code: "invalid_step",
              severity: "fatal",
              line: lineIndex + 1,
              message: cleanDiagnosticLine(raw),
              evidenceRefs: [request.source.evidenceRef],
            }),
          );
        } else {
          current.step = value;
        }
      } else if (key === "TIME(PS)") {
        if (value < 0) {
          diagnostics.push(
            analysisDiagnostic({
              code: "invalid_time",
              severity: "fatal",
              line: lineIndex + 1,
              message: cleanDiagnosticLine(raw),
              evidenceRefs: [request.source.evidenceRef],
            }),
          );
        } else {
          current.timePs = value;
        }
      } else {
        const metric = FieldByAmberKey[key as keyof typeof FieldByAmberKey];
        if (metric !== undefined) current.values[metric] = value;
      }
    }
  }
  flush();

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!;
    if (sample.step === undefined || sample.timePs === undefined) {
      diagnostics.push(
        analysisDiagnostic({
          code: "incomplete_telemetry_sample",
          severity: "warning",
          line: sample.sourceLine,
          message:
            "Telemetry sample lacks an exact step or simulation time and cannot be normalized",
          evidenceRefs: [request.source.evidenceRef],
        }),
      );
    }
    const previous = samples[index - 1];
    if (
      previous?.step !== undefined &&
      previous.timePs !== undefined &&
      sample.step !== undefined &&
      sample.timePs !== undefined &&
      (sample.step <= previous.step || sample.timePs <= previous.timePs)
    ) {
      diagnostics.push(
        analysisDiagnostic({
          code: "telemetry_discontinuity",
          severity: "fatal",
          line: sample.sourceLine,
          message: "Telemetry samples do not advance monotonically in step and time",
          evidenceRefs: [request.source.evidenceRef],
        }),
      );
    }
  }

  const hasFatal = diagnostics.some((diagnostic) => diagnostic.severity === "fatal");
  const normalizationIncomplete = diagnostics.some(
    (diagnostic) => diagnostic.code === "incomplete_telemetry_sample",
  );
  const hasMetricData = samples.some((sample) => Object.keys(sample.values).length > 0);
  let status: AmberTelemetryParseResult["status"];
  if (request.exitCode !== null && request.exitCode !== 0) status = "nonzero_exit";
  else if (request.signal !== null || hasFatal) status = "fatal";
  else if (samples.length === 0) status = "no_data";
  else if (
    request.sourceKind === "mdout" &&
    request.executionCompletion === "confirmed" &&
    request.exitCode === 0 &&
    terminalMarkerObserved &&
    !normalizationIncomplete &&
    hasMetricData
  ) {
    status = "completed";
  } else status = "partial";

  const seriesEligible = status === "completed";
  const metricSeries = seriesEligible ? buildMetricSeries(samples, request) : [];
  let lastComplete: AmberTelemetrySample | undefined;
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index]!;
    if (sample.step !== undefined && sample.timePs !== undefined) {
      lastComplete = sample;
      break;
    }
  }
  const unsigned = {
    schemaVersion: MdAnalysisParseSchemaVersion,
    sourceKind: request.sourceKind,
    missionId: request.missionId,
    stageResult: {
      id: request.stageResult.id,
      revision: request.stageResult.revision,
      resultDigest: request.stageResult.resultDigest,
    },
    source: request.source,
    operationReceiptRef: request.operationReceiptRef,
    exitCode: request.exitCode,
    signal: request.signal,
    status,
    terminalMarkerObserved,
    samples,
    units: AmberTelemetryUnits,
    metricSeries,
    seriesEligible,
    diagnostics,
    lastStep: lastComplete?.step ?? null,
    lastTimePs: lastComplete?.timePs ?? null,
  };
  return AmberTelemetryParseResultSchema.parse({
    ...unsigned,
    parseDigest: computeAmberTelemetryParseDigest(unsigned),
  });
}
