import { digestCanonical } from "@eigengrid/scientific-schema";
import { z } from "zod";
import { ToolRegistry, type Materialization } from "../../registry";
import { make } from "../../tool";
import type { PermissionRuleset, Settlement, ToolResult } from "../../types";
import { MdToolCatalog, mdToolsForBundle, type MdToolBundle, type MdToolName } from "./catalog";
import {
  MdToolEnvelopeShape,
  MdToolOutputSchemas,
  type MdToolOutput,
  type MdToolOutputKind,
  type MdToolPayload,
} from "./contracts";

export interface MdValidatedToolInvocation {
  readonly name: MdToolName;
  readonly outputKind: MdToolOutputKind;
  readonly requestDigest: string;
  readonly input: {
    readonly schemaVersion: "eigengrid.md-tool-request/v2";
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly missionId: string;
    readonly expectedMissionRevision: number;
    readonly expectedSubjectRevision: number;
    readonly actorRef: {
      readonly id: string;
      readonly kind: "human" | "model" | "service";
      readonly displayName?: string;
      readonly role: string;
    };
    readonly evidenceRefs: readonly { readonly id: string; readonly contentDigest: string }[];
    readonly payload: MdToolPayload;
  };
}

/** Application boundary: implementations expose mission services, never DBs or raw runners. */
export interface MdToolServices {
  invoke(invocation: MdValidatedToolInvocation): Promise<ToolResult<MdToolOutput>>;
}

export interface MdToolBundleSnapshot {
  readonly bundle: MdToolBundle;
  readonly toolNames: readonly MdToolName[];
  readonly snapshotDigest: string;
  readonly definitions: Materialization["definitions"];
  readonly approvalRequiredDefinitions: Materialization["approvalRequiredDefinitions"];
  settle(
    call: { name: string; input: unknown; id: string },
    context: Parameters<Materialization["settle"]>[1],
  ): Promise<Settlement>;
}

function permissionRules(bundle: MdToolBundle): PermissionRuleset {
  return [
    { action: "*", resource: "*", effect: "deny" },
    ...mdToolsForBundle(bundle).map((tool) => ({
      action: "tool:execute",
      resource: tool.name,
      effect: tool.permission,
    })),
  ];
}

function evidenceIdentity(binding: { id: string; contentDigest: string }): string {
  return `${binding.id}\u0000${binding.contentDigest}`;
}

function collectPayloadEvidence(
  value: unknown,
  output: { id: string; contentDigest: string }[] = [],
) {
  if (Array.isArray(value)) {
    for (const item of value) collectPayloadEvidence(item, output);
    return output;
  }
  if (value === null || typeof value !== "object") return output;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length === 2 &&
    typeof record.id === "string" &&
    typeof record.contentDigest === "string"
  ) {
    output.push({ id: record.id, contentDigest: record.contentDigest });
    return output;
  }
  for (const child of Object.values(record)) collectPayloadEvidence(child, output);
  return output;
}

function validateEnvelopeBinding(
  descriptor: (typeof MdToolCatalog)[number],
  decoded: MdValidatedToolInvocation["input"],
): string | null {
  const evidenceIdentities = decoded.evidenceRefs.map(evidenceIdentity);
  if (new Set(evidenceIdentities).size !== evidenceIdentities.length) {
    return "Envelope evidence references must be unique exact bindings";
  }
  const evidenceIds = decoded.evidenceRefs.map((reference) => reference.id);
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    return "Envelope evidence may bind each evidence id to only one digest";
  }
  const subjects = descriptor.subjectBindings(decoded.payload);
  const expectedRevision = subjects[0]?.revision ?? decoded.expectedMissionRevision;
  if (decoded.expectedSubjectRevision !== expectedRevision) {
    return `expectedSubjectRevision ${decoded.expectedSubjectRevision} does not match ${expectedRevision}`;
  }
  const envelopeEvidence = new Set(evidenceIdentities);
  for (const binding of collectPayloadEvidence(decoded.payload)) {
    if (!envelopeEvidence.has(evidenceIdentity(binding))) {
      return `Payload evidence ${binding.id} is absent from the exact envelope evidence set`;
    }
  }
  return null;
}

function contractFailure(message: string): ToolResult<MdToolOutput> {
  return {
    ok: false,
    error: {
      code: "SERVICE_CONTRACT_VIOLATION",
      message,
      hint: "The typed mission service returned data that does not bind the validated request",
    },
  };
}

