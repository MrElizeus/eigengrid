import { createHash } from "node:crypto";
import { assertAtomMapDigest, type AtomMap } from "@eigengrid/scientific-schema";
export interface AmberBondGraph {
  readonly atomCount: number;
  readonly topologyDigest: string;
  readonly atomMap: AtomMap;
  readonly bonds: readonly [number, number][];
  readonly neighbors: ReadonlyMap<number, ReadonlySet<number>>;
  readonly residueByAtom: readonly number[];
}
/** Minimal identity/connectivity decoder, not a parameter or force-field validator. */
export function readAmberBondGraph(text: string, mapValue: unknown): AmberBondGraph {
  const map = assertAtomMapDigest(mapValue);
  if (typeof text !== "string" || text.length > 128 * 1024 * 1024 || text.includes("\0"))
    throw new Error("Expected bounded prmtop text");
  const hash = createHash("sha256").update(text).digest("hex");
  if (hash !== map.topologyDigest) throw new Error("Topology byte digest differs from AtomMap");
  const lines = text.split(/\r?\n/),
    sections = new Map<string, string[]>();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith("%FLAG ")) continue;
    const name = lines[i]!.slice(6).trim();
    if (sections.has(name)) throw new Error("Duplicate topology flag");
    while (lines[i + 1]?.startsWith("%COMMENT")) i++;
    const fmt = lines[++i]?.match(/^%FORMAT\(\s*(\d+)([aAiIeEfFdD])(\d+)(?:\.\d+)?\s*\)$/);
    if (!fmt || Number(fmt[3]) < 1 || Number(fmt[3]) > 128)
      throw new Error("Unsupported topology field format");
    const width = Number(fmt[3]),
      values: string[] = [];
    while (i + 1 < lines.length && !lines[i + 1]!.startsWith("%FLAG")) {
      const row = lines[++i]!;
      if (row.startsWith("%")) continue;
      for (let j = 0; j < row.length; j += width) {
        const v = row.slice(j, j + width).trim();
        if (v) values.push(v);
      }
    }
    sections.set(name, values);
  }
  const required = (name: string): string[] => {
    const s = sections.get(name);
    if (!s) throw new Error(`Missing topology ${name}`);
    return s;
  };
  const ints = (name: string): number[] =>
    required(name).map((v) => {
      if (!/^[-+]?\d+$/.test(v) || !Number.isSafeInteger(Number(v)))
        throw new Error(`Invalid topology integer in ${name}`);
      return Number(v);
    });
  const atomCount = ints("POINTERS")[0];
  if (atomCount !== map.atomCount || atomCount === undefined || atomCount > 1_000_000)
    throw new Error("Topology/AtomMap atom count mismatch");
  const atomicNumbers = ints("ATOMIC_NUMBER");
  const elements: Record<string, number> = {
    H: 1,
    B: 5,
    C: 6,
    N: 7,
    O: 8,
    F: 9,
    Na: 11,
    Mg: 12,
    P: 15,
    S: 16,
    Cl: 17,
    K: 19,
    Ca: 20,
    Fe: 26,
    Zn: 30,
    Br: 35,
    I: 53,
  };
  if (atomicNumbers.length !== atomCount)
    throw new Error("Topology atomic numbers must cover NATOM");
  const names = required("ATOM_NAME"),
    labels = required("RESIDUE_LABEL"),
    pointers = ints("RESIDUE_POINTER");
  if (
    names.length !== atomCount ||
    labels.length !== pointers.length ||
    pointers.length === 0 ||
    pointers[0] !== 1 ||
    pointers.some((p, i) => p < 1 || p > atomCount || (i > 0 && p <= pointers[i - 1]!))
  )
    throw new Error("Invalid topology residue identity");
  const residueByAtom = Array<number>(atomCount);
  for (let r = 0; r < labels.length; r++)
    for (let a = pointers[r]! - 1; a < (pointers[r + 1] ?? atomCount + 1) - 1; a++)
      residueByAtom[a] = r + 1;
  for (const atom of map.entries) {
    const i = atom.systemAtomIndex - 1;
    if (
      atomicNumbers[i] !== elements[atom.element] ||
      names[i] !== atom.atomName ||
      labels[residueByAtom[i]! - 1] !== atom.residueName
    )
      throw new Error("AtomMap elements/names/order differ from topology bytes");
  }
  const neighbors = new Map<number, Set<number>>(),
    bonds: [number, number][] = [],
    seen = new Set<string>();
  for (const section of ["BONDS_INC_HYDROGEN", "BONDS_WITHOUT_HYDROGEN"]) {
    const triples = ints(section);
    if (triples.length % 3) throw new Error("Truncated topology bond triple");
    for (let i = 0; i < triples.length; i += 3) {
      const a = triples[i]! / 3 + 1,
        b = triples[i + 1]! / 3 + 1;
      if (
        !Number.isInteger(a) ||
        !Number.isInteger(b) ||
        a < 1 ||
        b < 1 ||
        a > atomCount ||
        b > atomCount ||
        a === b ||
        triples[i + 2]! <= 0
      )
        throw new Error("Invalid topology bond index");
      const pair: [number, number] = a < b ? [a, b] : [b, a],
        key = pair.join(":");
      if (seen.has(key)) throw new Error("Duplicate topology bond");
      seen.add(key);
      bonds.push(pair);
      for (const [x, y] of [
        [a, b],
        [b, a],
      ]) {
        const set = neighbors.get(x!) ?? new Set<number>();
        set.add(y!);
        neighbors.set(x!, set);
      }
    }
  }
  return { atomCount, topologyDigest: hash, atomMap: map, bonds, neighbors, residueByAtom };
}
