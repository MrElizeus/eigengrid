import { describe, expect, test } from "bun:test";
import {
  computeAmberAtomMapViewDigest,
  computeCanonicalAtomMapDigest,
  deriveAmberAtomMapView,
} from "./atom-map";
import { commandRequestDigest, validateCommandSpec } from "./contracts";
import { FakeAmberEngine, runFakeAmberVertical } from "./fake-engine";
import { renderMdin } from "./mdin";
import { renderMdStageCommand } from "./stage";
import { validateAmberTopology } from "./validation";

describe("CI fake AMBER vertical", () => {
  test("crosses parameterization through CPPTRAJ without external binaries", () => {
    const result = runFakeAmberVertical();
    expect(result.commands.map((command) => command.executable)).toEqual([
      "antechamber",
      "parmchk2",
      "tleap",
      "sander",
      "sander",
      "sander",
      "sander",
      "cpptraj",
    ]);
    expect(result.commands.map((command) => command.operation)).toEqual([
      "amber.antechamber.gaff2-am1bcc",
      "amber.parmchk2.gaff2",
      "amber.tleap.assemble",
      "amber.stage.minimization",
      "amber.stage.heating",
      "amber.stage.equilibration",
      "amber.stage.production",
      "amber.cpptraj.analyze",
    ]);
    expect(result.receipts).toHaveLength(result.commands.length);
    expect(result.certificationScope).toBe("contract-choreography-only");
    expect(result.amberConsumableFixture).toBe(false);
    expect(result.topologyValidation.valid).toBe(true);
    expect(result.topologyValidation.amberConsumableCertified).toBe(false);
    expect(result.fakeMdParses).toHaveLength(4);
    expect(result.fakeMdParses.every((parsed) => parsed.terminalReason === "completed")).toBe(true);
    expect(result.engine.getArtifact("outputs/analysis/protein-rmsd.dat").content).toContain(
      "#Frame Value",
    );
    expect(JSON.stringify(result.commands).toLowerCase()).not.toContain("prepi");
    const stageCommands = result.commands.slice(3, 7);
    expect(stageCommands.slice(0, 3).every((command) => command.argv.includes("-ref"))).toBe(true);
    expect(stageCommands[3]?.argv).not.toContain("-ref");
    for (let index = 1; index < stageCommands.length; index += 1) {
      const previousRestart = stageCommands[index - 1]!.outputs.find(
        (output) => output.role === "stage.restart",
      )!;
      const nextCoordinates = stageCommands[index]!.inputs.find(
        (input) => input.role === "coordinates.input",
      )!;
      expect(nextCoordinates.logicalPath).toBe(previousRestart.logicalPath);
      expect(nextCoordinates.sha256).toBe(
        result.engine.getArtifact(previousRestart.logicalPath).sha256,
      );
    }
  });

  test("receipts exactly mirror output inventories and replay has one effect", () => {
    const result = runFakeAmberVertical();
    for (let index = 0; index < result.commands.length; index += 1) {
      const command = result.commands[index]!;
      const receipt = result.receipts[index]!;
      expect(receipt.requestDigest).toBe(commandRequestDigest(command));
      expect(
        receipt.artifacts.map(({ role, logicalPath, mediaType, producedBy }) => ({
          role,
          logicalPath,
          mediaType,
          producedBy,
        })),
      ).toEqual(command.outputs);
      expect(new Set(receipt.artifacts.map((artifact) => artifact.logicalPath)).size).toBe(
        receipt.artifacts.length,
      );
      expect(receipt.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256))).toBe(
        true,
      );
    }

    const command = result.commands.at(-1)!;
    const original = result.receipts.at(-1)!;
    const replay = result.engine.execute(command);
    expect(replay).toBe(original);
    expect(result.engine.effectCount(original.requestDigest)).toBe(1);
  });

  test("the fixture is reproducible and rejects a forged input digest", () => {
    const left = runFakeAmberVertical();
    const right = runFakeAmberVertical();
    expect(left.receipts).toEqual(right.receipts);

    const command = left.commands.at(-1)!;
    const forged = validateCommandSpec({
      ...command,
      inputs: command.inputs.map((input, index) =>
        index === 0 ? { ...input, sha256: "9".repeat(64) } : input,
      ),
    });
    expect(() => left.engine.execute(forged)).toThrow(/digest mismatch/);
  });

  test("preflights every output so a late conflict cannot leave partial effects", () => {
    const engine = new FakeAmberEngine();
    engine.seedArtifact({
      logicalPath: "inputs/system.prmtop",
      mediaType: "application/vnd.amber.prmtop",
      content: "topology",
    });
    engine.seedArtifact({
      logicalPath: "inputs/system.rst7",
      mediaType: "application/vnd.amber.rst7",
      content: "coordinates",
    });
    const mdin = renderMdin(
      {
        kind: "minimization",
        title: "Atomic fake output test",
        maxCycles: 10,
        steepestDescentCycles: 5,
        rmsGradientToleranceKcalMolAngstrom: 0.0001,
        initialStepAngstrom: 0.01,
        cutoffAngstrom: 10,
        restartFormat: "formatted",
        output: { energiesEvery: 5, trajectoryEvery: 0, restartEvery: 10 },
      },
      "work/min.mdin",
    );
    engine.seedArtifact(mdin);
    const command = renderMdStageCommand({
      kind: "minimization",
      engine: "sander",
      topology: engine.asInput("inputs/system.prmtop", "topology"),
      coordinates: engine.asInput("inputs/system.rst7", "coordinates"),
      mdin,
      outputs: {
        mdout: "outputs/min.mdout",
        restart: "outputs/min.rst7",
        mdinfo: "outputs/min.mdinfo",
      },
    });
    engine.seedArtifact({
      logicalPath: "outputs/min.mdinfo",
      mediaType: "text/plain",
      content: "conflicting pre-existing artifact",
    });
    expect(() => engine.execute(command)).toThrow(/partial fake execution/);
    expect(() => engine.getArtifact("outputs/min.mdout")).toThrow(/does not exist/);
  });
});

