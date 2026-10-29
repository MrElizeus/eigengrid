import { describe, expect, test } from "bun:test";
import { computeAtomMapDigest } from "@eigengrid/scientific-schema";
import { deriveAmberAtomMapView } from "./atom-map";
import { runFakeAmberVertical } from "./fake-engine";
import { validateAmberTopology } from "./validation";

function fixture() {
  const engine = runFakeAmberVertical().engine;
  const prmtop = engine.getArtifact("outputs/system.prmtop"),
    rst = engine.getArtifact("outputs/stages/heating.rst7");
  const b = {
    schemaVersion: "eigengrid.atom-map/v1" as const,
    id: "adapter-validator-map",
    revision: 1,
    systemManifestId: "fake-system",
    systemManifestRevision: 1,
    indexBase: 1 as const,
    atomCount: 3,
    topologyDigest: prmtop.sha256,
    coordinateDigest: rst.sha256,
    entries: [
      ["receptor", 1, 1, "ALA", "CA", "C"],
      ["ligand", 1, 2, "LIG", "C1", "C"],
      ["ligand", 2, 2, "LIG", "O1", "O"],
    ].map(([componentId, componentAtomIndex, residueIndex, residueName, atomName, element], i) => ({
      systemAtomIndex: i + 1,
      componentId: componentId as string,
      componentAtomIndex: componentAtomIndex as number,
      residueIndex: residueIndex as number,
      residueName: residueName as string,
      atomName: atomName as string,
      element: element as string,
    })),
  };
  const map = { ...b, mapDigest: computeAtomMapDigest(b) };
  return {
    prmtop: prmtop.content,
    rst7: rst.content,
    atomMapView: deriveAmberAtomMapView(map, map.mapDigest),
    expectedCanonicalAtomMapDigest: map.mapDigest,
    requirePeriodicBox: true,
    requireVelocities: true,
  };
}

describe("engine adapter ASCII validation and NPT restart context", () => {
  test("NPT cell evolution is not falsely rejected as an initial topology box mismatch", () => {
    const f = fixture();
    expect(validateAmberTopology(f).valid).toBe(true);
    const changed = { ...f, rst7: f.rst7.replaceAll("40.0000000", "41.0000000") };
    expect(validateAmberTopology(changed).issues.map((i) => i.code)).toContain("box_mismatch");
    const npt = validateAmberTopology({ ...changed, coordinateContext: "npt_restart" });
    expect(npt.valid).toBe(true);
    expect(npt.amberConsumableCertified).toBe(false);
    expect(npt.summary.coordinateBox).toEqual([41, 41, 60, 90, 90, 90]);
  });
  test.each(["NaN", "Infinity", "1e999", "0x10", "BAD", "\0"])(
    "does not silently drop malformed numbers %s",
    (bad) => {
      const f = fixture(),
        r = validateAmberTopology({ ...f, rst7: f.rst7 + ` ${bad} ` });
      expect(r.valid).toBe(false);
      expect(r.issues.map((i) => i.code)).toContain("invalid_restart_numbers");
    },
  );
  test("negative time, extra header tokens, duplicate sections and a degenerate cell reject", () => {
    const f = fixture();
    for (const rst7 of [
      f.rst7.replace("  0.0000000", " -1.0000000"),
      f.rst7.replace("  0.0000000", " 0 extra"),
      f.rst7.replaceAll("90.0000000", "180.0000000"),
    ])
      expect(validateAmberTopology({ ...f, rst7 }).valid).toBe(false);
    expect(
      validateAmberTopology({
        ...f,
        prmtop: f.prmtop + "\n%FLAG MASS\n%FORMAT(5E16.8)\n",
      }).issues.map((i) => i.code),
    ).toContain("duplicate_topology_section");
    expect(() => validateAmberTopology({ ...f, coordinateContext: "anything" } as never)).toThrow();
  });
  test("NPT mode cannot turn a coordinate-only or truncated file into a continuation", () => {
    const f = fixture(),
      coords = runFakeAmberVertical().engine.getArtifact("outputs/system.rst7").content;
    expect(
      validateAmberTopology({ ...f, rst7: coords, coordinateContext: "npt_restart" }).issues.map(
        (i) => i.code,
      ),
    ).toContain("incomplete_npt_restart");
    expect(
      validateAmberTopology({ ...f, rst7: f.rst7.slice(0, -40), coordinateContext: "npt_restart" })
        .valid,
    ).toBe(false);
  });
});
