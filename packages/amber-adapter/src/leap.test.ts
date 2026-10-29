import { describe, expect, test } from "bun:test";
import { renderLeapAssembly, type LeapAssemblyPlan } from "./leap";

const plan: LeapAssemblyPlan = {
  forceFields: ["leaprc.protein.ff14SB", "leaprc.water.tip3p"],
  frcmods: [],
  components: [],
  peptideTemplate: { identity: "ACE-ALA-NME", stereochemistry: "L" },
  solvation: { waterModel: "TIP3P", boxShape: "orthorhombic", paddingAngstrom: 12 },
  ions: { kind: "none", soluteNetCharge: 0 },
  scriptPath: "work/tleap.in",
  topologyPath: "out/system.prmtop",
  coordinatesPath: "out/system.rst7",
  snapshotPdbPath: "out/system.pdb",
  logPath: "out/tleap.log",
};

describe("bounded LEaP preparation", () => {
  test("capped neutral peptide is deterministic and needs no ligand parameterization", () => {
    const rendered = renderLeapAssembly(plan);
    expect(rendered).toEqual(renderLeapAssembly(structuredClone(plan)));
    expect(rendered.input.content).toBe(
      [
        "source leaprc.protein.ff14SB",
        "source leaprc.water.tip3p",
        "system = sequence { ACE ALA NME }",
        "solvateBox system TIP3PBOX 12",
        "check system",
        "saveamberparm system out/system.prmtop out/system.rst7",
        "savepdb system out/system.pdb",
        "quit",
        "",
      ].join("\n"),
    );
    expect(rendered.command.inputs).toHaveLength(1);
    expect(rendered.command.shell).toBe(false);
  });

  test("box shape and deterministic counterion policy are explicit", () => {
    const loaded: LeapAssemblyPlan = {
      ...plan,
      peptideTemplate: undefined,
      components: [
        {
          variable: "protein",
          format: "pdb",
          artifact: {
            role: "protein",
            logicalPath: "in/protein.pdb",
            mediaType: "chemical/x-pdb",
            sha256: "a".repeat(64),
          },
        },
      ],
      ions: { kind: "neutralize", soluteNetCharge: -2, counterIon: "Na+" },
      solvation: { ...plan.solvation!, boxShape: "cubic" },
    };
    const text = renderLeapAssembly(loaded).input.content;
    expect(text).toContain("solvateBox system TIP3PBOX 12 iso\naddIons system Na+ 2");
    expect(text).not.toContain("addIonsRand");
    expect(() =>
      renderLeapAssembly({
        ...loaded,
        ions: { kind: "neutralize", soluteNetCharge: -2, counterIon: "Cl-" },
      }),
    ).toThrow(/Counterion/);
    expect(
      renderLeapAssembly({
        ...loaded,
        solvation: { ...loaded.solvation!, boxShape: "truncated_octahedron" },
      }).input.content,
    ).toContain("solvateOct system TIP3PBOX 12");
  });

  test("rejects missing or contradictory scientific choices and arbitrary instructions", () => {
    for (const changed of [
      { ions: undefined },
      { solvation: { ...plan.solvation!, paddingAngstrom: NaN } },
      { solvation: { ...plan.solvation!, waterModel: "OPC" } },
      { peptideTemplate: { identity: "ACE-ALA-NME", stereochemistry: "D" } },
      { ions: { kind: "none", soluteNetCharge: 1 } },
      { forceFields: ["leaprc.water.tip3p"] },
      { forceFields: [...plan.forceFields, "leaprc.protein.ff19SB"] },
      { forceFields: [...plan.forceFields, "leaprc.water.opc"] },
      { forceFields: [...plan.forceFields, "leaprc.gaff2"] },
      { rawScript: "quit" },
      { peptideTemplate: { ...plan.peptideTemplate!, residue: "ALA; quit" } },
      {
        components: [
          {
            variable: "solute",
            format: "pdb",
            artifact: {
              role: "solute",
              logicalPath: "solute.pdb",
              mediaType: "chemical/x-pdb",
              sha256: "a".repeat(64),
            },
          },
        ],
      },
    ])
      expect(() => renderLeapAssembly({ ...plan, ...changed } as LeapAssemblyPlan)).toThrow();
  });
});
