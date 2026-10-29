import { computeMdStageResultDigest } from "@eigengrid/scientific-schema";
import { unsignedStage, resignStage } from "../../amber-adapter/src/canonical-stage.fixture";
import { assessAmberNveDrift, computeNveDriftPolicyDigest } from "../src/physical-qc";
import { describe, expect, test } from "bun:test";
import {
  assessAmberGeometry,
  computeGeometryQcPolicyDigest,
  type GeometryQcPolicy,
  assessAmberThermodynamicWindow,
  computeThermodynamicWindowPolicyDigest,
  type ThermodynamicWindowPolicy,
} from "../src/physical-qc";
import { geometryFixture } from "./geometry-fixture";
import { telemetryRequest } from "./helpers";
import { SYNTHETIC_MDOUT_COMPLETE } from "../fixtures/synthetic";

function fixture() {
  const f = geometryFixture();
  const p: Omit<GeometryQcPolicy, "policyDigest"> = {
    schemaVersion: "eigengrid.amber-geometry-policy/v1",
    topologyDigest: f.map.topologyDigest,
    atomMapDigest: f.map.mapDigest,
    covalentLengthRangeAngstrom: [0.5, 2.1],
    minimumNonbondedHeavyDistanceAngstrom: 0.5,
    requiredBonds: [{ atoms: [18, 19], kind: "disulfide", lengthRangeAngstrom: [1.9, 2.1] }],
    membrane: {
      lipidComponentIds: ["lipid"],
      centerAtom: 1,
      upperHeadgroupAtoms: [12],
      lowerHeadgroupAtoms: [15],
      headgroupSeparationRangeAngstrom: [13, 15],
      orderCHBonds: [
        [13, 14],
        [16, 17],
      ],
    },
  };
  return { ...f, policy: { ...p, policyDigest: computeGeometryQcPolicyDigest(p) } };
}
function thermo(text = SYNTHETIC_MDOUT_COMPLETE, patch: Partial<ThermodynamicWindowPolicy> = {}) {
  const request = telemetryRequest(text);
  const p: Omit<ThermodynamicWindowPolicy, "policyDigest"> = {
    schemaVersion: "eigengrid.amber-thermodynamic-window/v1",
    stageResultDigest: request.stageResult.resultDigest,
    startTimePs: 0.2,
    endTimePs: 0.4,
    expectedSamples: 2,
    cadencePs: 0.2,
    meanTemperatureRangeKelvin: [290, 310],
    maximumRelativeVolumeDrift: 0.1,
    ...patch,
  };
  return { request, policy: { ...p, policyDigest: computeThermodynamicWindowPolicyDigest(p) } };
}

