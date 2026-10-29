import {
  assertAtomMapDigest,
  computeAtomMapDigest,
  type AtomMap,
  type AtomMapEntry,
} from "@eigengrid/scientific-schema";
import { z } from "zod";
import { sha256Canonical } from "./canonical";
import { Sha256Schema } from "./contracts";

export const AMBER_ATOM_MAP_VIEW_SCHEMA_VERSION = "eigengrid.amber-atom-map-view/v1" as const;
export const AMBER_ATOM_MAP_VIEW_VERSION = "1.0.0" as const;

const IdSchema = z.string().min(1).max(256);

export const AmberAtomMapViewEntrySchema = z
  .object({
    topologyIndex: z.number().int().positive(),
    systemAtomIndex: z.number().int().positive(),
    componentId: IdSchema,
    componentAtomIndex: z.number().int().positive(),
    chainId: z.string().min(1).max(8).optional(),
    residueIndex: z.number().int(),
    residueName: z.string().min(1).max(8),
    atomName: z.string().min(1).max(8),
    element: z.string().regex(/^[A-Z][a-z]?$/u),
  })
  .strict();
export type AmberAtomMapViewEntry = z.infer<typeof AmberAtomMapViewEntrySchema>;

export const AmberAtomMapViewSchema = z
  .object({
    schemaVersion: z.literal(AMBER_ATOM_MAP_VIEW_SCHEMA_VERSION),
    viewVersion: z.literal(AMBER_ATOM_MAP_VIEW_VERSION),
    canonicalAtomMap: z
      .object({
        id: IdSchema,
        revision: z.number().int().positive(),
        mapDigest: Sha256Schema,
      })
      .strict(),
    systemManifestId: IdSchema,
    systemManifestRevision: z.number().int().positive(),
    topologyDigest: Sha256Schema,
    coordinateDigest: Sha256Schema,
    atomCount: z.number().int().positive(),
    entries: z.array(AmberAtomMapViewEntrySchema).min(1),
    viewDigest: Sha256Schema,
  })
  .strict()
  .superRefine((view, context) => {
    if (view.entries.length !== view.atomCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["atomCount"],
        message: "AMBER atom-map view must preserve complete canonical coverage",
      });
    }
    for (const [index, entry] of view.entries.entries()) {
      if (entry.topologyIndex !== index + 1 || entry.systemAtomIndex !== entry.topologyIndex) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index, "topologyIndex"],
          message: "AMBER topology indices must round-trip to ordered canonical system indices",
        });
      }
    }
    const componentAtoms = view.entries.map(
      (entry) => `${entry.componentId}\0${entry.componentAtomIndex}`,
    );
    if (new Set(componentAtoms).size !== componentAtoms.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries"],
        message: "AMBER atom-map view cannot duplicate a canonical component atom",
      });
    }
  });
export type AmberAtomMapView = z.infer<typeof AmberAtomMapViewSchema>;

function withoutDigest<T extends object>(value: T, field: keyof T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
}

/** The manifest identity is the canonical AtomMap digest, never an adapter-local digest. */
export const computeCanonicalAtomMapDigest = computeAtomMapDigest;

export function assertCanonicalAtomMapDigest(
  value: unknown,
  expectedManifestAtomMapDigest?: string,
): AtomMap {
  const atomMap = assertAtomMapDigest(value);
  if (atomMap.entries.some((entry, index) => entry.systemAtomIndex !== index + 1)) {
    throw new Error(
      "Canonical AtomMap entries must be ordered by systemAtomIndex for lossless AMBER projection",
    );
  }
  if (
    expectedManifestAtomMapDigest !== undefined &&
    atomMap.mapDigest !== Sha256Schema.parse(expectedManifestAtomMapDigest)
  ) {
    throw new Error("Canonical AtomMap digest does not match the system manifest identity");
  }
  return atomMap;
}

export function computeAmberAtomMapViewDigest(value: object): string {
  return sha256Canonical(withoutDigest(value, "viewDigest" as never));
}

export function canonicalEntriesFromAmberView(value: unknown): AtomMapEntry[] {
  const view = AmberAtomMapViewSchema.parse(value);
  return view.entries.map(({ topologyIndex: _topologyIndex, ...entry }) => entry);
}

export function assertAmberAtomMapView(
  value: unknown,
  expectedManifestAtomMapDigest?: string,
): AmberAtomMapView {
  const view = AmberAtomMapViewSchema.parse(value);
  const observed = computeAmberAtomMapViewDigest(view);
  if (view.viewDigest !== observed) {
    throw new Error(
      `AMBER AtomMap view digest mismatch: expected ${view.viewDigest}, observed ${observed}`,
    );
  }
  if (
    expectedManifestAtomMapDigest !== undefined &&
    view.canonicalAtomMap.mapDigest !== Sha256Schema.parse(expectedManifestAtomMapDigest)
  ) {
    throw new Error("AMBER AtomMap view is not bound to the manifest's canonical AtomMap digest");
  }
  return view;
}

/** Deterministic, lossless AMBER projection of the scientific AtomMap. */
export function deriveAmberAtomMapView(
  atomMapValue: unknown,
  expectedManifestAtomMapDigest: string,
): AmberAtomMapView {
  const atomMap = assertCanonicalAtomMapDigest(atomMapValue, expectedManifestAtomMapDigest);
  const entries = [...atomMap.entries]
    .sort((left, right) => left.systemAtomIndex - right.systemAtomIndex)
    .map((entry) => ({ topologyIndex: entry.systemAtomIndex, ...entry }));
  const base = {
    schemaVersion: AMBER_ATOM_MAP_VIEW_SCHEMA_VERSION,
    viewVersion: AMBER_ATOM_MAP_VIEW_VERSION,
    canonicalAtomMap: {
      id: atomMap.id,
      revision: atomMap.revision,
      mapDigest: atomMap.mapDigest,
    },
    systemManifestId: atomMap.systemManifestId,
    systemManifestRevision: atomMap.systemManifestRevision,
    topologyDigest: atomMap.topologyDigest,
    coordinateDigest: atomMap.coordinateDigest,
    atomCount: atomMap.atomCount,
    entries,
  };
  return assertAmberAtomMapView(
    { ...base, viewDigest: computeAmberAtomMapViewDigest(base) },
    expectedManifestAtomMapDigest,
  );
}
