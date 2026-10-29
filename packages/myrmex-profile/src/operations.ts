import {
  PublicCompatibilitySchema,
  PublicDateTimeSchema,
  PublicDigestSchema,
} from "@eigengrid/protocol";
import { z } from "zod";

export const MYRMEX_PROFILE_VERSION = "0.1.0" as const;

export const MYRMEX_PROFILE_FEATURES = Object.freeze({
  read: "myrmex.read.v1",
  mission: "myrmex.mission.v1",
  admin: "myrmex.admin.v1",
  incidentRedaction: "myrmex.incident-redaction.v1",
  upgrade: "myrmex.upgrade.v1",
} as const);

export const MYRMEX_PROFILE_OPERATIONS = Object.freeze({
  compatibilityStatus: "version/compatibility",
  missionStatus: "mission/status",
  jobStatus: "job/status",
  approvalStatus: "approval/status",
  evidenceExport: "evidence/provenance/export",
  incidentBundle: "incident/bundle/redacted",
  missionCreate: "mission/create",
  missionInputSubmit: "mission/input/submit",
  missionApprovalDecide: "mission/approval/decide",
  missionStart: "mission/start",
  missionPause: "mission/pause",
  missionResume: "mission/resume",
  missionCancel: "mission/cancel",
  backupCreate: "admin/backup/create",
  maintenanceSet: "admin/maintenance/set",
  upgradeValidate: "admin/upgrade/validate",
  upgradeApply: "admin/upgrade/apply",
  upgradeVerify: "admin/upgrade/verify",
  upgradePromote: "admin/upgrade/promote",
  upgradeRollback: "admin/upgrade/rollback",
} as const);

export type MyrmexProfileOperation =
  (typeof MYRMEX_PROFILE_OPERATIONS)[keyof typeof MYRMEX_PROFILE_OPERATIONS];

export const EvidenceExportPayloadSchema = z
  .object({
    format: z.enum(["json", "jsonld"]),
    includeRetracted: z.boolean().default(false),
  })
  .strict();
export type EvidenceExportPayload = z.input<typeof EvidenceExportPayloadSchema>;

export const MyrmexCompatibilityStatusResultSchema = z
  .object({
    schema: z.literal("eigengrid.myrmex-compatibility-status-result.v1"),
    compatibility: PublicCompatibilitySchema,
  })
  .strict();
export type MyrmexCompatibilityStatusResult = z.infer<typeof MyrmexCompatibilityStatusResultSchema>;

export const MyrmexStatusResultSchema = z
  .object({
    schema: z.literal("eigengrid.myrmex-status-result.v1"),
    status: z.string().min(1),
    observedAt: PublicDateTimeSchema,
    detail: z.record(z.unknown()).optional(),
  })
  .strict();
export type MyrmexStatusResult = z.infer<typeof MyrmexStatusResultSchema>;

export const RedactedIncidentBundlePayloadSchema = z
  .object({
    incidentId: z.string().min(1),
    from: PublicDateTimeSchema,
    through: PublicDateTimeSchema,
    redactionPolicyDigest: PublicDigestSchema,
    sections: z
      .array(
        z.enum([
          "health",
          "versions",
          "events",
          "operation_receipts",
          "configuration_fingerprints",
        ]),
      )
      .min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.from) > Date.parse(value.through)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["through"],
        message: "Incident bundle end precedes its start",
      });
    }
  });
export type RedactedIncidentBundlePayload = z.input<typeof RedactedIncidentBundlePayloadSchema>;

export const RedactedIncidentBundleResultSchema = z
  .object({
    schema: z.literal("eigengrid.redacted-incident-bundle-result.v1"),
    incidentId: z.string().min(1),
    artifactReference: z.string().min(1),
    payloadDigest: PublicDigestSchema,
    bundleDigest: PublicDigestSchema,
  })
  .strict();
export type RedactedIncidentBundleResult = z.infer<typeof RedactedIncidentBundleResultSchema>;

export const MissionCreatePayloadSchema = z
  .object({
    missionSchema: z.string().min(1),
    missionDigest: PublicDigestSchema,
    objectiveDigest: PublicDigestSchema,
    planDigest: PublicDigestSchema.optional(),
  })
  .strict();
export type MissionCreatePayload = z.input<typeof MissionCreatePayloadSchema>;

export const MissionInputPayloadSchema = z
  .object({
    inputSchema: z.string().min(1),
    inputDigest: PublicDigestSchema,
    artifactReference: z.string().min(1),
  })
  .strict();
export type MissionInputPayload = z.input<typeof MissionInputPayloadSchema>;

export const MissionApprovalDecisionPayloadSchema = z
  .object({
    approvalId: z.string().min(1),
    approvalDigest: PublicDigestSchema,
    decision: z.enum(["approve", "reject"]),
    reasonCode: z.string().min(1).optional(),
  })
  .strict();
export type MissionApprovalDecisionPayload = z.input<typeof MissionApprovalDecisionPayloadSchema>;

export const MissionLifecyclePayloadSchema = z
  .object({
    reasonCode: z.string().min(1).optional(),
  })
  .strict();
export type MissionLifecyclePayload = z.input<typeof MissionLifecyclePayloadSchema>;

export const BackupCreatePayloadSchema = z
  .object({
    restorePointId: z.string().min(1),
    purpose: z.literal("upgrade"),
    targetArtifactDigest: PublicDigestSchema,
  })
  .strict();
export type BackupCreatePayload = z.input<typeof BackupCreatePayloadSchema>;

export const MaintenancePayloadSchema = z
  .object({
    mode: z.enum(["enter", "exit"]),
    changeId: z.string().min(1),
  })
  .strict();
export type MaintenancePayload = z.input<typeof MaintenancePayloadSchema>;

export const UpgradeTargetSchema = z
  .object({
    targetVersion: z.string().min(1),
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/u),
    artifactDigest: PublicDigestSchema,
    sbomDigest: PublicDigestSchema,
    signatureDigest: PublicDigestSchema,
    restorePointId: z.string().min(1),
  })
  .strict();
export type UpgradeTarget = z.input<typeof UpgradeTargetSchema>;
