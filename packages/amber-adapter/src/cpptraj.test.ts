import { describe, expect, test } from "bun:test";
import { deriveCpptrajAtomMask, renderCpptrajPlan, type CpptrajPlan } from "./cpptraj";

const plan: CpptrajPlan = {
  topology: {
    role: "topology",
    logicalPath: "in/system.prmtop",
    mediaType: "application/octet-stream",
    sha256: "a".repeat(64),
  },
  trajectories: [
    {
      role: "trajectory",
      logicalPath: "in/trajectory.nc",
      mediaType: "application/octet-stream",
      sha256: "b".repeat(64),
    },
  ],
  analyses: [
    { kind: "dihedral", name: "phi", atomIndices: [5, 7, 9, 15], outputPath: "out/phi.dat" },
  ],
  autoimage: true,
  autoimageAnchor: [1, 2, 3],
  trajectoryWindows: [{ first: 2, last: 8, stride: 3 }],
  scriptPath: "out/cpptraj.in",
  logPath: "out/cpptraj.log",
};

describe("bounded CPPTRAJ extensions", () => {
  test("encodes exact atom sets without changing atom order or allowing expressions", () => {
    expect(deriveCpptrajAtomMask([1, 2, 3, 5, 7, 8])).toBe("@1-3,5,7-8");
    for (const bad of [[], [0], [1, 1], [2, 1], [1.5], [Infinity], [1_000_001]])
      expect(() => deriveCpptrajAtomMask(bad)).toThrow();
    expect(() =>
      deriveCpptrajAtomMask(Array.from({ length: 200 }, (_, index) => 1 + index * 2)),
    ).toThrow();
  });

  test("renders explicit windows, atom anchors and a four-atom dihedral", () => {
    const first = renderCpptrajPlan(plan);
    expect(first).toEqual(renderCpptrajPlan(structuredClone(plan)));
    expect(first.input.content).toContain(
      "trajin in/trajectory.nc 2 8 3\nautoimage anchor @1-3\ndihedral phi @5 @7 @9 @15 out out/phi.dat",
    );
    expect(first.command.shell).toBe(false);
  });

  test("rejects missing window bindings, invalid windows, duplicate torsion atoms and unmodelled instructions", () => {
    for (const change of [
      { trajectoryWindows: [] },
      { trajectoryWindows: [{ first: 8, last: 2, stride: 1 }] },
      { trajectoryWindows: [{ first: 1, last: 2, stride: 0 }] },
      { autoimage: false },
      { analyses: [{ ...plan.analyses[0], atomIndices: [1, 2, 1, 4] }] },
      { analyses: [{ ...plan.analyses[0], atomIndices: [1, 2, 3, "4;quit"] }] },
      { analyses: [{ ...plan.analyses[0], mask: "@1" }] },
      { rawScript: "quit" },
    ])
      expect(() => renderCpptrajPlan({ ...plan, ...change } as CpptrajPlan)).toThrow();
  });
});
