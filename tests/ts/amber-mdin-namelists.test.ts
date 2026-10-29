import { expect, test } from "bun:test";
import { renderMdin } from "../../packages/amber-adapter/src/mdin";

test("PME controls have their own namelist and never contaminate cntrl", () => {
  const stage = {
    kind: "minimization",
    title: "PME regression",
    maxCycles: 20,
    steepestDescentCycles: 10,
    rmsGradientToleranceKcalMolAngstrom: 0.0001,
    initialStepAngstrom: 0.01,
    cutoffAngstrom: 8,
    restartFormat: "formatted",
    output: { energiesEvery: 1, trajectoryEvery: 0, restartEvery: 20 },
    nonbonded: { electrostatics: "pme", ewaldTolerance: 0.00001 },
  };
  const rendered = renderMdin(stage, "min.mdin");
  const cntrl = rendered.content.match(/&cntrl\n([\s\S]*?)\n\//u)?.[1];
  const ewald = rendered.content.match(/&ewald\n([\s\S]*?)\n\//u)?.[1];
  expect(cntrl).toContain("imin=1,");
  expect(cntrl).not.toMatch(/ew_type|dsum_tol/u);
  expect(ewald).toContain("ew_type=0,");
  expect(ewald).toContain("dsum_tol=0.00001,");
  expect(rendered.content.match(/&ewald/gu)).toHaveLength(1);
  expect(renderMdin({ ...stage, nonbonded: undefined }, "min.mdin").content).not.toContain(
    "&ewald",
  );
});
