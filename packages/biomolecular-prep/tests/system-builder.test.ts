import { describe, expect, test } from "bun:test";
import { AtomMapSchemaVersion, computeAtomMapDigest } from "@eigengrid/scientific-schema";
import {
  DeterministicSystemBuilder,
  InvalidSystemAssemblyError,
  type SystemAssemblyInput,
} from "../src/index";

function validAssembly(): SystemAssemblyInput {
  const topologyDigest = "a".repeat(64);
  const coordinateDigest = "b".repeat(64);
  const atomMapBase = {
    schemaVersion: AtomMapSchemaVersion,
    id: "atom-map-synthetic-1",
    revision: 1,
    systemManifestId: "synthetic-system",
    systemManifestRevision: 1,
    indexBase: 1 as const,
    atomCount: 2,
    topologyDigest,
    coordinateDigest,
    entries: [
      {
        systemAtomIndex: 1,
        componentId: "receptor",
        componentAtomIndex: 1,
        chainId: "A",
        residueIndex: 1,
        residueName: "ALA",
        atomName: "CA",
        element: "C",
      },
      {
        systemAtomIndex: 2,
        componentId: "ligand",
        componentAtomIndex: 1,
        chainId: "L",
        residueIndex: 1,
        residueName: "LIG",
        atomName: "N1",
        element: "N",
      },
    ],
    mapDigest: "0".repeat(64),
  };
  return {
    systemId: "synthetic-system",
    revision: 1,
    topologyDigest,
    coordinateDigest,
    components: [
      { componentId: "receptor", kind: "protein", moleculeCount: 1, declaredNetCharge: 0.25 },
      { componentId: "ligand", kind: "ligand", moleculeCount: 1, declaredNetCharge: -0.25 },
    ],
    atoms: [
      {
        atomId: "receptor:1",
        componentId: "receptor",
        componentAtomIndex: 1,
        chainId: "A",
        residueIndex: 1,
        residueName: "ALA",
        atomName: "CA",
        residueId: "A:1",
        element: "C",
        charge: 0.25,
        positionAngstrom: [1, 1, 1],
      },
      {
        atomId: "ligand:1",
        componentId: "ligand",
        componentAtomIndex: 1,
        chainId: "L",
        residueIndex: 1,
        residueName: "LIG",
        atomName: "N1",
        residueId: "L:1",
        element: "N",
        charge: -0.25,
        positionAngstrom: [3, 3, 3],
      },
    ],
    atomMap: { ...atomMapBase, mapDigest: computeAtomMapDigest(atomMapBase) },
    box: {
      vectorsAngstrom: [
        [10, 0, 0],
        [0, 10, 0],
        [0, 0, 10],
      ],
    },
    expectedTotalCharge: 0,
    expectedComposition: [
      { kind: "protein", moleculeCount: 1 },
      { kind: "ligand", moleculeCount: 1 },
    ],
  };
}

describe("deterministic biomolecular system builder", () => {
  test("validates charge, composition, box, atom map and exhaustive overlap checks", () => {
    const builder = new DeterministicSystemBuilder();
    const validation = builder.validate(validAssembly());

    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(validation.metrics).toMatchObject({
      atomCount: 2,
      componentCount: 2,
      totalCharge: 0,
      boxVolumeAngstrom3: 1000,
      pairChecks: 1,
    });
    expect(builder.build(validAssembly()).validation.valid).toBe(true);
  });

  test("detects periodic overlap across a box boundary", () => {
    const input = validAssembly();
    const validation = new DeterministicSystemBuilder().validate({
      ...input,
      atoms: [
        { ...input.atoms[0]!, positionAngstrom: [0.1, 1, 1] },
        { ...input.atoms[1]!, positionAngstrom: [9.9, 1, 1] },
      ],
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors.map((error) => error.code)).toContain("atom_overlap");
    expect(validation.overlaps[0]?.distanceAngstrom).toBeCloseTo(0.2);
  });

  test("fails closed for charge, composition, atom-map and box inconsistencies", () => {
    const input = validAssembly();
    const brokenAtomMapBase = {
      ...input.atomMap,
      atomCount: 1,
      entries: [
        {
          ...input.atomMap.entries[0]!,
          componentId: "ligand",
          componentAtomIndex: 1,
          atomName: "N1",
        },
      ],
      mapDigest: "0".repeat(64),
    };
    const broken: SystemAssemblyInput = {
      ...input,
      expectedTotalCharge: 1,
      expectedComposition: [{ kind: "protein", moleculeCount: 2 }],
      atomMap: {
        ...brokenAtomMapBase,
        mapDigest: computeAtomMapDigest(brokenAtomMapBase),
      },
      atoms: [input.atoms[0]!, { ...input.atoms[1]!, positionAngstrom: [11, 3, 3] }],
    };
    const builder = new DeterministicSystemBuilder();
    const validation = builder.validate(broken);
    const codes = new Set(validation.errors.map((error) => error.code));

    expect(codes).toContain("total_charge_mismatch");
    expect(codes).toContain("composition_mismatch");
    expect(codes).toContain("atom_map_length_mismatch");
    expect(codes).toContain("atom_map_component_mismatch");
    expect(codes).toContain("atom_map_atom_identity_mismatch");
    expect(codes).toContain("atom_map_index_not_contiguous");
    expect(codes).toContain("atom_outside_box");
    expect(() => builder.build(broken)).toThrow(InvalidSystemAssemblyError);
  });

  test("rejects a tampered canonical AtomMap digest and assembly identity", () => {
    const input = validAssembly();
    const validation = new DeterministicSystemBuilder().validate({
      ...input,
      topologyDigest: "c".repeat(64),
      atomMap: { ...input.atomMap, mapDigest: "d".repeat(64) },
    });
    const codes = validation.errors.map((error) => error.code);
    expect(codes).toContain("atom_map_digest_mismatch");
    expect(codes).toContain("atom_map_system_mismatch");
  });

  test("does not silently skip an overlap scan above the explicit pair budget", () => {
    const validation = new DeterministicSystemBuilder().validate(validAssembly(), {
      maximumPairChecks: 0,
    });
    expect(validation.valid).toBe(false);
    expect(validation.errors.map((error) => error.code)).toContain("overlap_pair_limit_exceeded");
    expect(validation.metrics.pairChecks).toBe(0);
  });
});
