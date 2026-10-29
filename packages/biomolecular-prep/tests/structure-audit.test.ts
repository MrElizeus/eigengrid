import { describe, expect, test } from "bun:test";
import { auditStructureText } from "../src/index";

function fixedRecord(fields: readonly [number, string][]): string {
  const characters = Array.from({ length: 80 }, () => " ");
  for (const [offset, value] of fields) {
    for (let index = 0; index < value.length; index += 1)
      characters[offset + index] = value[index]!;
  }
  return characters.join("");
}

function atomRecord(input: {
  record: "ATOM" | "HETATM";
  serial: number;
  atom: string;
  alt?: string;
  residue: string;
  chain: string;
  sequence: number;
  occupancy?: number;
}): string {
  return fixedRecord([
    [0, input.record.padEnd(6)],
    [6, String(input.serial).padStart(5)],
    [12, input.atom.padStart(4)],
    [16, input.alt ?? " "],
    [17, input.residue.padStart(3)],
    [21, input.chain],
    [22, String(input.sequence).padStart(4)],
    [30, "   1.000   1.000   1.000"],
    [54, (input.occupancy ?? 1).toFixed(2).padStart(6)],
  ]);
}

const SYNTHETIC_PDB_FIXTURE = [
  "HEADER    SYNTHETIC TEST FIXTURE                 23-AUG-26   1ABC",
  "COMPND    MOL_ID: 1;",
  "COMPND   2 MOLECULE: SYNTHETIC RECEPTOR BRIL FUSION;",
  "COMPND   3 CHAIN: A;",
  fixedRecord([
    [0, "SEQADV"],
    [12, "ALA"],
    [16, "A"],
    [18, "   2"],
    [39, "SER"],
    [43, "    2"],
    [49, "ENGINEERED MUTATION"],
  ]),
  "REMARK 465 GLY A 4",
  atomRecord({ record: "ATOM", serial: 1, atom: "CA", residue: "ALA", chain: "A", sequence: 1 }),
  atomRecord({
    record: "ATOM",
    serial: 2,
    atom: "CB",
    alt: "A",
    residue: "SER",
    chain: "A",
    sequence: 3,
    occupancy: 0.5,
  }),
  atomRecord({
    record: "HETATM",
    serial: 3,
    atom: "C1",
    residue: "LIG",
    chain: "A",
    sequence: 501,
  }),
  atomRecord({ record: "HETATM", serial: 4, atom: "O", residue: "HOH", chain: "A", sequence: 601 }),
  atomRecord({ record: "HETATM", serial: 5, atom: "NA", residue: "NA", chain: "A", sequence: 701 }),
  "END",
].join("\n");

const SYNTHETIC_MMCIF_FIXTURE = `data_1ABC_SYNTHETIC
# This fixture exercises the 1ABC metadata shape; it is not provider data.
loop_
_entity.id
_entity.type
_entity.pdbx_description
1 polymer 'SYNTHETIC RECEPTOR WITH CYTOCHROME B562'
2 non-polymer 'SYNTHETIC LIGAND'
#
loop_
_struct_asym.id
_struct_asym.entity_id
A 1
L 2
#
loop_
_atom_site.group_PDB
_atom_site.label_atom_id
_atom_site.label_alt_id
_atom_site.label_comp_id
_atom_site.auth_asym_id
_atom_site.auth_seq_id
_atom_site.label_entity_id
_atom_site.occupancy
ATOM CA . ALA A 1 1 1.00
ATOM CB B SER A 2 1 0.50
HETATM C1 . LIG L 10 2 1.00
HETATM O . HOH W 1 3 1.00
HETATM CL . CL I 1 4 1.00
#
loop_
_pdbx_unobs_or_zero_occ_residues.auth_asym_id
_pdbx_unobs_or_zero_occ_residues.auth_seq_id
_pdbx_unobs_or_zero_occ_residues.auth_comp_id
A 3 GLY
#
loop_
_struct_ref_seq_dif.pdbx_pdb_strand_id
_struct_ref_seq_dif.pdbx_auth_seq_num
_struct_ref_seq_dif.mon_id
_struct_ref_seq_dif.db_mon_id
_struct_ref_seq_dif.details
A 2 SER ALA 'ENGINEERED MUTATION'
#
`;

describe("targeted structure auditor", () => {
  test("PDB audit reports chains, declared and inferred gaps, mutations, fusion hints and components", () => {
    const audit = auditStructureText(SYNTHETIC_PDB_FIXTURE, "pdb", {
      referenceLigandResidueNames: ["LIG"],
    });

    expect(audit.chains).toHaveLength(1);
    expect(audit.chains[0]).toMatchObject({ chainId: "A", atomCount: 5, entityIds: ["1"] });
    expect(audit.entities[0]).toMatchObject({ entityId: "1", provenance: "declared" });
    expect(audit.alternateLocations).toEqual([
      expect.objectContaining({ alternateId: "A", residueName: "SER", occupancy: 0.5 }),
    ]);
    expect(audit.gaps.map((gap) => gap.source)).toContain("declared_missing_residue");
    expect(audit.gaps.map((gap) => gap.source)).toContain("inferred_sequence_discontinuity");
    expect(audit.mutations[0]).toMatchObject({
      source: "SEQADV",
      chainId: "A",
      residueName: "ALA",
    });
    expect(audit.fusions[0]).toMatchObject({ matchedKeyword: "fusion", confidence: "heuristic" });
    expect(audit.waters[0]?.residueName).toBe("HOH");
    expect(audit.ions[0]?.residueName).toBe("NA");
    expect(audit.ligandReferences[0]?.residueName).toBe("LIG");
  });

  test("mmCIF audit reads the targeted loop categories without asserting that synthetic metadata is real", () => {
    const audit = auditStructureText(SYNTHETIC_MMCIF_FIXTURE, "mmcif", {
      referenceLigandResidueNames: ["LIG"],
    });

    expect(audit.entities).toHaveLength(2);
    expect(audit.chains.map((chain) => chain.chainId)).toEqual(["A", "I", "L", "W"]);
    expect(audit.alternateLocations[0]).toMatchObject({ alternateId: "B", residueName: "SER" });
    expect(audit.gaps).toContainEqual(
      expect.objectContaining({ chainId: "A", sequenceNumber: "3", residueName: "GLY" }),
    );
    expect(audit.mutations).toContainEqual(
      expect.objectContaining({ source: "struct_ref_seq_dif", databaseResidueName: "ALA" }),
    );
    expect(audit.fusions[0]?.matchedKeyword).toBe("cytochrome b562");
    expect(audit.waters[0]?.residueName).toBe("HOH");
    expect(audit.ions[0]?.residueName).toBe("CL");
    expect(audit.ligandReferences[0]?.residueName).toBe("LIG");
    expect(audit.warnings.map((warning) => warning.code)).not.toContain(
      "partial_mmcif_tokenization",
    );
  });

  test("absence of annotations produces honest warnings instead of wild-type or complete-structure claims", () => {
    const audit = auditStructureText(
      atomRecord({
        record: "ATOM",
        serial: 1,
        atom: "CA",
        residue: "ALA",
        chain: "A",
        sequence: 1,
      }),
      "pdb",
    );
    const warningCodes = audit.warnings.map((warning) => warning.code);
    expect(warningCodes).toContain("entity_metadata_absent");
    expect(warningCodes).toContain("missing_residue_evidence_absent");
    expect(warningCodes).toContain("mutation_evidence_absent");
    expect(warningCodes).toContain("reference_ligand_not_declared");
  });
});
