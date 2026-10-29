import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  computeAmberPilotCandidateDigest,
  computeAtomMapDigest,
  type AtomMapEntry,
} from "@eigengrid/scientific-schema";
import { sha256Bytes } from "./canonical";
import {
  inspectAmberPilotPreparation,
  renderAmberPilotPreparation,
  type AmberPilotPreparationEvidence,
} from "./preparation";

const candidate = JSON.parse(
  readFileSync(
    new URL("../../../examples/amber/ace-ala-nme-explicit-cpu-v1.candidate.json", import.meta.url),
    "utf8",
  ),
);
const options = {
  workspace: "prep",
  environmentDigest: "a".repeat(64),
  parameterLibraryDigest: "b".repeat(64),
};

/** Deliberately synthetic format fixture: never engine or scientific evidence. */
function evidenceFixture(): AmberPilotPreparationEvidence {
  const residues = [
    ["ACE", ["HH31", "CH3", "HH32", "HH33", "C", "O"]],
    ["ALA", ["N", "H", "CA", "HA", "CB", "HB1", "HB2", "HB3", "C", "O"]],
    ["NME", ["N", "H", "CH3", "HH31", "HH32", "HH33"]],
    ["WAT", ["O", "H1", "H2"]],
  ] as const;
  const entries: AtomMapEntry[] = [];
  const pointers: number[] = [];
  for (const [residueIndex, [residueName, atoms]] of residues.entries()) {
    pointers.push(entries.length + 1);
    for (const atomName of atoms)
      entries.push({
        systemAtomIndex: entries.length + 1,
        componentId: "system",
        componentAtomIndex: entries.length + 1,
        residueIndex: residueIndex + 1,
        residueName,
        atomName,
        element: atomName[0] === "H" ? "H" : atomName[0]!,
      });
  }
  const natom = entries.length;
  const flag = (name: string, values: Array<string | number>, text = false) =>
    `%FLAG ${name}\n%FORMAT(${text ? "20a4" : "10I8"})\n${values.map((value) => String(value).padStart(text ? 4 : 8)).join("")}\n`;
  const pointerValues = Array.from({ length: 30 }, () => 0);
  pointerValues[0] = natom;
  pointerValues[27] = 1;
  const prmtop = [
    flag("POINTERS", pointerValues),
    flag(
      "ATOM_NAME",
      entries.map((entry) => entry.atomName),
      true,
    ),
    flag(
      "CHARGE",
      entries.map(() => 0),
    ),
    flag(
      "MASS",
      entries.map(() => 12),
    ),
    flag(
      "ATOM_TYPE_INDEX",
      entries.map(() => 1),
    ),
    flag(
      "NUMBER_EXCLUDED_ATOMS",
      entries.map(() => 0),
    ),
    flag("NONBONDED_PARM_INDEX", [1]),
    flag(
      "RESIDUE_LABEL",
      residues.map(([name]) => name),
      true,
    ),
    flag("RESIDUE_POINTER", pointers),
    flag("BONDS_INC_HYDROGEN", []),
    flag("BONDS_WITHOUT_HYDROGEN", []),
    flag(
      "AMBER_ATOM_TYPE",
      entries.map(() => "CT"),
      true,
    ),
    flag("BOX_DIMENSIONS", [90, 30, 30, 30]),
    flag("SOLVENT_POINTERS", [3, 2, 2]),
    flag("ATOMS_PER_MOLECULE", [22, 3]),
  ].join("");
  const rst7 = `synthetic structural fixture\n${natom}\n${entries.flatMap(() => [1, 2, 3]).join(" ")}\n30 30 30 90 90 90\n`;
  const map = {
    schemaVersion: "eigengrid.atom-map/v1" as const,
    id: "fixture-map",
    revision: 1,
    systemManifestId: "fixture-system",
    systemManifestRevision: 1,
    indexBase: 1 as const,
    atomCount: natom,
    topologyDigest: sha256Bytes(prmtop),
    coordinateDigest: sha256Bytes(rst7),
    entries,
  };
  return {
    prmtop,
    rst7,
    snapshotPdb: "synthetic\n",
    leapLog: "Exiting LEaP: Errors = 0; Warnings = 0; Notes = 0.\n",
    exitCode: 0,
    atomMap: { ...map, mapDigest: computeAtomMapDigest(map) },
  };
}

