import { z } from "zod";
import {
  DigestSchema,
  EngineBuildIdentitySchema,
  MdEnsembleSchema,
  MdProtocolSchemaVersion,
  MdStageKindSchema,
  MdStageSchemaVersion,
  ScientificCapabilityIdSchema,
  SemverSchema,
  assertAtomMapDigest,
  assertMdStageSpecDigest,
  assertPublishedBiomolecularSystemManifestDigest,
  digestCanonical,
  type AtomMap,
  type MdStageSpec,
  type PublishedBiomolecularSystemManifest,
} from "@eigengrid/scientific-schema";
import { snapshotProtocolData } from "./data";

export const MdAdapterDescriptorVersion = "eigengrid.md-adapter-descriptor/v1" as const;
export const MdRenderRequestVersion = "eigengrid.md-render-request/v1" as const;

/** One complete combination; independent feature lists would admit untested cross-products. */
export const MdControlTupleSchema = z
  .object({
    stageKind: MdStageKindSchema,
    systemClass: z.enum(["soluble", "membrane"]),
    ensemble: MdEnsembleSchema,
    timeStepPs: z.number().finite().positive().nullable(),
    thermostat: z.enum(["none", "langevin", "berendsen", "nose_hoover", "velocity_rescale"]),
    barostat: z.enum(["none", "berendsen", "monte_carlo", "parrinello_rahman", "c_rescale"]),
    pressureCoupling: z.enum(["none", "isotropic", "semiisotropic", "anisotropic"]),
    bondsToHydrogen: z.boolean(),
    restraints: z.array(z.enum(["positional", "distance", "angle", "dihedral"])).max(4),
    electrostatics: z.enum(["pme", "reaction_field", "direct"]),
    seedPolicy: z.enum(["fixed", "derived", "replica_segment"]).nullable(),
  })
  .strict()
  .superRefine((tuple, ctx) => {
    if (tuple.restraints.some((kind, index) => index > 0 && kind <= tuple.restraints[index - 1]!)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["restraints"],
        message: "Restraint kinds must be sorted and unique",
      });
    }
    if (
      (tuple.barostat === "none") !== (tuple.pressureCoupling === "none") ||
      (tuple.ensemble === "npt") !== (tuple.barostat !== "none")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["barostat"],
        message: "Pressure control must match the ensemble",
      });
    }
    if (
      tuple.stageKind === "minimization" &&
      (tuple.ensemble !== "none" ||
        tuple.timeStepPs !== null ||
        tuple.seedPolicy !== null ||
        tuple.thermostat !== "none")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stageKind"],
        message: "Minimization cannot declare dynamics",
      });
    }
    if (
      tuple.stageKind !== "minimization" &&
      (tuple.ensemble === "none" || tuple.timeStepPs === null || tuple.seedPolicy === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stageKind"],
        message: "Dynamics require time, ensemble and seed controls",
      });
    }
  });
export type MdControlTuple = z.infer<typeof MdControlTupleSchema>;

/** Render capability, never an execution grant or evidence of scientific qualification. */
export const MdAdapterDescriptorSchema = z
  .object({
    schemaVersion: z.literal(MdAdapterDescriptorVersion),
    adapterId: ScientificCapabilityIdSchema,
    adapterVersion: SemverSchema,
    engine: EngineBuildIdentitySchema.refine(
      (engine) => /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(engine.executable),
      {
        path: ["executable"],
        message: "Engine identity is a symbolic name, not a path or command",
      },
    ),
    protocolSchemaVersion: z.literal(MdProtocolSchemaVersion),
    stageSchemaVersion: z.literal(MdStageSchemaVersion),
    rendererCompatibilityVersions: z.array(SemverSchema).min(1).max(32),
    controlTuples: z.array(MdControlTupleSchema).min(1).max(256),
    maximumAtomCount: z.number().int().positive().max(10_000_000),
    descriptorDigest: DigestSchema,
  })
  .strict()
  .superRefine((profile, ctx) => {
    const digests = profile.controlTuples.map((tuple) => digestCanonical(tuple));
    if (
      new Set(digests).size !== digests.length ||
      new Set(profile.rendererCompatibilityVersions).size !==
        profile.rendererCompatibilityVersions.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["controlTuples"],
        message: "Descriptor capabilities must be unique",
      });
    }
  });
export type MdAdapterDescriptor = z.infer<typeof MdAdapterDescriptorSchema>;

export type MdRenderContractErrorCode =
  | "INVALID_RENDER_INPUT"
  | "DESCRIPTOR_DIGEST_MISMATCH"
  | "ENGINE_MISMATCH"
  | "UNSUPPORTED_CONTROLS"
  | "MATERIAL_MISMATCH"
  | "UNRESOLVED_SELECTION"
  | "REQUEST_DIGEST_MISMATCH";
