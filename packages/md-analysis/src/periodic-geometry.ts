/** Deliberately orthorhombic. Reject oblique cells rather than using incorrect component wrapping. */
export type Vec3 = [number, number, number];
export interface OrthorhombicCell {
  lengthsAngstrom: Vec3;
  anglesDegrees: Vec3;
}
export function checkCell(value: OrthorhombicCell, cutoff = 0): OrthorhombicCell {
  if (
    !value ||
    !Array.isArray(value.lengthsAngstrom) ||
    value.lengthsAngstrom.length !== 3 ||
    !Array.isArray(value.anglesDegrees) ||
    value.anglesDegrees.length !== 3 ||
    Array.from(value.lengthsAngstrom).some((n) => !Number.isFinite(n) || n <= 0 || n > 1e7) ||
    Array.from(value.anglesDegrees).some((n) => !Number.isFinite(n) || Math.abs(n - 90) > 1e-6) ||
    !Number.isFinite(cutoff) ||
    cutoff < 0 ||
    (cutoff > 0 && Array.from(value.lengthsAngstrom).some((n) => n <= 2 * cutoff))
  ) {
    throw new Error("Geometry requires a finite orthorhombic cell larger than twice the cutoff");
  }
  return { lengthsAngstrom: [...value.lengthsAngstrom], anglesDegrees: [...value.anglesDegrees] };
}
export function checkCoordinates(value: readonly number[], atomCount: number): void {
  if (
    !Array.isArray(value) ||
    !Number.isSafeInteger(atomCount) ||
    atomCount < 1 ||
    atomCount > 1_000_000 ||
    value.length !== atomCount * 3
  )
    throw new Error("Coordinate payload must exactly match the topology atom count");
  for (let i = 0; i < value.length; i++)
    if (!Number.isFinite(value[i]) || Math.abs(value[i]!) > 1e8)
      throw new Error("Non-finite, missing or unbounded coordinate");
}
export function point(x: readonly number[], atom: number): Vec3 {
  if (!Number.isInteger(atom) || atom < 1 || atom * 3 > x.length)
    throw new Error("Atom index out of coordinate range");
  return [x[(atom - 1) * 3]!, x[(atom - 1) * 3 + 1]!, x[(atom - 1) * 3 + 2]!];
}
export function delta(a: Vec3, b: Vec3, cell: OrthorhombicCell): Vec3 {
  return a.map((v, i) => {
    const d = v - b[i]!,
      length = cell.lengthsAngstrom[i]!;
    return d - length * Math.round(d / length);
  }) as Vec3;
}
export function norm(v: Vec3): number {
  return Math.hypot(...v);
}
export function distance(a: Vec3, b: Vec3, cell: OrthorhombicCell): number {
  return norm(delta(a, b, cell));
}
export function hbondGeometry(
  d: Vec3,
  h: Vec3,
  a: Vec3,
  cell: OrthorhombicCell,
  cutoff: number,
  angleMin: number,
): boolean {
  if (distance(d, a, cell) >= cutoff) return false;
  // Place bonded H and the nearest acceptor in ONE donor-centered image. Imaging
  // H-A independently can reverse a rejected angle in a small periodic box.
  const dh = delta(h, d, cell),
    da = delta(a, d, cell);
  const hd = dh.map((v) => -v) as Vec3,
    ha = da.map((v, i) => v - dh[i]!) as Vec3,
    denom = norm(hd) * norm(ha);
  if (denom <= 1e-12) throw new Error("Degenerate hydrogen-bond geometry");
  const cosine = hd.reduce((s, v, i) => s + v * ha[i]!, 0) / denom;
  const angle = (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
  return angle > angleMin;
}

/** Bounded, periodic cell list; construction O(N), no all-water x all-solute Cartesian product. */
export class PeriodicNeighbors {
  private readonly bins = new Map<string, number[]>();
  private readonly cells: Vec3;
  private readonly cell: OrthorhombicCell;
  constructor(
    private readonly xyz: readonly number[],
    indices: readonly number[],
    cell: OrthorhombicCell,
    readonly cutoff: number,
  ) {
    this.cell = checkCell(cell, cutoff);
    if (!(cutoff > 0)) throw new Error("Positive neighbor cutoff required");
    this.cells = this.cell.lengthsAngstrom.map((l) => Math.max(1, Math.floor(l / cutoff))) as Vec3;
    for (const atom of indices) {
      const key = this.key(this.bin(point(xyz, atom)));
      const list = this.bins.get(key) ?? [];
      list.push(atom);
      this.bins.set(key, list);
    }
  }
  private bin(v: Vec3): Vec3 {
    return v.map((n, i) => {
      const l = this.cell.lengthsAngstrom[i]!,
        k = this.cells[i]!;
      return Math.min(k - 1, Math.floor(((((n % l) + l) % l) / l) * k));
    }) as Vec3;
  }
  private key(v: Vec3): string {
    return v.join(":");
  }
  near(v: Vec3): number[] {
    let candidates = 0;
    const b = this.bin(v),
      keys = new Set<string>(),
      result: number[] = [];
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (let k = -1; k <= 1; k++) {
          const q = [i, j, k].map((s, a) => (b[a]! + s + this.cells[a]!) % this.cells[a]!) as Vec3;
          const key = this.key(q);
          if (keys.has(key)) continue;
          keys.add(key);
          for (const atom of this.bins.get(key) ?? []) {
            if (++candidates > 20_000)
              throw new Error("Periodic neighbor query exceeds the bounded density budget");
            if (distance(v, point(this.xyz, atom), this.cell) < this.cutoff) result.push(atom);
          }
        }
    return result;
  }
}
