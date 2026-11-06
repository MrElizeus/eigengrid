import { z } from "zod";
import { DigestSchema, IdSchema, SemverSchema } from "../schemas";
import { MdAssessmentSchemaVersion } from "./common";
import { assertSelfDigest, canonicalSelfDigest } from "./digests";

export const MdAcceptanceCriterionSchema = z
  .object({
    schemaVersion: z.literal(MdAssessmentSchemaVersion),
    id: IdSchema,
    kind: z.enum([
      "normal_termination",
      "artifact_integrity",
      "restart_continuity",
      "thermodynamic_range",
      "membrane_observable",
      "replica_convergence",
      "custom",
    ]),
    description: z.string().min(1),
    observable: z.string().min(1).optional(),
    lowerBound: z.number().finite().optional(),
    upperBound: z.number().finite().optional(),
    unit: z.string().min(1).optional(),
    windowFraction: z
      .object({ start: z.number().finite().min(0).max(1), end: z.number().finite().min(0).max(1) })
      .strict()
      .refine((window) => window.end > window.start, {
        path: ["end"],
        message: "Assessment window end must be greater than its start",
      })
      .optional(),
    required: z.boolean(),
    evaluatorVersion: SemverSchema,
    criterionDigest: DigestSchema,
  })
  .strict()
  .superRefine((criterion, context) => {
    if (criterion.criterionDigest !== computeMdAcceptanceCriterionDigest(criterion)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["criterionDigest"],
        message: "Acceptance criterion digest does not match its material evaluator contract",
      });
    }
    const metricKind = [
      "thermodynamic_range",
      "membrane_observable",
      "replica_convergence",
    ].includes(criterion.kind);
    if (
      metricKind &&
      (!criterion.observable ||
        (criterion.lowerBound === undefined && criterion.upperBound === undefined) ||
        !criterion.unit)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observable"],
        message: "Metric acceptance criteria require an observable, bound, and unit",
      });
    }
    if (
      criterion.lowerBound !== undefined &&
      criterion.upperBound !== undefined &&
      criterion.lowerBound > criterion.upperBound
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["upperBound"],
        message: "Acceptance upper bound must not be below its lower bound",
      });
    }
  });

export type MdAcceptanceCriterion = z.infer<typeof MdAcceptanceCriterionSchema>;

/** Digests every acceptance-criterion field except `criterionDigest` itself. */
export function computeMdAcceptanceCriterionDigest(value: object): string {
  return canonicalSelfDigest(value, "criterionDigest");
}

/** Rejects a criterion whose stable identity does not cover its material evaluator contract. */
export function assertMdAcceptanceCriterionDigest(value: unknown): MdAcceptanceCriterion {
  const criterion = MdAcceptanceCriterionSchema.parse(value);
  return assertSelfDigest(
    "MdAcceptanceCriterion",
    criterion,
    criterion.criterionDigest,
    "criterionDigest",
  );
}
