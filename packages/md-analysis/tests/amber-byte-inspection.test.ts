import { describe, expect, test } from "bun:test";
import {
  AmberByteInspectionSchemaVersion,
  AmberMinimizationParseSchemaVersion,
  assertAmberByteInspection,
  assertAmberMinimizationParseResult,
  bindAmberTrajectoryInspection,
  observedAmberTimeResolutionPs,
} from "../src/index";

const digest = (character: string) => character.repeat(64);

function decodedTrajectory(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: AmberByteInspectionSchemaVersion,
    decoder: { id: "eigengrid_chem.amber.byte-inspector", version: "0.1.0" },
    artifactKind: "trajectory",
    observedContentDigest: digest("a"),
    byteLength: 672,
    format: "amber_netcdf",
    inspectionLevel: "decoded",
    readStatus: "complete",
    convention: "AMBER",
    atomCount: 3,
    frameCount: 5,
    hasPeriodicBox: false,
    finiteValues: true,
    dimensions: { frame: 5, atom: 3, spatial: 3 },
    time: {
      status: "strictly_increasing",
      cadenceStatus: "uniform",
      count: 5,
      firstPs: 0.001,
      lastPs: 0.005,
      minDeltaPs: 0.001,
      maxDeltaPs: 0.001,
      precisionPs: 5.96e-10,
    },
    cell: { status: "not_present", frameCount: null, variableAcrossFrames: null },
    atomIdentityDigest: null,
    diagnostics: [],
    ...overrides,
  };
}