describe("engine adapter physical QC from bytes and declared geometry, separate from scientific approval", () => {
  test("measures endpoint covalence, explicit S-S, membrane separation and orientational order", () => {
    const f = fixture(),
      r = assessAmberGeometry(f.policy, f.topology, f.map, f.frame.coordinates, f.frame.cell);
    expect(r.status).toBe("passed");
    expect(r.issueCount).toBe(0);
    expect(r.membrane).toEqual({
      headgroupSeparationAngstrom: 14,
      meanOrderP2: 0.25,
      boxAreaAngstrom2: 576,
    });
    expect(r.scientificVerdict).toBe("not_evaluated");
    expect(r.scope).not.toContain("convergence");
  });
  test("finite coordinates and complete files are not sufficient physical QC", () => {
    const f = fixture(),
      x = [...f.frame.coordinates];
    x.splice(12, 3, 0, 0, 0.1);
    const r = assessAmberGeometry(f.policy, f.topology, f.map, x, f.frame.cell);
    expect(r.status).toBe("failed");
    expect(r.clashes).toBeGreaterThan(0);
    expect(r.issues.map((x) => x.code)).toContain("nonbonded_heavy_atom_overlap");
  });
  test("missing required S-S and excessive bond length cannot pass", () => {
    const f = fixture(),
      p = {
        ...f.policy,
        requiredBonds: [
          {
            atoms: [1, 5] as [number, number],
            kind: "covalent" as const,
            lengthRangeAngstrom: [1, 2] as [number, number],
          },
        ],
      };
    p.policyDigest = computeGeometryQcPolicyDigest(p);
    const r = assessAmberGeometry(p, f.topology, f.map, f.frame.coordinates, f.frame.cell);
    expect(r.status).toBe("failed");
    expect(r.issues.map((i) => i.code)).toContain("required_topology_bond_missing");
    const x = [...f.frame.coordinates];
    x[54] = 12;
    expect(
      assessAmberGeometry(f.policy, f.topology, f.map, x, f.frame.cell).issues.map((i) => i.code),
    ).toContain("required_bond_geometry");
  });
  test("does not silently use protein atoms as membrane or lipid-order markers", () => {
    const f = fixture(),
      p = { ...f.policy, membrane: { ...f.policy.membrane!, upperHeadgroupAtoms: [5] } };
    p.policyDigest = computeGeometryQcPolicyDigest(p);
    expect(() =>
      assessAmberGeometry(p, f.topology, f.map, f.frame.coordinates, f.frame.cell),
    ).toThrow(/Membrane/);
    const p2 = {
      ...f.policy,
      membrane: { ...f.policy.membrane!, orderCHBonds: [[4, 2] as [number, number]] },
    };
    p2.policyDigest = computeGeometryQcPolicyDigest(p2);
    expect(() =>
      assessAmberGeometry(p2, f.topology, f.map, f.frame.coordinates, f.frame.cell),
    ).toThrow(/C-H/);
  });
  test("leaflet drift/thickness and invalid coordinates reject independently", () => {
    const f = fixture(),
      x = [...f.frame.coordinates];
    x[35] = 2;
    expect(assessAmberGeometry(f.policy, f.topology, f.map, x, f.frame.cell).status).toBe("failed");
    x[0] = NaN;
    expect(() => assessAmberGeometry(f.policy, f.topology, f.map, x, f.frame.cell)).toThrow(
      /coordinate/,
    );
    expect(() =>
      assessAmberGeometry(
        { ...f.policy, policyDigest: "f".repeat(64) },
        f.topology,
        f.map,
        f.frame.coordinates,
        f.frame.cell,
      ),
    ).toThrow(/digest|mismatch/);
  });
  test("thermodynamic values derive from exact mdout telemetry and receipt binding", () => {
    const f = thermo(),
      r = assessAmberThermodynamicWindow(SYNTHETIC_MDOUT_COMPLETE, f.request, f.policy);
    expect(r.status).toBe("passed");
    expect(r.observedSamples).toBe(2);
    expect(r.meanTemperatureKelvin).toBeGreaterThan(290);
    expect(r.scientificVerdict).toBe("not_evaluated");
    expect(
      assessAmberThermodynamicWindow(SYNTHETIC_MDOUT_COMPLETE + " ", f.request, f.policy).status,
    ).toBe("indeterminate");
  });
  test("missing temperature is indeterminate, not zero or passed", () => {
    const text = SYNTHETIC_MDOUT_COMPLETE.replace(/TEMP\(K\)\s*=\s*[\d.]+/g, ""),
      f = thermo(text),
      r = assessAmberThermodynamicWindow(text, f.request, f.policy);
    expect(r.status).toBe("indeterminate");
    expect(r.meanTemperatureKelvin).toBeNull();
    expect(r.relativeVolumeDrift).toBeNull();
  });
  test("wrong window, incomplete output and finite but unacceptable temperature cannot pass", () => {
    const f = thermo(SYNTHETIC_MDOUT_COMPLETE, { meanTemperatureRangeKelvin: [400, 410] });
    expect(
      assessAmberThermodynamicWindow(SYNTHETIC_MDOUT_COMPLETE, f.request, f.policy).status,
    ).toBe("failed");
    const text = SYNTHETIC_MDOUT_COMPLETE + "\nFATAL runtime error\n",
      fatal = thermo(text);
    expect(assessAmberThermodynamicWindow(text, fatal.request, fatal.policy).status).toBe(
      "indeterminate",
    );
    const wrong = thermo(SYNTHETIC_MDOUT_COMPLETE, { startTimePs: 0.1, endTimePs: 0.3 });
    expect(
      assessAmberThermodynamicWindow(SYNTHETIC_MDOUT_COMPLETE, wrong.request, wrong.policy).status,
    ).toBe("indeterminate");
  });
});

