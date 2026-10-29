import { expect, test } from "bun:test";
import type { AmberAtomMapViewEntry } from "../atom-map";
import { deriveAmberAtomMask } from "./restraint-mask";
function map(): AmberAtomMapViewEntry[] {
  return Array.from({ length: 300 }, (_, r) =>
    ["N", "CA", "C", "O", "H"].map((name, a) => ({
      topologyIndex: r * 5 + a + 1,
      systemAtomIndex: r * 5 + a + 1,
      componentId: "receptor",
      componentAtomIndex: r * 5 + a + 1,
      residueIndex: r + 1,
      residueName: "GLY",
      atomName: name,
      element: name === "CA" ? "C" : name,
    })),
  ).flat();
}
test("large exact selections compact within the existing 256-character engine limit", () => {
  const entries = map();
  const heavy = entries.filter((a) => a.element !== "H").map((a) => a.systemAtomIndex);
  expect(() => deriveAmberAtomMask(heavy, entries.length)).toThrow("bounded");
  expect(deriveAmberAtomMask(heavy, entries.length, entries)).toBe("(:1-300&!@H=)");
  const backbone = entries
    .filter((a) => ["C", "CA", "N"].includes(a.atomName))
    .map((a) => a.systemAtomIndex);
  expect(deriveAmberAtomMask(backbone, entries.length, entries)).toBe("(:1-300@C,CA,N)");
  expect(deriveAmberAtomMask([1, 2, 3], entries.length, entries)).toBe("@1-3");
});
test("compact masks reject incomplete maps, ambiguous names and non-topology residue numbering", () => {
  const entries = map();
  const heavy = entries.filter((a) => a.element !== "H").map((a) => a.systemAtomIndex);
  expect(() => deriveAmberAtomMask(heavy, entries.length, entries.slice(1))).toThrow("coverage");
  const changed = structuredClone(entries);
  changed[0]!.residueIndex = 70;
  expect(() => deriveAmberAtomMask(heavy, entries.length, changed)).toThrow("numbering");
  const ambiguous = structuredClone(entries);
  ambiguous[4]!.atomName = "N";
  expect(() => deriveAmberAtomMask(heavy, entries.length, ambiguous)).toThrow(
    "exact canonical selection",
  );
  expect(() => deriveAmberAtomMask([...heavy, 1], entries.length, entries)).toThrow("ordered");
});
