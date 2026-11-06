import { z } from "zod";
import { DigestSchema, IdSchema, SemverSchema } from "../schemas";
import { MdMetricSeriesSchemaVersion } from "./common";
import { assertSelfDigest, canonicalSelfDigest } from "./digests";

export const MdMetricNameSchema = z.enum([
  "potential_energy",
  "kinetic_energy",
  "total_energy",
  "temperature",
  "pressure",
  "density",
  "volume",
  "rmsd",
  "rmsf",
  "area_per_lipid",
  "membrane_thickness",
  "protein_tilt",
  "ligand_contact_fraction",
  "custom",
]);

export type MdMetricName = z.infer<typeof MdMetricNameSchema>;

export const MdMetricPointSchema = z
  .object({
    step: z.number().finite().int().safe().nonnegative(),
    timePs: z.number().finite().nonnegative(),
    value: z.number().finite(),
  })
  .strict();

export const MdMetricSeriesSchema = z
  .object({
    schemaVersion: z.literal(MdMetricSeriesSchemaVersion),
    id: IdSchema,
    stageResultId: IdSchema,
    replicaId: IdSchema.optional(),
    metric: MdMetricNameSchema,
    customMetricName: z.string().min(1).optional(),
    unit: z.string().min(1),
    points: z.array(MdMetricPointSchema).min(1),
    sourceArtifactRef: IdSchema,
    parserVersion: SemverSchema,
    seriesDigest: DigestSchema,
  })
  .strict()
  .superRefine((series, context) => {
    if ((series.metric === "custom") !== (series.customMetricName !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customMetricName"],
        message: "Only a custom metric must provide a custom metric name",
      });
    }
    for (let index = 1; index < series.points.length; index += 1) {
      const previous = series.points[index - 1]!;
      const current = series.points[index]!;
      if (current.step <= previous.step || current.timePs <= previous.timePs) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["points", index],
          message: "Normalized metric points must advance in both step and time",
        });
      }
    }
  });

export type MdMetricSeries = z.infer<typeof MdMetricSeriesSchema>;

export const NormalizedMdMetricsSchema = z
  .object({
    schemaVersion: z.literal(MdMetricSeriesSchemaVersion),
    id: IdSchema,
    stageResultId: IdSchema,
    series: z.array(MdMetricSeriesSchema).min(1),
    warnings: z.array(z.string().min(1)),
    metricsDigest: DigestSchema,
  })
  .strict()
  .superRefine((metrics, context) => {
    if (metrics.series.some((series) => series.stageResultId !== metrics.stageResultId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["series"],
        message: "Every normalized series must belong to the enclosing stage result",
      });
    }
    const keys = metrics.series.map(
      (series) =>
        `${series.metric}\u0000${series.customMetricName ?? ""}\u0000${series.replicaId ?? ""}`,
    );
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["series"],
        message: "A normalized metrics bundle cannot contain duplicate series",
      });
    }
  });

export type NormalizedMdMetrics = z.infer<typeof NormalizedMdMetricsSchema>;

export const MdDiagnosticMessageSchema = z
  .object({
    code: z.string().min(1),
    severity: z.enum(["info", "warning", "error", "fatal"]),
    message: z.string().min(1),
    sourceEvidenceRefs: z.array(IdSchema),
  })
  .strict();

export type MdDiagnosticMessage = z.infer<typeof MdDiagnosticMessageSchema>;

/** Digests every normalized metric-series field except `seriesDigest` itself. */
export function computeMdMetricSeriesDigest(value: object): string {
  return canonicalSelfDigest(value, "seriesDigest");
}

/** Validates both the normalized metric-series schema and its canonical self-digest. */
export function assertMdMetricSeriesDigest(value: unknown): MdMetricSeries {
  const series = MdMetricSeriesSchema.parse(value);
  return assertSelfDigest("MdMetricSeries", series, series.seriesDigest, "seriesDigest");
}
