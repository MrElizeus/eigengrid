/** Synthetic, tiny connectivity fixture. Never a prepared chemical system or engine qualification. */
import { createHash } from "node:crypto";
import { computeAtomMapDigest, type AtomMapEntry } from "@eigengrid/scientific-schema";
export function geometryFixture() {
  const residues: Array<{ name: string; component: string; atoms: [string, string][] }> = [
    {
      name: "LIG",
      component: "ligand",
      atoms: [
        ["C2", "C"],
        ["H2", "H"],
        ["C3", "C"],
        ["C1", "C"],
      ],
    },
    { name: "ASP", component: "receptor", atoms: [["OD1", "O"]] },
    {
      name: "WAT",
      component: "water",
      atoms: [
        ["O", "O"],
        ["H1", "H"],
        ["H2", "H"],
      ],
    },
    {
      name: "WAT",
      component: "water",
      atoms: [
        ["O", "O"],
        ["H1", "H"],
        ["H2", "H"],
      ],
    },
    {
      name: "LIP",
      component: "lipid",
      atoms: [
        ["P", "P"],
        ["C1", "C"],
        ["H1", "H"],
      ],
    },
    {
      name: "LIP",
      component: "lipid",
      atoms: [
        ["P", "P"],
        ["C1", "C"],
        ["H1", "H"],
      ],
    },
    { name: "CYS", component: "receptor", atoms: [["SG", "S"]] },
    { name: "CYS", component: "receptor", atoms: [["SG", "S"]] },
  ];
  const entries: AtomMapEntry[] = [],
    pointers: number[] = [];
  for (const [r, res] of residues.entries()) {
    pointers.push(entries.length + 1);
    for (const [name, element] of res.atoms)
      entries.push({
        systemAtomIndex: entries.length + 1,
        componentId: res.component,
        componentAtomIndex: entries.filter((e) => e.componentId === res.component).length + 1,
        residueIndex: r + 1,
        residueName: res.name,
        atomName: name,
        element,
      });
  }
  const bonds: [number, number][] = [
    [1, 2],
    [1, 4],
    [3, 4],
    [6, 7],
    [6, 8],
    [9, 10],
    [9, 11],
    [12, 13],
    [13, 14],
    [15, 16],
    [16, 17],
    [18, 19],
  ];
  const section = (name: string, items: (string | number)[], kind: "a" | "I", width: number) => {
    const per = kind === "a" ? 20 : 10,
      rows: string[] = [];
    for (let i = 0; i < items.length; i += per)
      rows.push(
        items
          .slice(i, i + per)
          .map((x) => (kind === "a" ? String(x).padEnd(width) : String(x).padStart(width)))
          .join(""),
      );
    return `%FLAG ${name}\n%FORMAT(${per}${kind}${width})\n${rows.join("\n")}\n`;
  };
  const ptr = Array<number>(31).fill(0);
  ptr[0] = entries.length;
  ptr[11] = residues.length;
  ptr[27] = 1;
  const triple = (pairs: [number, number][]) =>
    pairs.flatMap(([a, b]) => [(a - 1) * 3, (b - 1) * 3, 1]);
  const hydrogen = bonds.filter(([a, b]) => [a, b].some((i) => entries[i - 1]!.element === "H"));
  const heavy = bonds.filter(([a, b]) => [a, b].every((i) => entries[i - 1]!.element !== "H"));
  const topology =
    "%VERSION VERSION_STAMP = V0001.000 DATE = SYNTHETIC\n" +
    section("POINTERS", ptr, "I", 8) +
    section(
      "ATOM_NAME",
      entries.map((a) => a.atomName),
      "a",
      4,
    ) +
    section(
      "ATOMIC_NUMBER",
      entries.map((a) => ({ H: 1, C: 6, N: 7, O: 8, P: 15, S: 16 })[a.element]!),
      "I",
      8,
    ) +
    section(
      "RESIDUE_LABEL",
      residues.map((r) => r.name),
      "a",
      4,
    ) +
    section("RESIDUE_POINTER", pointers, "I", 8) +
    section("BONDS_INC_HYDROGEN", triple(hydrogen), "I", 8) +
    section("BONDS_WITHOUT_HYDROGEN", triple(heavy), "I", 8);
  const unsigned = {
    schemaVersion: "eigengrid.atom-map/v1" as const,
    id: "synthetic-geometry-map",
    revision: 1,
    systemManifestId: "synthetic-geometry-system",
    systemManifestRevision: 1,
    indexBase: 1 as const,
    atomCount: entries.length,
    topologyDigest: createHash("sha256").update(topology).digest("hex"),
    coordinateDigest: "b".repeat(64),
    entries,
  };
  const map = { ...unsigned, mapDigest: computeAtomMapDigest(unsigned) };
  const frame = {
    sourceFrame: 1,
    timePs: 10,
    cell: { lengthsAngstrom: [24, 24, 24], anglesDegrees: [90, 90, 90] },
    coordinates: [
      0, 0, 0, 1, 0, 0, -1, -1, 0, -1, 0, 0, 5.6, 0, 0, 2.8, 0, 0, 3.76, 0, 0, 2.5, 0.9, 0, 0, 10,
      0, 0.96, 10, 0, -0.3, 10.9, 0, 0, 0, 7, 1, 0, 7, 1, 0, 8, 0, 0, -7, 1, 0, -7, 2, 0, -7, 8, 8,
      8, 10, 8, 8,
    ],
  };
  return {
    topology,
    map,
    bonds,
    frame,
  };
}
