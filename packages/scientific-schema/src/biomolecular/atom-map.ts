import { z } from "zod";
import { DigestSchema, IdSchema } from "../schemas";
import { AtomMapSchemaVersion } from "./common";
import { canonicalSelfDigest, ScientificSchemaDigestMismatchError } from "./digests";

export const AtomMapEntrySchema = z
  .object({
    systemAtomIndex: z.number().int().positive(),
    componentId: IdSchema,
    componentAtomIndex: z.number().int().positive(),
    chainId: z.string().min(1).max(8).optional(),
    residueIndex: z.number().int(),
    residueName: z.string().min(1).max(8),
    atomName: z.string().min(1).max(8),
    element: z.string().regex(/^[A-Z][a-z]?$/u, "Expected an element symbol"),
  })
  .strict();

export type AtomMapEntry = z.infer<typeof AtomMapEntrySchema>;

export const AtomMapSchema = z
  .object({
    schemaVersion: z.literal(AtomMapSchemaVersion),
    id: IdSchema,
    revision: z.number().int().positive(),
    systemManifestId: IdSchema,
    systemManifestRevision: z.number().int().positive(),
    indexBase: z.literal(1),
    atomCount: z.number().int().positive(),
    topologyDigest: DigestSchema,
    coordinateDigest: DigestSchema,
    entries: z.array(AtomMapEntrySchema).min(1),
    mapDigest: DigestSchema,
  })
  .strict()
  .superRefine((atomMap, context) => {
    if (atomMap.entries.length !== atomMap.atomCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["atomCount"],
        message: "Atom-map count must equal the number of mapping entries",
      });
    }
    const systemIndices = atomMap.entries.map((entry) => entry.systemAtomIndex);
    if (new Set(systemIndices).size !== systemIndices.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries"],
        message: "System atom indices must be unique",
      });
    }
    const sortedIndices = [...systemIndices].sort((left, right) => left - right);
    if (sortedIndices.some((value, index) => value !== index + 1)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries"],
        message: "System atom indices must be contiguous and one-based",
      });
    }
    const componentIndices = atomMap.entries.map(
      (entry) => `${entry.componentId}\u0000${entry.componentAtomIndex}`,
    );
    if (new Set(componentIndices).size !== componentIndices.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries"],
        message: "A component atom may map to only one system atom",
      });
    }
    const indicesByComponent = new Map<string, number[]>();
    for (const entry of atomMap.entries) {
      const indices = indicesByComponent.get(entry.componentId) ?? [];
      indices.push(entry.componentAtomIndex);
      indicesByComponent.set(entry.componentId, indices);
    }
    for (const [componentId, indices] of indicesByComponent) {
      const sorted = [...indices].sort((left, right) => left - right);
      if (sorted.some((value, index) => value !== index + 1)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries"],
          message: `Component ${componentId} atom indices must be contiguous and one-based`,
        });
      }
    }
  });

export type AtomMap = z.infer<typeof AtomMapSchema>;

/** Digests the complete canonical atom mapping except its self-digest. */
export function computeAtomMapDigest(value: object): string {
  return canonicalSelfDigest(value, "mapDigest");
}

/** Validates the sole atom-map identity accepted by preparation and engine adapters. */
export function assertAtomMapDigest(value: unknown): AtomMap {
  const atomMap = AtomMapSchema.parse(value);
  const observedDigest = computeAtomMapDigest(atomMap);
  if (observedDigest !== atomMap.mapDigest) {
    throw new ScientificSchemaDigestMismatchError(
      "AtomMap",
      atomMap.id,
      atomMap.mapDigest,
      observedDigest,
    );
  }
  return atomMap;
}
