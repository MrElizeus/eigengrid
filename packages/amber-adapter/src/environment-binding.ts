import {
  MdEnvironmentCapabilitySnapshotSchema,
  assertMdEnvironmentCapabilitySnapshotDigest,
  computeMdEnvironmentCapabilitySnapshotDigest,
  type MdEnvironmentCapabilitySnapshot,
} from "@eigengrid/scientific-schema";
import { z } from "zod";
import { sha256Canonical } from "./canonical";
import { AmberExecutableSchema, Sha256Schema, type AmberExecutable } from "./contracts";
import { AmberEnvironmentManifestSchema, assertAmberEnvironmentManifest } from "./environment";

export const AMBER_ENVIRONMENT_BINDING_SCHEMA_VERSION =
  "eigengrid.amber-environment-binding/v1" as const;
export const AMBER_ENVIRONMENT_BINDING_VERSION = "1.0.0" as const;

export const CanonicalMdEnvironmentCapabilitySnapshotSchema = MdEnvironmentCapabilitySnapshotSchema;
export type CanonicalMdEnvironmentCapabilitySnapshot = MdEnvironmentCapabilitySnapshot;

export const AmberEnvironmentBindingSchema = z
  .object({
    schemaVersion: z.literal(AMBER_ENVIRONMENT_BINDING_SCHEMA_VERSION),
    bindingVersion: z.literal(AMBER_ENVIRONMENT_BINDING_VERSION),
    canonicalSnapshot: CanonicalMdEnvironmentCapabilitySnapshotSchema,
    adapterEnvironment: AmberEnvironmentManifestSchema,
    executable: AmberExecutableSchema,
    bindingDigest: Sha256Schema,
  })
  .strict();
export type AmberEnvironmentBinding = z.infer<typeof AmberEnvironmentBindingSchema>;

function withoutField(value: object, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
}

export const computeCanonicalMdEnvironmentDigest = computeMdEnvironmentCapabilitySnapshotDigest;

export function computeAmberEnvironmentBindingDigest(value: object): string {
  return sha256Canonical(withoutField(value, "bindingDigest"));
}

export function assertAmberEnvironmentBinding(value: unknown): AmberEnvironmentBinding {
  const binding = AmberEnvironmentBindingSchema.parse(value);
  const snapshot = assertMdEnvironmentCapabilitySnapshotDigest(binding.canonicalSnapshot);
  const environment = assertAmberEnvironmentManifest(binding.adapterEnvironment);
  if (snapshot.engine.engine.toLowerCase() !== "amber") {
    throw new Error("Canonical environment binding is not an AMBER engine snapshot");
  }
  if (snapshot.targetCompatibility.family !== "amber") {
    throw new Error("Canonical environment target compatibility is not AMBER");
  }
  if (snapshot.engine.executable !== binding.executable) {
    throw new Error("Canonical engine executable does not match the AMBER binding executable");
  }
  if (snapshot.engine.environmentDigest !== environment.environmentDigest) {
    throw new Error("Canonical engine identity does not bind the adapter environment digest");
  }
  const observation = environment.observations.find(
    (candidate) => candidate.executable === binding.executable,
  );
  if (
    !observation?.available ||
    observation.binarySha256 === undefined ||
    observation.version === undefined
  ) {
    throw new Error(
      `AMBER executable ${binding.executable} is not available in the bound environment`,
    );
  }
  if (
    snapshot.engine.buildDigest !== observation.binarySha256 ||
    snapshot.engine.version !== observation.version
  ) {
    throw new Error("Canonical engine build identity does not match the observed AMBER binary");
  }
  if (binding.executable === "pmemd.cuda" && observation.gpu !== true) {
    throw new Error("The bound pmemd.cuda environment has no usable GPU observation");
  }
  const observedBindingDigest = computeAmberEnvironmentBindingDigest(binding);
  if (binding.bindingDigest !== observedBindingDigest) {
    throw new Error(
      `AMBER environment binding digest mismatch: expected ${binding.bindingDigest}, observed ${observedBindingDigest}`,
    );
  }
  return binding;
}

export function createAmberEnvironmentBinding(
  snapshotValue: unknown,
  adapterEnvironmentValue: unknown,
  executableValue: AmberExecutable,
): AmberEnvironmentBinding {
  const snapshot = assertMdEnvironmentCapabilitySnapshotDigest(snapshotValue);
  const adapterEnvironment = assertAmberEnvironmentManifest(adapterEnvironmentValue);
  const executable = AmberExecutableSchema.parse(executableValue);
  const base = {
    schemaVersion: AMBER_ENVIRONMENT_BINDING_SCHEMA_VERSION,
    bindingVersion: AMBER_ENVIRONMENT_BINDING_VERSION,
    canonicalSnapshot: snapshot,
    adapterEnvironment,
    executable,
  };
  return assertAmberEnvironmentBinding({
    ...base,
    bindingDigest: computeAmberEnvironmentBindingDigest(base),
  });
}
