import { describe, expect, test } from "bun:test";
import {
  computeMdStageResultDigest,
  digestBytes,
  digestCanonical,
} from "@eigengrid/scientific-schema";
import {
  CpptrajAnalysisPlanSchemaVersion,
  assertCpptrajAnalysisPlan,
  assertCpptrajNormalizedMetricSeries,
  computeParsedCpptrajTableDigest,
  createCpptrajAnalysisPlan,
  createCpptrajTableParseRequest,
  normalizeCpptrajMetricSeries,
  parseCpptrajTable,
  renderCpptrajAnalysisPlan,
} from "../src/index";
import { SYNTHETIC_CPPTRAJ_WHITESPACE } from "../fixtures/synthetic";
import { artifact, sourceFor, trajectoryQcBindings, trajectorySegment } from "./helpers";

const SYNTHETIC_DISTANCE_WHITESPACE = "#Frame Distance\n1 3.20\n2 3.05\n3 2.98\n";

const rmsdOutputContract = {
  format: "whitespace" as const,
  headerStyle: "commented" as const,
  columns: [
    { sourceName: "Frame", valueKind: "integer" as const, semantic: "frame" as const },
    {
      sourceName: "LigandRMSD",
      valueKind: "number" as const,
      semantic: "value" as const,
      unit: "angstrom",
    },
  ],
  expectedRowCount: 3,
  normalization: {
    metric: "rmsd" as const,
    valueColumn: "LigandRMSD",
    unit: "angstrom",
    frameMapping: {
      frameColumn: "Frame",
      firstFrame: 1,
      firstStep: 100,
      cadenceSteps: 100,
      firstTimePs: 0.2,
      cadenceTimePs: 0.2,
    },
  },
};

const distanceOutputContract = {
  format: "whitespace" as const,
  headerStyle: "commented" as const,
  columns: [
    { sourceName: "Frame", valueKind: "integer" as const, semantic: "frame" as const },
    {
      sourceName: "Distance",
      valueKind: "number" as const,
      semantic: "value" as const,
      unit: "angstrom",
    },
  ],
  expectedRowCount: 3,
  normalization: {
    metric: "custom" as const,
    customMetricName: "cpptraj.distance.salt_bridge",
    valueColumn: "Distance",
    unit: "angstrom",
    frameMapping: {
      frameColumn: "Frame",
      firstFrame: 1,
      firstStep: 100,
      cadenceSteps: 100,
      firstTimePs: 0.2,
      cadenceTimePs: 0.2,
    },
  },
};

function plan() {
  const topology = artifact("topology", "a");
  const trajectory = artifact("trajectory", "b");
  const segment = trajectorySegment({
    id: "segment-cpptraj-0",
    index: 0,
    parent: artifact("restart", "c"),
    restart: artifact("restart", "d"),
    trajectory,
    startStep: 0,
    endStep: 300,
    startTimePs: 0,
    endTimePs: 0.6,
  });
  const bindings = trajectoryQcBindings([segment], topology);
  return createCpptrajAnalysisPlan({
    schemaVersion: CpptrajAnalysisPlanSchemaVersion,
    id: "cpptraj-plan-1",
    revision: 1,
    missionId: "mission-1",
    system: bindings.system,
    atomMap: bindings.atomMap,
    stageResult: bindings.stageResults[0]!,
    segment,
    topology: {
      artifact: topology,
      logicalPath: "inputs/system.prmtop",
    },
    trajectories: [
      {
        artifact: trajectory,
        logicalPath: "inputs/production-000.nc",
      },
    ],
    analyses: [
      {
        kind: "rmsd",
        name: "ligand_rmsd",
        outputPath: "outputs/ligand-rmsd.dat",
        outputFormat: "whitespace",
        outputContract: rmsdOutputContract,
        mask: ":LIG&!@H=",
        reference: "first",
        massWeighted: true,
      },
      {
        kind: "distance",
        name: "salt_bridge",
        outputPath: "outputs/salt-bridge.dat",
        outputFormat: "whitespace",
        outputContract: distanceOutputContract,
        mask1: ":1@NZ",
        mask2: ":2@OD1",
      },
    ],
    autoimage: true,
    cwd: "work",
    inputPath: "work/cpptraj.in",
    logPath: "outputs/cpptraj.log",
  });
}

