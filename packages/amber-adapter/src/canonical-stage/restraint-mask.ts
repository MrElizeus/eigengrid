import type { AmberAtomMapViewEntry } from "../atom-map";
import { SANDER26_CPU_PROFILE } from "../sander26-profile";

/** A mask is derived from exact canonical indices, never trusted as a decision label. */
export function deriveAmberAtomMask(
  indices: readonly number[],
  atomCount: number,
  entries?: readonly AmberAtomMapViewEntry[],
): string {
  if (
    indices.length === 0 ||
    !Number.isSafeInteger(atomCount) ||
    atomCount < 1 ||
    indices.some(
      (atom, index) =>
        !Number.isSafeInteger(atom) ||
        atom < 1 ||
        atom > atomCount ||
        (index > 0 && atom <= indices[index - 1]!),
    )
  ) {
    throw new Error(
      "Restraint indices must be ordered, unique and within the exact canonical atom map",
    );
  }
  const ranges: string[] = [];
  let start = indices[0]!;
  let end = start;
  const append = () => ranges.push(start === end ? String(start) : `${start}-${end}`);
  for (const atom of indices.slice(1)) {
    if (atom === end + 1) {
      end = atom;
      continue;
    }
    append();
    start = end = atom;
  }
  append();
  const mask = `@${ranges.join(",")}`;
  if (mask.length > SANDER26_CPU_PROFILE.maximumRestraintMaskCharacters) {
    if (entries) return compactMask(indices, atomCount, entries);
    throw new Error("The exact restraint selection exceeds the bounded Amber mask length");
  }
  return mask;
}

/** Compact only from a complete verified topology-order map. Each clause is
 * proved equal to its exact canonical atom subset before emitting Amber syntax.
 * The engine limit stays unchanged; arbitrary masks are never accepted. */
function compactMask(
  indices: readonly number[],
  atomCount: number,
  entries: readonly AmberAtomMapViewEntry[],
): string {
  if (entries.length !== atomCount)
    throw new Error("Compact restraints require complete AtomMap coverage");
  const residues = new Map<number, AmberAtomMapViewEntry[]>();
  let previous = 0;
  for (const [index, atom] of entries.entries()) {
    if (
      atom.systemAtomIndex !== index + 1 ||
      atom.topologyIndex !== index + 1 ||
      (atom.residueIndex !== previous && atom.residueIndex !== previous + 1) ||
      atom.residueIndex < 1
    )
      throw new Error("Compact restraints require contiguous one-based topology residue numbering");
    previous = atom.residueIndex;
    const atoms = residues.get(previous) ?? [];
    atoms.push(atom);
    residues.set(previous, atoms);
  }
  const selected = new Set(indices);
  const groups = new Map<string, number[]>();
  const reconstructed: number[] = [];
  for (const [residue, atoms] of residues) {
    const wanted = atoms.filter((atom) => selected.has(atom.systemAtomIndex));
    if (!wanted.length) continue;
    const names = [...new Set(wanted.map((atom) => atom.atomName))].sort();
    let suffix: string;
    let actual: AmberAtomMapViewEntry[];
    if (wanted.length === atoms.length) {
      suffix = "";
      actual = atoms;
    } else if (
      atoms.every((atom) => (atom.element === "H") === atom.atomName.startsWith("H")) &&
      atoms.every((atom) => selected.has(atom.systemAtomIndex) === (atom.element !== "H"))
    ) {
      suffix = "&!@H=";
      actual = atoms.filter((atom) => !atom.atomName.startsWith("H"));
    } else {
      if (names.some((name) => !/^[A-Za-z][A-Za-z0-9]*$/u.test(name)))
        throw new Error("Compact restraint atom names are not literal Amber names");
      suffix = "@" + names.join(",");
      actual = atoms.filter((atom) => names.includes(atom.atomName));
    }
    if (
      actual.length !== wanted.length ||
      actual.some((atom) => !selected.has(atom.systemAtomIndex))
    )
      throw new Error(
        "Compact restraint predicate does not preserve the exact canonical selection",
      );
    reconstructed.push(...actual.map((atom) => atom.systemAtomIndex));
    const list = groups.get(suffix) ?? [];
    list.push(residue);
    groups.set(suffix, list);
  }
  reconstructed.sort((a, b) => a - b);
  if (
    reconstructed.length !== indices.length ||
    reconstructed.some((atom, index) => atom !== indices[index])
  )
    throw new Error("Compact restraint selection changed canonical indices");
  const clauses = [...groups].map(([suffix, numbers]) => {
    const ranges: string[] = [];
    let first = numbers[0]!,
      last = first;
    for (const value of numbers.slice(1)) {
      if (value === last + 1) {
        last = value;
        continue;
      }
      ranges.push(first === last ? String(first) : `${first}-${last}`);
      first = last = value;
    }
    ranges.push(first === last ? String(first) : `${first}-${last}`);
    return `(:${ranges.join(",")}${suffix})`;
  });
  const mask = clauses.join("|");
  if (mask.length > SANDER26_CPU_PROFILE.maximumRestraintMaskCharacters)
    throw new Error("The exact restraint selection exceeds the bounded Amber mask length");
  return mask;
}