export class MdRenderContractError extends Error {
  readonly name = "MdRenderContractError";
  constructor(
    readonly code: MdRenderContractErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function computeMdAdapterDescriptorDigest(
  value: Omit<MdAdapterDescriptor, "descriptorDigest"> | MdAdapterDescriptor,
): string {
  const { descriptorDigest: _digest, ...fields } = value as MdAdapterDescriptor;
  return digestCanonical(fields);
}

export function assertMdAdapterDescriptor(value: unknown): MdAdapterDescriptor {
  let descriptor: MdAdapterDescriptor;
  try {
    descriptor = MdAdapterDescriptorSchema.parse(snapshotProtocolData(value));
  } catch {
    throw new MdRenderContractError("INVALID_RENDER_INPUT", "Invalid adapter descriptor");
  }
  if (computeMdAdapterDescriptorDigest(descriptor) !== descriptor.descriptorDigest) {
    throw new MdRenderContractError(
      "DESCRIPTOR_DIGEST_MISMATCH",
      "Adapter descriptor content changed",
    );
  }
  return descriptor;
}

/** Extract only standard semantic controls; there is no raw keyword escape hatch. */
export function mdControlTuple(stageValue: unknown): MdControlTuple {
  const stage = assertMdStageSpecDigest(snapshotProtocolData(stageValue));
  return MdControlTupleSchema.parse({
    stageKind: stage.kind,
    systemClass: stage.system.systemClass,
    ensemble: stage.ensemble,
    timeStepPs: stage.timeStepPs,
    thermostat: stage.thermostat.kind,
    barostat: stage.barostat.kind,
    pressureCoupling: stage.barostat.kind === "none" ? "none" : stage.barostat.coupling,
    bondsToHydrogen: stage.constraints.bondsToHydrogen,
    restraints: [...new Set(stage.restraints.map((restraint) => restraint.kind))].sort(),
    electrostatics: stage.nonbonded.electrostatics,
    seedPolicy: stage.randomSeed?.policy ?? null,
  });
}

export interface MdRenderRequestInput {
  readonly stage: MdStageSpec;
  readonly system: PublishedBiomolecularSystemManifest;
  readonly atomMap: AtomMap;
  readonly descriptor: MdAdapterDescriptor;
  /** Exact engine attested by the caller's reviewed environment, not chosen by the adapter. */
  readonly expectedEngine: MdAdapterDescriptor["engine"];
}
export interface MdRenderRequest extends MdRenderRequestInput {
  readonly schemaVersion: typeof MdRenderRequestVersion;
  readonly controlTupleDigest: string;
  readonly requestDigest: string;
  readonly qualification: "render_only_not_authorized";
}

/**
 * Validate and bind material for a registered pure renderer. Does not select a backend,
 * validate authority freshness, execute an engine, or certify generated files/physics.
 */
export function prepareMdRenderRequest(input: MdRenderRequestInput): MdRenderRequest {
  let value: MdRenderRequestInput;
  let stage: MdStageSpec;
  let system: PublishedBiomolecularSystemManifest;
  let atomMap: AtomMap;
  try {
    value = snapshotProtocolData(input);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some(
        (key) => !["stage", "system", "atomMap", "descriptor", "expectedEngine"].includes(key),
      )
    ) {
      throw new TypeError("Unexpected render input fields");
    }
    stage = assertMdStageSpecDigest(value.stage);
    system = assertPublishedBiomolecularSystemManifestDigest(value.system);
    atomMap = assertAtomMapDigest(value.atomMap);
    EngineBuildIdentitySchema.parse(value.expectedEngine);
  } catch {
    throw new MdRenderContractError(
      "INVALID_RENDER_INPUT",
      "Invalid stage, system, atom map or environment",
    );
  }
  const descriptor = assertMdAdapterDescriptor(value.descriptor);
  if (digestCanonical(descriptor.engine) !== digestCanonical(value.expectedEngine)) {
    throw new MdRenderContractError(
      "ENGINE_MISMATCH",
      "Descriptor targets a different exact engine build",
    );
  }
  const expectedSystem = {
    id: system.id,
    revision: system.revision,
    systemClass: system.membrane === null ? "soluble" : "membrane",
    manifestDigest: system.manifestDigest,
    topologyDigest: system.topologyDigest,
    coordinateDigest: system.coordinateDigest,
    atomMapDigest: system.atomMapDigest,
  };
  if (
    digestCanonical(stage.system) !== digestCanonical(expectedSystem) ||
    atomMap.systemManifestId !== system.id ||
    atomMap.systemManifestRevision !== system.revision ||
    atomMap.topologyDigest !== system.topologyDigest ||
    atomMap.coordinateDigest !== system.coordinateDigest ||
    atomMap.mapDigest !== system.atomMapDigest ||
    atomMap.atomCount !== system.atomCount
  ) {
    throw new MdRenderContractError(
      "MATERIAL_MISMATCH",
      "Stage, manifest and atom map must identify the same material",
    );
  }
  const components = Object.values(system.components).flat();
  const counts = new Map(components.map((component) => [component.id, component.atomCount]));
  const observedCounts = new Map<string, number>();
  for (const entry of atomMap.entries) {
    observedCounts.set(entry.componentId, (observedCounts.get(entry.componentId) ?? 0) + 1);
  }
  if (
    observedCounts.size !== counts.size ||
    [...observedCounts].some(([id, count]) => counts.get(id) !== count)
  ) {
    throw new MdRenderContractError(
      "MATERIAL_MISMATCH",
      "Atom-map components differ from the manifest",
    );
  }
  for (const restraint of stage.restraints) {
    for (const selection of restraint.selections) {
      if (
        !selection.atomIndices ||
        selection.atomIndices.some((index) => index > atomMap.atomCount)
      ) {
        throw new MdRenderContractError(
          "UNRESOLVED_SELECTION",
          "Rendering needs explicit, in-range atom-map selections",
        );
      }
    }
  }
  const tuple = mdControlTuple(stage);
  const controlTupleDigest = digestCanonical(tuple);
  if (
    system.atomCount > descriptor.maximumAtomCount ||
    !descriptor.rendererCompatibilityVersions.includes(stage.rendererCompatibilityVersion) ||
    !descriptor.controlTuples.some((supported) => digestCanonical(supported) === controlTupleDigest)
  ) {
    throw new MdRenderContractError(
      "UNSUPPORTED_CONTROLS",
      "Exact stage-control combination is not declared renderable",
    );
  }
  const fields = {
    schemaVersion: MdRenderRequestVersion,
    stage,
    system,
    atomMap,
    descriptor,
    expectedEngine: value.expectedEngine,
    controlTupleDigest,
    qualification: "render_only_not_authorized" as const,
  };
  return { ...fields, requestDigest: digestCanonical(fields) };
}

/**
 * Revalidate a serialized request at a renderer boundary against its registered
 * descriptor. A matching self-digest is integrity only, never an execution grant.
 */
export function assertMdRenderRequest(
  value: unknown,
  registeredDescriptor: MdAdapterDescriptor,
): MdRenderRequest {
  let record: MdRenderRequest;
  try {
    record = snapshotProtocolData(value) as MdRenderRequest;
    const fields = [
      "stage",
      "system",
      "atomMap",
      "descriptor",
      "expectedEngine",
      "schemaVersion",
      "controlTupleDigest",
      "requestDigest",
      "qualification",
    ];
    if (
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      Object.keys(record).length !== fields.length ||
      Object.keys(record).some((key) => !fields.includes(key)) ||
      record.schemaVersion !== MdRenderRequestVersion ||
      record.qualification !== "render_only_not_authorized"
    ) {
      throw new TypeError("Invalid serialized rendering request");
    }
    DigestSchema.parse(record.requestDigest);
    DigestSchema.parse(record.controlTupleDigest);
  } catch {
    throw new MdRenderContractError("INVALID_RENDER_INPUT", "Invalid rendering request envelope");
  }
  const descriptor = assertMdAdapterDescriptor(registeredDescriptor);
  const suppliedDescriptor = assertMdAdapterDescriptor(record.descriptor);
  if (descriptor.descriptorDigest !== suppliedDescriptor.descriptorDigest) {
    throw new MdRenderContractError(
      "ENGINE_MISMATCH",
      "Request is not for the registered renderer descriptor",
    );
  }
  const rebuilt = prepareMdRenderRequest({
    stage: record.stage,
    system: record.system,
    atomMap: record.atomMap,
    descriptor,
    expectedEngine: record.expectedEngine,
  });
  if (
    rebuilt.requestDigest !== record.requestDigest ||
    rebuilt.controlTupleDigest !== record.controlTupleDigest
  ) {
    throw new MdRenderContractError("REQUEST_DIGEST_MISMATCH", "Rendering request content changed");
  }
  return rebuilt;
}

/** engine adapter implements this port with its own closed output schema; mission runtime owns materialization/effects. */
export interface MdStageRendererPort<Output> {
  readonly descriptor: MdAdapterDescriptor;
  /** Pure translation only. Call assertMdRenderRequest against this.descriptor; reject unsupported adapter-specific mappings. */
  render(request: Readonly<MdRenderRequest>): Output;
  parseOutput(value: unknown): Output;
}
