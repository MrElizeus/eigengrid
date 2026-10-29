import {
  MdArtifactReferenceSchema,
  MdArtifactRoleSchema,
  MdExecutionBindingParametersSchema,
  MdOutputContractSchema,
  type MdAcceptanceCriterion,
  type MdArtifactReference,
  type MdCheckpointSpec,
  type MdExecutionBindingParameters,
  type MdOutputContract,
  type MdResourceProfile,
  type MdStageSpec as CanonicalMdStageSpec,
} from "@eigengrid/scientific-schema";
import { z } from "zod";
import {
  AMBER_ATOM_MAP_VIEW_VERSION,
  AmberAtomMapViewSchema,
  type AmberAtomMapView,
} from "../atom-map";
import { CommandSpecSchema, LogicalPathSchema, Sha256Schema, type CommandSpec } from "../contracts";
import { AmberEnvironmentBindingSchema } from "../environment-binding";
import { RenderedMdinSchema, type RenderedMdin } from "../mdin";
import { AmberMdEngineSchema } from "../stage";

export const AMBER_CANONICAL_STAGE_MAPPING_SCHEMA_VERSION =
  "eigengrid.amber-canonical-stage-mapping/v3" as const;
export const AMBER_CANONICAL_STAGE_RENDER_SCHEMA_VERSION =
  "eigengrid.amber-canonical-stage-render/v3" as const;
export const AMBER_CANONICAL_STAGE_MAPPING_VERSION = "3.0.0" as const;
export const AMBER_STAGE_OUTPUT_ROLE_MAPPING_VERSION = "1.0.0" as const;

/** Material mappings unavailable until their exact approved payload is durably queryable. */
export const AMBER_CANONICAL_MAPPING_LIMITATIONS = Object.freeze({
  minimizationSplit: "requires_explicit_canonical_minimization_controls" as const,
  restraintMask: "requires_explicit_digest_bound_canonical_atom_indices" as const,
  membraneSurfaceTension: "unsupported_without_typed_approved_payload" as const,
  cpuPmemd: "unsupported_cpu_engine_selection_defaults_to_sander" as const,
});

const IdSchema = z.string().min(1).max(256);

export const AmberMappingDecisionBindingSchema = z
  .object({
    id: IdSchema,
    revision: z.number().int().positive(),
    decisionDigest: Sha256Schema,
    approvalRef: IdSchema,
  })
  .strict();
export type AmberMappingDecisionBinding = z.infer<typeof AmberMappingDecisionBindingSchema>;

const CanonicalStageBindingSchema = z
  .object({
    id: IdSchema,
    revision: z.number().int().positive(),
    kind: z.enum(["minimization", "heating", "equilibration", "production"]),
    stageDigest: Sha256Schema,
    rendererCompatibilityVersion: z.literal(AMBER_CANONICAL_STAGE_MAPPING_VERSION),
  })
  .strict();

const MdExecutionBindingObjectSchema = MdExecutionBindingParametersSchema.innerType();
const MdReplicaSegmentBindingSchema = MdExecutionBindingObjectSchema.shape.replicaSegment.unwrap();
const CanonicalWorkUnitBindingSchema = z
  .object({
    bindingDigest: Sha256Schema,
    plan: MdExecutionBindingObjectSchema.shape.plan,
    system: MdExecutionBindingObjectSchema.shape.system,
    protocol: MdExecutionBindingObjectSchema.shape.protocol,
  })
  .strict();

const InputPathBindingSchema = z
  .object({
    artifactId: IdSchema,
    role: z.enum(["topology", "coordinates", "parent_restart"]),
    contentDigest: Sha256Schema,
    logicalPath: LogicalPathSchema,
  })
  .strict();

const OutputPathBindingSchema = z
  .object({
    role: z.enum(["restart", "trajectory", "mdout", "mdinfo"]),
    logicalPath: LogicalPathSchema,
  })
  .strict();

const ArtifactPathBindingsSchema = z
  .object({
    cwd: LogicalPathSchema,
    mdin: LogicalPathSchema.refine((path) => path.toLowerCase().endsWith(".mdin"), {
      message: "The rendered stage input must use the .mdin extension",
    }),
    inputs: z.array(InputPathBindingSchema).length(2),
    outputs: z.array(OutputPathBindingSchema).min(3).max(4),
    referenceArtifactId: IdSchema.nullable(),
  })
  .strict();

const RestartMappingSchema = z
  .object({
    format: z.enum(["formatted", "netcdf"]),
  })
  .strict();

const MinimizationSplitMappingSchema = z
  .object({
    algorithm: z.literal("steepest_descent_then_conjugate_gradient"),
    steepestDescentCycles: z.number().int().nonnegative(),
    decision: AmberMappingDecisionBindingSchema,
  })
  .strict();

const RestraintMaskMappingSchema = z
  .object({
    restraintId: IdSchema,
    selectionId: IdSchema,
    selectionDefinitionDigest: Sha256Schema,
    amberMask: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_:,@*?+!()&|=.-]+$/, "Unsupported or unsafe AMBER mask syntax"),
    decision: AmberMappingDecisionBindingSchema,
  })
  .strict();

const MembranePressureMappingSchema = z
  .object({
    mode: z.literal("constant_surface_tension"),
    algorithm: z.literal("berendsen"),
    targetPressureBar: z.number().finite().positive(),
    pressureRelaxationPs: z.number().finite().positive(),
    surfaceOrientation: z.literal("xy"),
    surfaceTensionDynCm: z.number().finite(),
    interfaces: z.literal(2),
    decision: AmberMappingDecisionBindingSchema,
  })
  .strict();