function observation(content: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    source: sourceFor(content, name),
    executionCompletion: "confirmed" as const,
    operationReceiptRef: "cpptraj-receipt-1",
    exitCode: 0,
    signal: null,
    parser: { id: "cpptraj-table-parser", version: "1.0.0" },
    ...overrides,
  };
}

describe("closed CPPTRAJ plan rendering", () => {
  test.each(["0x10", "0b10", "0o10"])("rejects JavaScript-only numeric token %s", (token) => {
    const text = `#Frame LigandRMSD\n1 ${token}\n2 3.05\n3 2.98\n`;
    const result = parseCpptrajTable(text, plan(), "ligand_rmsd", observation(text, "ligand_rmsd"));
    expect(result.status).toBe("invalid");
    expect(result.diagnostics.some((d) => d.code === "invalid_numeric_value")).toBe(true);
  });
  test("renders deterministic argv and digest-binds each named output contract", () => {
    const value = plan();
    const first = renderCpptrajAnalysisPlan(value);
    const second = renderCpptrajAnalysisPlan(value);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      executable: "cpptraj",
      argv: ["-i", "work/cpptraj.in", "-o", "outputs/cpptraj.log"],
      shell: false,
    });
    expect(first.inputDigest).toBe(digestBytes(first.inputText));
    expect(first.inputText).toContain(
      "rms ligand_rmsd :LIG&!@H= first mass out outputs/ligand-rmsd.dat",
    );
    expect(first.inputs.map((input) => input.role)).toEqual(["topology", "trajectory.0"]);
    expect(first.outputs[0]).toMatchObject({
      role: "analysis.ligand_rmsd",
      outputName: "ligand_rmsd",
      outputContractDigest: digestCanonical(rmsdOutputContract),
    });
    expect(first.outputs.map((output) => output.logicalPath)).toEqual([
      "outputs/ligand-rmsd.dat",
      "outputs/salt-bridge.dat",
      "outputs/cpptraj.log",
    ]);
  });

  test("rejects command injection, digest tampering, and semantic relabeling in a new plan", () => {
    const value = plan();
    const rmsd = value.analyses[0]!;
    if (rmsd.kind !== "rmsd") throw new Error("Synthetic fixture expected an RMSD analysis");

    expect(() =>
      createCpptrajAnalysisPlan({
        ...value,
        analyses: [{ ...rmsd, mask: ":LIG\nrun" }],
      }),
    ).toThrow();
    expect(() => createCpptrajAnalysisPlan({ ...value, inputPath: "../escape.in" })).toThrow();
    expect(() => assertCpptrajAnalysisPlan({ ...value, autoimage: false })).toThrow(
      /digest mismatch/u,
    );
    expect(() => createCpptrajAnalysisPlan({ ...value, missionId: "mission-relabeled" })).toThrow(
      /exact mission/u,
    );
    expect(() =>
      createCpptrajAnalysisPlan({
        ...value,
        trajectories: [
          {
            ...value.trajectories[0]!,
            artifact: artifact("trajectory", "f"),
          },
        ],
      }),
    ).toThrow(/exact mission/u);

    const { resultDigest: _resultDigest, ...stageResultBase } = value.stageResult;
    const mismatchedResultBase = {
      ...stageResultBase,
      artifacts: stageResultBase.artifacts.map((candidate) =>
        candidate.role === "restart" ? { ...candidate, contentDigest: "0".repeat(64) } : candidate,
      ),
    };
    const mismatchedResult = {
      ...mismatchedResultBase,
      resultDigest: computeMdStageResultDigest(mismatchedResultBase),
    };
    expect(() => createCpptrajAnalysisPlan({ ...value, stageResult: mismatchedResult })).toThrow(
      /exact mission/u,
    );

    const relabeled = {
      ...rmsdOutputContract,
      columns: [
        rmsdOutputContract.columns[0]!,
        { ...rmsdOutputContract.columns[1]!, unit: "kelvin" },
      ],
      normalization: {
        ...rmsdOutputContract.normalization,
        metric: "temperature" as const,
        unit: "kelvin",
      },
    };
    expect(() =>
      createCpptrajAnalysisPlan({
        ...value,
        analyses: [{ ...rmsd, outputContract: relabeled }, value.analyses[1]!],
      }),
    ).toThrow(/RMSD outputs normalize only/u);
  });
});