describe("AMBER byte decoder response boundary", () => {
  test("accepts the bundled Python decoder's response for tracked Amber 26 bytes", () => {
    const output = Bun.spawnSync({
      cmd: [
        "python",
        "-m",
        "eigengrid_chem",
        "amber-inspect",
        "trajectory",
        "tests/fixtures/amber/md.nc",
        "--json",
      ],
      cwd: process.cwd(),
      env: { ...process.env, PYTHONPATH: `${process.cwd()}/python/src` },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(output.exitCode).toBe(0);
    const observed = JSON.parse(new TextDecoder().decode(output.stdout));
    expect(observed.observedContentDigest).toBe(
      "10e8c3e6c0edc193456dff3e7317e8ec09cb042f53a6c679d0df22be9d25e29f",
    );

    const bound = bindAmberTrajectoryInspection(observed, {
      artifactId: "trajectory-amber26-smoke",
      evidenceRef: "trajectory-amber26-smoke-evidence",
      expectedContentDigest: "10e8c3e6c0edc193456dff3e7317e8ec09cb042f53a6c679d0df22be9d25e29f",
      operationReceiptRef: "receipt-amber26-smoke",
    });
    expect(bound.inspectionLevel).toBe("decoded_netcdf");
    expect(bound.frameCount).toBe(5);
    expect(bound.byteEvidence?.finiteValues).toBe(true);
  });

  test("accepts the bundled Python decoder's single-frame NetCDF restart response", () => {
    const output = Bun.spawnSync({
      cmd: [
        "python",
        "-m",
        "eigengrid_chem",
        "amber-inspect",
        "restart",
        "tests/fixtures/amber/md.rst7",
        "--json",
      ],
      cwd: process.cwd(),
      env: { ...process.env, PYTHONPATH: `${process.cwd()}/python/src` },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(output.exitCode).toBe(0);
    const observed = assertAmberByteInspection(JSON.parse(new TextDecoder().decode(output.stdout)));
    expect(observed.artifactKind).toBe("restart");
    expect(observed.frameCount).toBe(1);
    expect(observed.time.status).toBe("single_frame");
  });

  test("accepts bundled ASCII restart and prmtop byte observations", () => {
    for (const [kind, path] of [
      ["restart", "tests/fixtures/amber/water.inpcrd"],
      ["prmtop", "tests/fixtures/amber/water.prmtop"],
    ] as const) {
      const output = Bun.spawnSync({
        cmd: ["python", "-m", "eigengrid_chem", "amber-inspect", kind, path, "--json"],
        cwd: process.cwd(),
        env: { ...process.env, PYTHONPATH: `${process.cwd()}/python/src` },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(output.exitCode).toBe(0);
      const observed = assertAmberByteInspection(
        JSON.parse(new TextDecoder().decode(output.stdout)),
      );
      expect(observed.artifactKind).toBe(kind);
      expect(observed.atomCount).toBe(3);
    }
  });

  test("binds a decoded observation to one exact trajectory artifact", () => {
    const bound = bindAmberTrajectoryInspection(decodedTrajectory(), {
      artifactId: "trajectory-a",
      evidenceRef: "trajectory-evidence-a",
      expectedContentDigest: digest("a"),
      operationReceiptRef: "receipt-a",
    });

    expect(bound).toMatchObject({
      artifactId: "trajectory-a",
      evidenceRef: "trajectory-evidence-a",
      expectedContentDigest: digest("a"),
      observedContentDigest: digest("a"),
      inspectionLevel: "decoded_netcdf",
      readStatus: "complete",
      atomCount: 3,
      frameCount: 5,
      byteEvidence: expect.objectContaining({ finiteValues: true }),
    });
    expect(observedAmberTimeResolutionPs(decodedTrajectory())).toBe(5.96e-10);
  });

  test("preserves an observed checksum mismatch instead of trusting canonical metadata", () => {
    const bound = bindAmberTrajectoryInspection(decodedTrajectory(), {
      artifactId: "trajectory-a",
      evidenceRef: "trajectory-evidence-a",
      expectedContentDigest: digest("b"),
      operationReceiptRef: "receipt-a",
    });

    expect(bound.expectedContentDigest).toBe(digest("b"));
    expect(bound.observedContentDigest).toBe(digest("a"));
  });

  test("metadata-only observations cannot be upgraded into decoded claims", () => {
    const metadataOnly = decodedTrajectory({
      inspectionLevel: "metadata_only",
      convention: null,
      atomCount: null,
      frameCount: null,
      hasPeriodicBox: null,
      finiteValues: null,
      dimensions: {},
      time: {
        status: "not_applicable",
        cadenceStatus: "not_applicable",
        count: 0,
        firstPs: null,
        lastPs: null,
        minDeltaPs: null,
        maxDeltaPs: null,
        precisionPs: null,
      },
      cell: { status: "not_applicable", frameCount: null, variableAcrossFrames: null },
      diagnostics: [
        {
          code: "metadata_only",
          severity: "warning",
          message: "Digest only",
        },
      ],
    });
    const bound = bindAmberTrajectoryInspection(metadataOnly, {
      artifactId: "trajectory-a",
      evidenceRef: "trajectory-evidence-a",
      expectedContentDigest: digest("a"),
      operationReceiptRef: "receipt-a",
    });

    expect(bound.inspectionLevel).toBe("metadata_only");
    expect(bound.atomCount).toBeNull();
    expect(() =>
      assertAmberByteInspection({
        ...metadataOnly,
        atomCount: 3,
      }),
    ).toThrow(/Metadata-only/u);
  });

  test("retains byte-decoder diagnostics under the exact artifact evidence reference", () => {
    const bound = bindAmberTrajectoryInspection(
      decodedTrajectory({
        finiteValues: false,
        diagnostics: [
          {
            code: "non_finite_coordinates",
            severity: "error",
            message: "Coordinate bytes contain NaN",
          },
        ],
      }),
      {
        artifactId: "trajectory-a",
        evidenceRef: "trajectory-evidence-a",
        expectedContentDigest: digest("a"),
        operationReceiptRef: "receipt-a",
      },
    );

    expect(bound.diagnostics).toEqual(
      expect.arrayContaining([
        {
          code: "non_finite_coordinates",
          severity: "error",
          message: "Coordinate bytes contain NaN",
          evidenceRefs: ["trajectory-evidence-a"],
        },
        expect.objectContaining({
          code: "trajectory_non_finite_values",
          severity: "error",
          evidenceRefs: ["trajectory-evidence-a"],
        }),
      ]),
    );
  });

  test("rejects invalid byte observations without an error diagnostic and preserves them when bound", () => {
    expect(() =>
      assertAmberByteInspection(
        decodedTrajectory({
          finiteValues: false,
          time: { ...decodedTrajectory().time, status: "duplicate", cadenceStatus: "irregular" },
        }),
      ),
    ).toThrow(/error diagnostic/u);

    const observed = decodedTrajectory({
      finiteValues: false,
      time: { ...decodedTrajectory().time, status: "duplicate", cadenceStatus: "irregular" },
      diagnostics: [
        {
          code: "decoder_detected_invalid_trajectory",
          severity: "error",
          message: "Fixture intentionally contains non-finite values and duplicate times",
        },
      ],
    });
    const bound = bindAmberTrajectoryInspection(observed, {
      artifactId: "trajectory-a",
      evidenceRef: "trajectory-evidence-a",
      expectedContentDigest: digest("a"),
      operationReceiptRef: "receipt-a",
    });
    expect(bound.byteEvidence).toMatchObject({
      finiteValues: false,
      time: { status: "duplicate" },
    });
    expect(bound.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "trajectory_non_finite_values", severity: "error" }),
        expect.objectContaining({ code: "trajectory_invalid_time_observation", severity: "error" }),
      ]),
    );
  });
});

describe("AMBER minimization parser boundary", () => {
  test("requires an actual FINAL RESULTS row and terminal marker for completed", () => {
    const parsed = assertAmberMinimizationParseResult({
      schemaVersion: AmberMinimizationParseSchemaVersion,
      parser: { id: "eigengrid_chem.amber.byte-inspector", version: "0.1.0" },
      observedContentDigest: digest("c"),
      byteLength: 1024,
      status: "completed",
      terminalMarkerObserved: true,
      finalResultsMarkerObserved: true,
      convergenceStatus: "not_assessed",
      samples: [
        {
          step: 16,
          energyKcalMol: 3.0614e-11,
          rmsGradientKcalMolAngstrom: 7.5114e-5,
          gmaxKcalMolAngstrom: 1.3309e-4,
          maxGradientAtomName: "O",
          maxGradientAtomNumber: 1,
          line: 269,
        },
      ],
      final: {
        step: 16,
        energyKcalMol: 3.0614e-11,
        rmsGradientKcalMolAngstrom: 7.5114e-5,
        gmaxKcalMolAngstrom: 1.3309e-4,
        maxGradientAtomName: "O",
        maxGradientAtomNumber: 1,
        line: 269,
      },
      diagnostics: [],
    });
    expect(parsed.status).toBe("completed");

    expect(() =>
      assertAmberMinimizationParseResult({
        ...parsed,
        final: null,
        finalResultsMarkerObserved: false,
      }),
    ).toThrow(/FINAL RESULTS/u);
  });
});
