import { ActorIdentitySchema } from "../schemas";

export const StrictActorIdentitySchema = ActorIdentitySchema.strict();

export const BiomolecularComponentSchemaVersion = "eigengrid.biomolecular-component/v1" as const;

export const LegacyBiomolecularDecisionSchemaVersion =
  "eigengrid.biomolecular-decision/v1" as const;

export const BiomolecularDecisionSchemaVersion = "eigengrid.biomolecular-decision/v2" as const;

export const ForceFieldStackSchemaVersion = "eigengrid.force-field-stack/v1" as const;

export const AtomMapSchemaVersion = "eigengrid.atom-map/v1" as const;

export const BiomolecularSystemManifestSchemaVersion =
  "eigengrid.biomolecular-system-manifest/v1" as const;

export const PublishedBiomolecularSystemManifestSchemaVersion =
  "eigengrid.biomolecular-system-manifest/v2" as const;

export const BiomolecularSystemBuildRequestSchemaVersionV1 =
  "eigengrid.biomolecular-system-build-request/v1" as const;

export const BiomolecularSystemBuildRequestSchemaVersion =
  "eigengrid.biomolecular-system-build-request/v2" as const;

export const BiomolecularSystemBuildWorkUnitBindingSchemaVersion =
  "eigengrid.biomolecular-system-build-work-unit-binding/v1" as const;

export const BiomolecularMaterialPublicationBindingSchemaVersion =
  "eigengrid.biomolecular-material-publication-binding/v1" as const;

export const ForceFieldStackPublicationRequestSchemaVersionV1 =
  "eigengrid.force-field-stack-publication-request/v1" as const;

export const ForceFieldStackPublicationRequestSchemaVersion =
  "eigengrid.force-field-stack-publication-request/v2" as const;

export const AtomMapPublicationRequestSchemaVersionV1 =
  "eigengrid.atom-map-publication-request/v1" as const;

export const AtomMapPublicationRequestSchemaVersion =
  "eigengrid.atom-map-publication-request/v2" as const;

export const UniqueIds = <T extends { id: string }>(items: T[]): boolean =>
  new Set(items.map((item) => item.id)).size === items.length;
