import {
  IdSchema,
  MdArtifactReferenceSchema,
  MdStageResultSchema,
  QmmmProtocolSchema,
  digestCanonical,
} from "@eigengrid/scientific-schema";
import { z } from "zod";
import {
  AmberQmmmParseSchemaVersion,
  AmberQmmmParserVersion,
  AmberQmmmQualifiedEngine,
} from "./versions";

export const AmberQmmmParseRequestSchema = z
  .object({
    schemaVersion: z.literal(AmberQmmmParseSchemaVersion),
    missionId: IdSchema,
    source: MdArtifactReferenceSchema,
    stageResult: MdStageResultSchema,
    protocol: QmmmProtocolSchema,
    parserVersion: z.literal(AmberQmmmParserVersion),
    executionCompletion: z.enum(["confirmed", "unconfirmed"]),
    operationReceiptRef: IdSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const resultSource = request.stageResult.artifacts.find(
      (artifact) => artifact.role === "mdout",
    );
    if (
      request.source.role !== "mdout" ||
      resultSource === undefined ||
      digestCanonical(resultSource) !== digestCanonical(request.source)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source"],
        message: "QM/MM parsing requires the exact mdout artifact of the exact stage result",
      });
    }
    if (
      request.missionId !== request.stageResult.missionId ||
      request.missionId !== request.protocol.missionId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["missionId"],
        message: "QM/MM protocol, stage result, and parse request must belong to one mission",
      });
    }
    if (
      request.stageResult.protocolId !== request.protocol.parentMdProtocol.id ||
      request.stageResult.protocolRevision !== request.protocol.parentMdProtocol.revision ||
      request.stageResult.protocolDigest !== request.protocol.parentMdProtocol.digest ||
      !request.protocol.appliedStageIds.includes(request.stageResult.stageId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["protocol"],
        message: "QM/MM protocol must bind the exact parent MD protocol and executed stage",
      });
    }
    if (request.protocol.status !== "approved" || request.protocol.approvedByRef === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["protocol", "status"],
        message: "Only an exactly approved QM/MM protocol is eligible for authoritative parsing",
      });
    }
    if (
      request.operationReceiptRef !== undefined &&
      request.operationReceiptRef !== request.stageResult.operationReceiptId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operationReceiptRef"],
        message: "QM/MM parser receipt must match the exact stage result receipt",
      });
    }
    if (request.operationReceiptRef === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operationReceiptRef"],
        message: "QM/MM parsing requires the exact durable operation receipt",
      });
    }
    if (
      (request.executionCompletion === "unconfirmed") !==
      (request.stageResult.terminalReason === "ambiguous")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executionCompletion"],
        message:
          "Only an ambiguous stage outcome may remain unconfirmed; every terminal outcome must be confirmed",
      });
    }
    if (
      request.stageResult.engine.engine !== AmberQmmmQualifiedEngine.engine ||
      request.stageResult.engine.executable !== AmberQmmmQualifiedEngine.executable ||
      request.stageResult.engine.version !== AmberQmmmQualifiedEngine.version ||
      request.stageResult.engine.compatibilityVersion !==
        AmberQmmmQualifiedEngine.compatibilityVersion ||
      request.protocol.rendererCompatibilityVersion !==
        AmberQmmmQualifiedEngine.rendererCompatibilityVersion
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stageResult", "engine"],
        message:
          "QM/MM parser v1 is qualified only for the exact sander AmberTools 26.0 and renderer 1.0.0 envelope",
      });
    }
    if (request.protocol.region.selectionClass !== "all_qm_engine_check") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["protocol", "region", "selectionClass"],
        message:
          "QM/MM parser v1 is qualified only for the all-QM module check; hybrid coupling remains unqualified",
      });
    }
  });

export type AmberQmmmParseRequest = z.infer<typeof AmberQmmmParseRequestSchema>;
