import {
  MdExecutionBindingParametersSchema,
  digestCanonical,
  type MdExecutionBindingParameters,
  type MdStageSpec as CanonicalMdStageSpec,
} from "@eigengrid/scientific-schema";
import { sha256Canonical } from "../canonical";
import {
  AMBER_CANONICAL_STAGE_MAPPING_VERSION,
  AmberCanonicalStageMappingSchema,
  type AmberCanonicalStageMapping,
} from "./schemas";

function canonicalDigestWithout<T extends object>(value: T, key: keyof T): string {
  const clone = { ...value } as Record<string, unknown>;
  delete clone[key as string];
  return sha256Canonical(clone);
}

export function computeAmberCanonicalStageMappingDigest(value: object): string {
  return canonicalDigestWithout(value, "mappingDigest" as never);
}

export function assertAmberCanonicalStageMappingDigest(value: unknown): AmberCanonicalStageMapping {
  const mapping = AmberCanonicalStageMappingSchema.parse(value);
  const observed = computeAmberCanonicalStageMappingDigest(mapping);
  if (mapping.mappingDigest !== observed) {
    throw new Error(
      `AMBER stage mapping digest mismatch: expected ${mapping.mappingDigest}, observed ${observed}`,
    );
  }
  return mapping;
}

function assertCanonicalIdentity(
  stage: CanonicalMdStageSpec,
  mapping: AmberCanonicalStageMapping,
): void {
  const expected = {
    id: stage.id,
    revision: stage.revision,
    kind: stage.kind,
    stageDigest: stage.stageDigest,
    rendererCompatibilityVersion: stage.rendererCompatibilityVersion,
  };
  if (JSON.stringify(mapping.canonicalStage) !== JSON.stringify(expected)) {
    throw new Error(
      "AMBER mapping canonical stage identity does not match the exact stage revision",
    );
  }
  if (stage.rendererCompatibilityVersion !== AMBER_CANONICAL_STAGE_MAPPING_VERSION) {
    throw new Error(
      `Unsupported canonical renderer compatibility version: ${stage.rendererCompatibilityVersion}`,
    );
  }
}

export function computeCanonicalMdExecutionBindingDigest(value: unknown): string {
  return digestCanonical(MdExecutionBindingParametersSchema.parse(value));
}

function exactRecordEqual(left: unknown, right: unknown): boolean {
  return sha256Canonical(left) === sha256Canonical(right);
}

function assertExecutionBinding(
  stage: CanonicalMdStageSpec,
  mapping: AmberCanonicalStageMapping,
  value: unknown,
): { parameters: MdExecutionBindingParameters; bindingDigest: string } {
  const parameters = MdExecutionBindingParametersSchema.parse(value);
  const digest = computeCanonicalMdExecutionBindingDigest(parameters);
  if (mapping.canonicalWorkUnit.bindingDigest !== digest) {
    throw new Error(
      `Canonical WorkUnit binding digest mismatch: expected ${mapping.canonicalWorkUnit.bindingDigest}, observed ${digest}`,
    );
  }
  for (const field of ["plan", "system", "protocol"] as const) {
    if (!exactRecordEqual(mapping.canonicalWorkUnit[field], parameters[field])) {
      throw new Error(`Canonical WorkUnit ${field} identity does not match the AMBER mapping`);
    }
  }
  if (
    parameters.system.id !== stage.system.id ||
    parameters.system.revision !== stage.system.revision ||
    parameters.system.digest !== stage.system.manifestDigest
  ) {
    throw new Error("Canonical WorkUnit system identity does not match the exact stage system");
  }
  if (
    parameters.stage.id !== stage.id ||
    parameters.stage.revision !== stage.revision ||
    parameters.stage.sequence !== stage.sequence ||
    parameters.stage.kind !== stage.kind ||
    parameters.stage.digest !== stage.stageDigest
  ) {
    throw new Error("Canonical WorkUnit stage identity does not match the exact stage revision");
  }
  return { parameters, bindingDigest: digest };
}

export { assertCanonicalIdentity, assertExecutionBinding };