describe("candidate-bound preparation", () => {
  test("records reproducible lineage without granting approval", () => {
    const first = renderAmberPilotPreparation(candidate, options);
    expect(first).toEqual(renderAmberPilotPreparation(candidate, options));
    expect(first.manifest.candidate.digest).toBe(candidate.candidateDigest);
    expect(first.manifest.executionEligibility).toBe(
      "requires_exact_scientific_and_site_authority",
    );
    expect(first.input.content).toContain("sequence { ACE ALA NME }");
    expect(first.input.content).not.toContain("addIons");
    expect(first.command.inputs).toHaveLength(1);
    expect(
      renderAmberPilotPreparation(candidate, { ...options, parameterLibraryDigest: "c".repeat(64) })
        .manifest.preparationDigest,
    ).not.toBe(first.manifest.preparationDigest);
    const changed = structuredClone(candidate);
    changed.system.solvation.paddingAngstrom += 1;
    expect(() => renderAmberPilotPreparation(changed, options)).toThrow(/digest/i);
    changed.candidateDigest = computeAmberPilotCandidateDigest(changed);
    expect(renderAmberPilotPreparation(changed, options).input.sha256).not.toBe(first.input.sha256);
  });

  test("binds bytes, logs, AtomMap, and declared preparation without certification", () => {
    const result = inspectAmberPilotPreparation(candidate, options, evidenceFixture());
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.amberConsumableCertified).toBe(false);
    expect(result.scientificApprovalGranted).toBe(false);
    expect(result.lineage.preparationDigest).toBe(
      renderAmberPilotPreparation(candidate, options).manifest.preparationDigest,
    );
  });

  test("rejects missing parameters, partial output, warnings, and nonzero exit", () => {
    for (const changed of [
      { leapLog: "Could not find bond parameter for: C - N\nExiting LEaP: Errors = 0" },
      { leapLog: "Loading topology" },
      { leapLog: "WARNING: long bond\nExiting LEaP: Errors = 0" },
      { exitCode: 1 },
    ])
      expect(
        inspectAmberPilotPreparation(candidate, options, { ...evidenceFixture(), ...changed })
          .valid,
      ).toBe(false);
  });

  test("rejects byte substitution and canonical atom order changes", () => {
    const evidence = evidenceFixture();
    expect(() =>
      inspectAmberPilotPreparation(candidate, options, { ...evidence, rst7: `${evidence.rst7} ` }),
    ).toThrow(/exact topology/);
    [evidence.atomMap.entries[0], evidence.atomMap.entries[1]] = [
      evidence.atomMap.entries[1]!,
      evidence.atomMap.entries[0]!,
    ];
    evidence.atomMap.mapDigest = computeAtomMapDigest(evidence.atomMap);
    expect(() => inspectAmberPilotPreparation(candidate, options, evidence)).toThrow(/ordered/);
  });

  test("rejects mismapped atoms, incorrect caps and nonorthorhombic box", () => {
    const evidence = evidenceFixture();
    evidence.atomMap.entries[0]!.atomName = "INVALID";
    evidence.atomMap.mapDigest = computeAtomMapDigest(evidence.atomMap);
    const mismatch = inspectAmberPilotPreparation(candidate, options, evidence);
    expect(mismatch.valid).toBe(false);
    expect(mismatch.issues.some((issue) => issue.code === "pilot_composition_mismatch")).toBe(true);
    const box = evidenceFixture();
    box.rst7 = box.rst7.replace("30 30 30 90 90 90", "30 30 30 90 90 80");
    box.atomMap.coordinateDigest = sha256Bytes(box.rst7);
    box.atomMap.mapDigest = computeAtomMapDigest(box.atomMap);
    expect(
      inspectAmberPilotPreparation(candidate, options, box).issues.some(
        (issue) => issue.code === "pilot_box_shape_mismatch",
      ),
    ).toBe(true);
  });
});