const ConstraintMappingSchema = z.discriminatedUnion("algorithm", [
  z
    .object({
      algorithm: z.literal("none"),
      bondsToHydrogen: z.literal(false),
      tolerance: z.null(),
      maximumIterations: z.null(),
    })
    .strict(),
  z
    .object({
      algorithm: z.literal("shake"),
      bondsToHydrogen: z.literal(true),
      tolerance: z.number().finite().positive(),
      maximumIterations: z.number().int().positive(),
    })
    .strict(),
]);

const PmeElectrostaticsMappingSchema = z
  .object({
    mode: z.literal("amber_pme_dsum_tol"),
    ewaldTolerance: z.number().finite().positive().lt(1),
  })
  .strict();

export const AmberCanonicalStageMappingSchema = z
  .object({
    schemaVersion: z.literal(AMBER_CANONICAL_STAGE_MAPPING_SCHEMA_VERSION),
    mappingVersion: z.literal(AMBER_CANONICAL_STAGE_MAPPING_VERSION),
    canonicalStage: CanonicalStageBindingSchema,
    canonicalWorkUnit: CanonicalWorkUnitBindingSchema,
    canonicalAtomMap: z
      .object({
        id: IdSchema,
        revision: z.number().int().positive(),
        mapDigest: Sha256Schema,
        viewVersion: z.literal(AMBER_ATOM_MAP_VIEW_VERSION),
      })
      .strict(),
    environment: AmberEnvironmentBindingSchema,
    engineSelection: z
      .object({
        engine: AmberMdEngineSchema,
      })
      .strict(),
    restart: RestartMappingSchema,
    pmeElectrostatics: PmeElectrostaticsMappingSchema,
    constraints: ConstraintMappingSchema,
    minimizationSplit: MinimizationSplitMappingSchema.nullable(),
    restraintMasks: z.array(RestraintMaskMappingSchema).max(1),
    membranePressure: MembranePressureMappingSchema.nullable(),
    artifactPaths: ArtifactPathBindingsSchema,
    mappingDigest: Sha256Schema,
  })
  .strict();
export type AmberCanonicalStageMapping = z.infer<typeof AmberCanonicalStageMappingSchema>;

export interface AmberCanonicalRuntimeBindings {
  sequence: number;
  parentStageId: string | null;
  parentRestart: MdArtifactReference | null;
  system: CanonicalMdStageSpec["system"];
  resourceProfile: MdResourceProfile;
  checkpoint: MdCheckpointSpec;
  acceptanceCriteria: MdAcceptanceCriterion[];
  outputs: MdOutputContract[];
  sourceDecisionRefs: string[];
  replicaSegment: NonNullable<MdExecutionBindingParameters["replicaSegment"]> | null;
  atomMapView: AmberAtomMapView;
}

export interface AmberStageOutputRoleBinding {
  engineRole: "stage.restart" | "stage.trajectory" | "stage.mdout" | "stage.mdinfo";
  canonicalRole: "restart" | "trajectory" | "mdout" | "mdinfo";
}

export interface AmberStageOutputRoleMapping {
  version: typeof AMBER_STAGE_OUTPUT_ROLE_MAPPING_VERSION;
  digest: string;
  bindings: AmberStageOutputRoleBinding[];
}

export interface RenderedCanonicalAmberStage {
  schemaVersion: typeof AMBER_CANONICAL_STAGE_RENDER_SCHEMA_VERSION;
  canonicalStage: {
    id: string;
    revision: number;
    kind: CanonicalMdStageSpec["kind"];
    stageDigest: string;
  };
  mapping: {
    version: typeof AMBER_CANONICAL_STAGE_MAPPING_VERSION;
    digest: string;
  };
  executionBindingDigest: string;
  environmentBindingDigest: string;
  renderedMdin: RenderedMdin;
  commandRequest: CommandSpec;
  outputRoleMapping: AmberStageOutputRoleMapping;
  runtimeBindings: AmberCanonicalRuntimeBindings;
  renderDigest: string;
}

export const RenderedCanonicalAmberStageSchema = z
  .object({
    schemaVersion: z.literal(AMBER_CANONICAL_STAGE_RENDER_SCHEMA_VERSION),
    canonicalStage: CanonicalStageBindingSchema.omit({ rendererCompatibilityVersion: true }),
    mapping: z
      .object({
        version: z.literal(AMBER_CANONICAL_STAGE_MAPPING_VERSION),
        digest: Sha256Schema,
      })
      .strict(),
    executionBindingDigest: Sha256Schema,
    environmentBindingDigest: Sha256Schema,
    renderedMdin: RenderedMdinSchema,
    commandRequest: CommandSpecSchema,
    outputRoleMapping: z
      .object({
        version: z.literal(AMBER_STAGE_OUTPUT_ROLE_MAPPING_VERSION),
        digest: Sha256Schema,
        bindings: z.array(
          z
            .object({
              engineRole: z.enum([
                "stage.restart",
                "stage.trajectory",
                "stage.mdout",
                "stage.mdinfo",
              ]),
              canonicalRole: MdArtifactRoleSchema.extract([
                "restart",
                "trajectory",
                "mdout",
                "mdinfo",
              ]),
            })
            .strict(),
        ),
      })
      .strict(),
    runtimeBindings: z
      .object({
        sequence: z.number().int().positive(),
        parentStageId: IdSchema.nullable(),
        parentRestart: MdArtifactReferenceSchema.nullable(),
        system: z.unknown(),
        resourceProfile: z.unknown(),
        checkpoint: z.unknown(),
        acceptanceCriteria: z.array(z.unknown()),
        outputs: z.array(MdOutputContractSchema),
        sourceDecisionRefs: z.array(IdSchema),
        replicaSegment: MdReplicaSegmentBindingSchema.nullable(),
        atomMapView: AmberAtomMapViewSchema,
      })
      .strict(),
    renderDigest: Sha256Schema,
  })
  .strict();