function verifyServiceOutput(
  descriptor: (typeof MdToolCatalog)[number],
  decoded: MdValidatedToolInvocation["input"],
  requestDigest: string,
  result: ToolResult<MdToolOutput>,
): ToolResult<MdToolOutput> {
  if (!result.ok) return result;
  const parsed = MdToolOutputSchemas[descriptor.outputKind].safeParse(result.data);
  if (!parsed.success) {
    return contractFailure(`Service output failed ${descriptor.outputKind} schema validation`);
  }
  const output = parsed.data;
  if (output.requestId !== decoded.requestId) {
    return contractFailure("Service output requestId does not match the validated request");
  }
  if ("missionId" in output && output.missionId !== decoded.missionId) {
    return contractFailure("Service output missionId does not match the validated request");
  }
  const missionObserved = output.observedVersions.some(
    (version) =>
      version.subjectId === decoded.missionId &&
      version.revision === decoded.expectedMissionRevision,
  );
  if (!missionObserved) {
    return contractFailure("Service output omits the exact observed mission revision");
  }
  for (const subject of descriptor.subjectBindings(decoded.payload)) {
    const observed = output.observedVersions.some(
      (version) =>
        version.subjectId === subject.id &&
        version.revision === subject.revision &&
        version.contentDigest === subject.digest,
    );
    if (!observed) {
      return contractFailure(
        `Service output omits exact observed subject ${subject.id}@${subject.revision}`,
      );
    }
  }
  if (descriptor.outputKind === "receipt") {
    const receipt = output as z.infer<(typeof MdToolOutputSchemas)["receipt"]>;
    if (receipt.requestDigest !== requestDigest) {
      return contractFailure("Operation receipt requestDigest does not match the canonical input");
    }
    const requestedOperationId = (decoded.payload as Record<string, unknown>).operationId;
    if (typeof requestedOperationId === "string" && receipt.operationId !== requestedOperationId) {
      return contractFailure(
        "Operation receipt operationId does not match the requested operation",
      );
    }
  }
  if (descriptor.name === "md-stage-status") {
    const status = output as z.infer<(typeof MdToolOutputSchemas)["read"]>;
    for (const subject of descriptor.subjectBindings(decoded.payload)) {
      const record = status.records.find((candidate) => candidate.id === subject.id);
      if (record?.revision !== subject.revision || record.contentDigest !== subject.digest) {
        return contractFailure(
          `Stage status omits exact queried subject ${subject.id}@${subject.revision}`,
        );
      }
    }
  }
  if ("evidenceRefs" in output || "sourceArtifactRefs" in output) {
    const references = "evidenceRefs" in output ? output.evidenceRefs : output.sourceArtifactRefs;
    const envelopeEvidence = new Set(decoded.evidenceRefs.map(evidenceIdentity));
    if (references.some((reference) => !envelopeEvidence.has(evidenceIdentity(reference)))) {
      return contractFailure("Service output cites evidence outside the validated envelope");
    }
  }
  return { ok: true, data: output as MdToolOutput };
}

/** Shared by allow settlement and the future durable approval/resume path. */
export function validateMdToolServiceResult(
  invocation: MdValidatedToolInvocation,
  result: ToolResult<MdToolOutput>,
): ToolResult<MdToolOutput> {
  const descriptor = MdToolCatalog.find((candidate) => candidate.name === invocation.name);
  if (descriptor === undefined || descriptor.outputKind !== invocation.outputKind) {
    return contractFailure("Invocation does not match a catalogued MD tool output contract");
  }
  if (digestCanonical(invocation.input) !== invocation.requestDigest) {
    return contractFailure("Invocation requestDigest does not match its canonical input");
  }
  return verifyServiceOutput(descriptor, invocation.input, invocation.requestDigest, result);
}

function makeDefinition(descriptor: (typeof MdToolCatalog)[number], services: MdToolServices) {
  const input = z
    .object({ ...MdToolEnvelopeShape, payload: descriptor.payloadSchema })
    .strict()
    .superRefine((decoded, context) => {
      const problem = validateEnvelopeBinding(
        descriptor,
        decoded as MdValidatedToolInvocation["input"],
      );
      if (problem !== null) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: problem });
      }
    });
  const output = MdToolOutputSchemas[descriptor.outputKind];
  return make({
    description: descriptor.description,
    input,
    output,
    async execute(decoded): Promise<ToolResult<MdToolOutput>> {
      const requestDigest = digestCanonical(decoded);
      const result = await services.invoke({
        name: descriptor.name,
        outputKind: descriptor.outputKind,
        requestDigest,
        input: decoded as MdValidatedToolInvocation["input"],
      });
      return validateMdToolServiceResult(
        {
          name: descriptor.name,
          outputKind: descriptor.outputKind,
          requestDigest,
          input: decoded as MdValidatedToolInvocation["input"],
        },
        result,
      );
    },
  });
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

/**
 * Creates one immutable, phase-scoped model snapshot. Ask tools are metadata only and
 * cannot settle from this snapshot; an application must resume them through durable approval.
 */
export function materializeMdToolBundle(
  bundleInput: MdToolBundle,
  services: MdToolServices,
): MdToolBundleSnapshot {
  const bundle = z
    .enum([
      "discovery",
      "planning",
      "preparation",
      "execution",
      "analysis",
      "comparison",
      "provenance",
    ])
    .parse(bundleInput);
  const tools = mdToolsForBundle(bundle);
  const registry = new ToolRegistry(permissionRules(bundle));
  for (const descriptor of tools) {
    registry.registerScoped(descriptor.name, makeDefinition(descriptor, services));
  }
  const materialized = registry.materialize();
  const toolNames = Object.freeze(tools.map((tool) => tool.name));
  const snapshotDigest = digestCanonical({
    bundle,
    tools: tools.map((tool) => ({
      name: tool.name,
      permission: tool.permission,
      outputKind: tool.outputKind,
    })),
    definitions: materialized.definitions,
    approvalRequiredDefinitions: materialized.approvalRequiredDefinitions,
  });
  const definitions = deepFreeze([...materialized.definitions]);
  const approvalRequiredDefinitions = deepFreeze([...materialized.approvalRequiredDefinitions]);
  return Object.freeze({
    bundle,
    toolNames,
    snapshotDigest,
    definitions,
    approvalRequiredDefinitions,
    settle: materialized.settle,
  }) as MdToolBundleSnapshot;
}