describe("NVE energy drift respects the signed stage and numeric evidence", () => {
  test("fits total-energy drift rather than treating a stable temperature as NVE proof", () => {
    const base = unsignedStage(),
      f = geometryFixture(),
      material = { prmtop: f.topology, atomMap: f.map };
    const stage = resignStage({
      ...base,
      system: {
        ...base.system,
        topologyDigest: f.map.topologyDigest,
        atomMapDigest: f.map.mapDigest,
      },
      inputs: base.inputs.map((i) => ({ ...i, contentDigest: f.map.topologyDigest })),
      kind: "equilibration" as const,
      randomSeed: { policy: "fixed" as const, seed: 771001 },
      ensemble: "nve" as const,
      thermostat: { kind: "none" as const },
      steps: 200,
      timeStepPs: 0.002,
      simulatedTimePs: 0.4,
      constraints: { bondsToHydrogen: true, tolerance: 1e-5, maximumIterations: 3001 },
    });
    const text =
      "NSTEP = 0 TIME(PS) = 0.0 Etot = -100\nNSTEP = 100 TIME(PS) = 0.2 Etot = -99.98\nNSTEP = 200 TIME(PS) = 0.4 Etot = -99.96\n5. TIMINGS\n";
    const req = telemetryRequest(text);
    req.stageResult = {
      ...req.stageResult,
      stageId: stage.id,
      stageRevision: stage.revision,
      stageDigest: stage.stageDigest,
      stageKind: stage.kind,
    };
    req.stageResult.resultDigest = computeMdStageResultDigest(req.stageResult);
    const raw = {
      schemaVersion: "eigengrid.amber-nve-drift-policy/v1" as const,
      stageResultDigest: req.stageResult.resultDigest,
      atomCount: f.map.atomCount,
      startTimePs: 0,
      endTimePs: 0.4,
      expectedSamples: 3,
      cadencePs: 0.2,
      maximumAbsoluteSlopeKcalMolPsPerAtom: 0.011,
    };
    const p = { ...raw, policyDigest: computeNveDriftPolicyDigest(raw) };
    const r = assessAmberNveDrift(text, req, stage, p, material);
    expect(r.status).toBe("passed");
    expect(r.slopeKcalMolPsPerAtom).toBeCloseTo(0.1 / f.map.atomCount, 10);
    expect(() =>
      assessAmberNveDrift(text, req, stage, { ...p, atomCount: 10000 }, material),
    ).toThrow(/normalization/);
    const tight = { ...p, maximumAbsoluteSlopeKcalMolPsPerAtom: 0.001 };
    tight.policyDigest = computeNveDriftPolicyDigest(tight);
    expect(assessAmberNveDrift(text, req, stage, tight, material).status).toBe("failed");
    expect(() =>
      assessAmberNveDrift(
        text,
        req,
        resignStage({
          ...stage,
          ensemble: "nvt",
          thermostat: { kind: "langevin", collisionFrequencyPerPs: 1 },
        }),
        p,
        material,
      ),
    ).toThrow(/NVE/);
    expect(assessAmberNveDrift(text + "bad\n", req, stage, p, material).status).toBe(
      "indeterminate",
    );
  });
});