describe("lightweight prmtop/rst7/atom-map validation", () => {
  test("checks charge, box, counts, atom coverage, and atom-map digest", () => {
    const fixture = runFakeAmberVertical();
    const prmtop = fixture.engine.getArtifact("outputs/system.prmtop").content;
    const rst7 = fixture.engine.getArtifact("outputs/system.rst7").content;
    const entries = [
      {
        systemAtomIndex: 1,
        componentId: "receptor",
        componentAtomIndex: 1,
        chainId: "A",
        residueIndex: 1,
        atomName: "CA",
        residueName: "ALA",
        element: "C",
      },
      {
        systemAtomIndex: 2,
        componentId: "ligand",
        componentAtomIndex: 1,
        residueIndex: 2,
        atomName: "C1",
        residueName: "LIG",
        element: "C",
      },
      {
        systemAtomIndex: 3,
        componentId: "ligand",
        componentAtomIndex: 2,
        residueIndex: 2,
        atomName: "O1",
        residueName: "LIG",
        element: "O",
      },
    ];
    const canonicalBase = {
      schemaVersion: "eigengrid.atom-map/v1" as const,
      id: "test-atom-map",
      revision: 1,
      systemManifestId: "fake-system",
      systemManifestRevision: 1,
      indexBase: 1 as const,
      atomCount: 3,
      topologyDigest: fixture.engine.getArtifact("outputs/system.prmtop").sha256,
      coordinateDigest: fixture.engine.getArtifact("outputs/system.rst7").sha256,
      entries,
    };
    const canonicalMap = {
      ...canonicalBase,
      mapDigest: computeCanonicalAtomMapDigest(canonicalBase),
    };
    const atomMapView = deriveAmberAtomMapView(canonicalMap, canonicalMap.mapDigest);
    const valid = validateAmberTopology({
      prmtop,
      rst7,
      atomMapView,
      expectedCanonicalAtomMapDigest: canonicalMap.mapDigest,
      expectedAtomCount: 3,
      expectedTotalCharge: 0,
      requirePeriodicBox: true,
    });
    expect(valid.valid).toBe(true);
    expect(valid.summary).toMatchObject({
      topologyAtomCount: 3,
      coordinateAtomCount: 3,
      totalChargeElectrons: 0,
      periodicTopology: true,
      minimumSectionsPresent: true,
    });
    expect(valid.summary.coordinateBox).toEqual([40, 40, 60, 90, 90, 90]);
    const velocityRestart = validateAmberTopology({
      prmtop,
      rst7: fixture.engine.getArtifact("outputs/stages/heating.rst7").content,
      atomMapView,
      expectedCanonicalAtomMapDigest: canonicalMap.mapDigest,
      expectedAtomCount: 3,
      expectedTotalCharge: 0,
      requirePeriodicBox: true,
      requireVelocities: true,
    });
    expect(velocityRestart.valid).toBe(true);
    expect(velocityRestart.summary.hasVelocities).toBe(true);

    const missingVelocities = validateAmberTopology({
      prmtop,
      rst7,
      atomMapView,
      expectedCanonicalAtomMapDigest: canonicalMap.mapDigest,
      requirePeriodicBox: true,
      requireVelocities: true,
    });
    expect(missingVelocities.issues.map((issue) => issue.code)).toContain(
      "missing_restart_velocities",
    );
    expect(() =>
      validateAmberTopology({
        prmtop,
        rst7,
        atomMapView,
        expectedCanonicalAtomMapDigest: canonicalMap.mapDigest,
        expectedTotalCharge: Number.NaN,
      }),
    ).toThrow();
    const nonIntegral = validateAmberTopology({
      prmtop: prmtop.replace("-1.82223000E+0", " 0.00000000E+0"),
      rst7,
      atomMapView,
      expectedCanonicalAtomMapDigest: canonicalMap.mapDigest,
      requirePeriodicBox: true,
    });
    expect(nonIntegral.issues.map((issue) => issue.code)).toContain("non_integral_charge");

    const mismatchedCanonicalBase = {
      ...canonicalBase,
      entries: entries.map((entry, index) => (index === 1 ? { ...entry, atomName: "XX" } : entry)),
    };
    const mismatchedCanonical = {
      ...mismatchedCanonicalBase,
      mapDigest: computeCanonicalAtomMapDigest(mismatchedCanonicalBase),
    };
    const identityMismatch = validateAmberTopology({
      prmtop,
      rst7,
      atomMapView: deriveAmberAtomMapView(mismatchedCanonical, mismatchedCanonical.mapDigest),
      expectedCanonicalAtomMapDigest: mismatchedCanonical.mapDigest,
      requirePeriodicBox: true,
    });
    expect(identityMismatch.issues.map((issue) => issue.code)).toContain(
      "atom_map_identity_mismatch",
    );

    const skeletal = validateAmberTopology({
      prmtop: prmtop.replace(/%FLAG ATOM_NAME[\s\S]*?(?=%FLAG CHARGE)/, ""),
      rst7,
      atomMapView,
      expectedCanonicalAtomMapDigest: canonicalMap.mapDigest,
      requirePeriodicBox: true,
    });
    expect(skeletal.issues.map((issue) => issue.code)).toContain("missing_prmtop_section");

    const invalid = validateAmberTopology({
      prmtop,
      rst7: rst7.replace(/^\s*3\s+0\.0000000/m, "     4  0.0000000"),
      atomMapView,
      expectedCanonicalAtomMapDigest: canonicalMap.mapDigest,
      expectedAtomCount: 3,
      expectedTotalCharge: 1,
      requirePeriodicBox: true,
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "topology_coordinate_atom_mismatch",
        "unexpected_atom_count",
        "invalid_coordinate_payload",
        "charge_mismatch",
        "missing_periodic_box",
      ]),
    );
    expect(() =>
      validateAmberTopology({
        prmtop,
        rst7,
        atomMapView: {
          ...atomMapView,
          entries: [atomMapView.entries[0]!, atomMapView.entries[0]!],
          viewDigest: computeAmberAtomMapViewDigest({
            ...atomMapView,
            entries: [atomMapView.entries[0]!, atomMapView.entries[0]!],
          }),
        },
        expectedCanonicalAtomMapDigest: canonicalMap.mapDigest,
      }),
    ).toThrow(/coverage|round-trip/);
    expect(() =>
      validateAmberTopology({
        prmtop,
        rst7,
        atomMapView,
        expectedCanonicalAtomMapDigest: "8".repeat(64),
      }),
    ).toThrow(/manifest/);
  });
});