describe("plan-derived CPPTRAJ table normalization", () => {
  test("derives metric, unit, frame mapping, and provenance from one exact named output", () => {
    const value = plan();
    const table = parseCpptrajTable(
      SYNTHETIC_CPPTRAJ_WHITESPACE,
      value,
      "ligand_rmsd",
      observation(SYNTHETIC_CPPTRAJ_WHITESPACE, "rmsd"),
    );
    expect(table.status).toBe("complete");
    expect(table.provenance).toMatchObject({
      planId: value.id,
      planRevision: value.revision,
      planDigest: value.planDigest,
      outputName: "ligand_rmsd",
      outputContractDigest: digestCanonical(rmsdOutputContract),
    });

    const normalized = normalizeCpptrajMetricSeries(table, value, "ligand_rmsd");
    expect(normalized.series).toMatchObject({
      stageResultId: "stage-result-0",
      replicaId: "replica-1",
      metric: "rmsd",
      unit: "angstrom",
      sourceArtifactRef: "rmsd-artifact",
    });
    expect(normalized.series.points).toEqual([
      { step: 100, timePs: 0.2, value: 0.12 },
      { step: 200, timePs: 0.4, value: 0.18 },
      { step: 300, timePs: 0.6000000000000001, value: 0.21 },
    ]);
    expect(normalized.provenance).toMatchObject({
      planId: value.id,
      planRevision: 1,
      planDigest: value.planDigest,
      outputName: "ligand_rmsd",
      operationReceiptRef: "cpptraj-receipt-1",
      parsedTableDigest: table.tableDigest,
    });
    expect(assertCpptrajNormalizedMetricSeries(normalized)).toEqual(normalized);
  });

  test("derives the exact namespaced distance metric instead of accepting a caller label", () => {
    const value = plan();
    const table = parseCpptrajTable(
      SYNTHETIC_DISTANCE_WHITESPACE,
      value,
      "salt_bridge",
      observation(SYNTHETIC_DISTANCE_WHITESPACE, "distance"),
    );
    const normalized = normalizeCpptrajMetricSeries(table, value, "salt_bridge");
    expect(normalized.series).toMatchObject({
      metric: "custom",
      customMetricName: "cpptraj.distance.salt_bridge",
      unit: "angstrom",
    });
  });

  test("rejects parse-time semantic overrides and normalization-time override arguments", () => {
    const value = plan();
    expect(() =>
      createCpptrajTableParseRequest(
        value,
        "ligand_rmsd",
        observation(SYNTHETIC_CPPTRAJ_WHITESPACE, "rmsd", {
          metric: "temperature",
          unit: "kelvin",
          columns: [],
          frameMapping: { frameColumn: "Other" },
        }),
      ),
    ).toThrow();

    const table = parseCpptrajTable(
      SYNTHETIC_CPPTRAJ_WHITESPACE,
      value,
      "ligand_rmsd",
      observation(SYNTHETIC_CPPTRAJ_WHITESPACE, "rmsd"),
    );
    expect(() =>
      (normalizeCpptrajMetricSeries as (...args: unknown[]) => unknown)(
        table,
        value,
        "ligand_rmsd",
        {
          metric: "temperature",
          unit: "kelvin",
          frameMapping: { frameColumn: "Frame", cadenceSteps: 1 },
        },
      ),
    ).toThrow(/does not accept .*overrides/u);
  });

  test("rejects stale plan revisions, output-name swaps, and recomputed table tampering", () => {
    const value = plan();
    const table = parseCpptrajTable(
      SYNTHETIC_CPPTRAJ_WHITESPACE,
      value,
      "ligand_rmsd",
      observation(SYNTHETIC_CPPTRAJ_WHITESPACE, "rmsd"),
    );
    const revisedPlan = createCpptrajAnalysisPlan({ ...value, revision: 2 });
    expect(() => normalizeCpptrajMetricSeries(table, revisedPlan, "ligand_rmsd")).toThrow(
      /exact plan output contract/u,
    );
    const rmsd = value.analyses[0]!;
    if (rmsd.kind !== "rmsd") throw new Error("Synthetic fixture expected an RMSD analysis");
    const remappedPlan = createCpptrajAnalysisPlan({
      ...value,
      analyses: [
        {
          ...rmsd,
          outputContract: {
            ...rmsd.outputContract,
            normalization: {
              ...rmsd.outputContract.normalization!,
              frameMapping: {
                ...rmsd.outputContract.normalization!.frameMapping,
                cadenceSteps: 200,
              },
            },
          },
        },
        value.analyses[1]!,
      ],
    });
    expect(() => normalizeCpptrajMetricSeries(table, remappedPlan, "ligand_rmsd")).toThrow(
      /exact plan output contract/u,
    );
    expect(() => normalizeCpptrajMetricSeries(table, value, "salt_bridge")).toThrow(
      /exact plan output contract/u,
    );

    const swappedBase = {
      ...table,
      provenance: { ...table.provenance, outputName: "salt_bridge" },
    };
    const swapped = {
      ...swappedBase,
      tableDigest: computeParsedCpptrajTableDigest(swappedBase),
    };
    expect(() => normalizeCpptrajMetricSeries(swapped, value, "ligand_rmsd")).toThrow(
      /exact plan output contract/u,
    );

    const normalized = normalizeCpptrajMetricSeries(table, value, "ligand_rmsd");
    const forgedProvenance = { ...normalized.provenance, planId: "forged-plan" };
    expect(() =>
      assertCpptrajNormalizedMetricSeries({
        ...normalized,
        provenance: forgedProvenance,
        provenanceDigest: digestCanonical(forgedProvenance),
      }),
    ).toThrow(/does not bind its exact provenance/u);
  });

  test("keeps incomplete output non-normalizable and rejects corrupt bytes or receipts", () => {
    const value = plan();
    const partial = parseCpptrajTable(
      SYNTHETIC_CPPTRAJ_WHITESPACE,
      value,
      "ligand_rmsd",
      observation(SYNTHETIC_CPPTRAJ_WHITESPACE, "rmsd", {
        executionCompletion: "unconfirmed",
        operationReceiptRef: undefined,
        exitCode: null,
      }),
    );
    expect(partial.status).toBe("partial");
    expect(() => normalizeCpptrajMetricSeries(partial, value, "ligand_rmsd")).toThrow(
      /Cannot normalize/u,
    );

    const corrupt = parseCpptrajTable(
      `${SYNTHETIC_CPPTRAJ_WHITESPACE}4 ****\n`,
      value,
      "ligand_rmsd",
      observation(SYNTHETIC_CPPTRAJ_WHITESPACE, "rmsd"),
    );
    expect(corrupt.status).toBe("invalid");
    expect(corrupt.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["source_digest_mismatch", "invalid_numeric_value"]),
    );

    const failedProcess = parseCpptrajTable(
      SYNTHETIC_CPPTRAJ_WHITESPACE,
      value,
      "ligand_rmsd",
      observation(SYNTHETIC_CPPTRAJ_WHITESPACE, "rmsd", {
        operationReceiptRef: "cpptraj-failed-receipt",
        exitCode: 9,
      }),
    );
    expect(failedProcess.status).toBe("invalid");
    expect(failedProcess.diagnostics.map((item) => item.code)).toContain("analysis_process_failed");

    expect(() =>
      parseCpptrajTable(
        SYNTHETIC_CPPTRAJ_WHITESPACE,
        value,
        "ligand_rmsd",
        observation(SYNTHETIC_CPPTRAJ_WHITESPACE, "rmsd", {
          operationReceiptRef: undefined,
        }),
      ),
    ).toThrow(/exact receipt/u);
  });
});
