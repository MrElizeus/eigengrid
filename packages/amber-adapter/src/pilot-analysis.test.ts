import { describe, expect, test } from "bun:test";
import {
  computeAtomMapDigest,
  computeMdStageResultDigest,
  computeTrajectorySegmentDigest,
  type AtomMapEntry,
  type MdArtifactReference,
} from "@eigengrid/scientific-schema";
import { sha256Bytes, sha256Canonical } from "./canonical";
import { AmberExecutableSchema } from "./contracts";
import {
  renderAmberPilotAnalysis,
  inspectAmberPilotAnalysis,
  type AmberPilotAnalysisRequest,
  type AmberPilotAnalysisObservation,
} from "./pilot-analysis";

const digest = (value: string) => value.repeat(64);
const artifact = (role: MdArtifactReference["role"], value: string): MdArtifactReference => ({
  role,
  artifactId: `${role}-${value}`,
  evidenceRef: `${role}-evidence-${value}`,
  contentDigest: digest(value),
  mediaType: "application/octet-stream",
});

/** Synthetic canonical contracts exercise planning only; no trajectory was run. */
function fixture(): AmberPilotAnalysisRequest {
  const entries: AtomMapEntry[] = [];
  for (const [residueIndex, [residueName, atoms]] of (
    [
      ["ACE", ["HH31", "CH3", "HH32", "HH33", "C", "O"]],
      ["ALA", ["N", "H", "CA", "HA", "CB", "HB1", "HB2", "HB3", "C", "O"]],
      ["NME", ["N", "H", "CH3", "HH31", "HH32", "HH33"]],
      ["WAT", ["O", "H1", "H2"]],
    ] as const
  ).entries())
    for (const atomName of atoms)
      entries.push({
        systemAtomIndex: entries.length + 1,
        componentId: residueName === "WAT" ? "water" : "solute",
        componentAtomIndex: residueName === "WAT" ? entries.length - 21 : entries.length + 1,
        residueIndex: residueIndex + 1,
        residueName,
        atomName,
        element: atomName[0]!,
      });
  const map = {
    schemaVersion: "eigengrid.atom-map/v1" as const,
    id: "atom-map",
    revision: 1,
    systemManifestId: "system",
    systemManifestRevision: 1,
    indexBase: 1 as const,
    topologyDigest: digest("a"),
    coordinateDigest: digest("b"),
    atomCount: entries.length,
    entries,
  };
  const atomMap = { ...map, mapDigest: computeAtomMapDigest(map) };
  const parent = artifact("restart", "c"),
    restart = artifact("restart", "d"),
    trajectory = artifact("trajectory", "e");
  const segment = {
    schemaVersion: "eigengrid.trajectory-segment/v1" as const,
    id: "segment",
    revision: 1,
    missionId: "mission",
    replicaId: "replica",
    stageResultId: "stage-result",
    segmentIndex: 0,
    parentRestart: parent,
    restart,
    trajectory,
    startStep: 0,
    endStep: 100,
    startTimePs: 0,
    endTimePs: 0.2,
    frameCount: 5,
    netcdf: {
      convention: "AMBER",
      atomCount: atomMap.atomCount,
      frameCount: 5,
      hasPeriodicBox: true,
    },
    continuity: {
      status: "verified" as const,
      expectedParentRestartDigest: parent.contentDigest,
      observedParentRestartDigest: parent.contentDigest,
      expectedStartStep: 0,
      observedStartStep: 0,
      expectedStartTimePs: 0,
      observedStartTimePs: 0,
      reason: "Synthetic exact-boundary fixture",
    },
    createdAt: "2026-09-25T00:00:00.000Z",
  };
  const stage = {
    schemaVersion: "eigengrid.md-stage-result/v1" as const,
    id: segment.stageResultId,
    revision: 1,
    missionId: segment.missionId,
    workUnitId: "work",
    operationId: "operation",
    operationReceiptId: "receipt",
    protocolId: "protocol",
    protocolRevision: 1,
    protocolDigest: digest("1"),
    stageId: "production",
    stageRevision: 1,
    stageDigest: digest("2"),
    stageKind: "production" as const,
    replicaSetId: "replicas",
    replicaSetRevision: 1,
    replicaSetDigest: digest("3"),
    replicaId: segment.replicaId,
    segmentIndex: 0,
    parentRestartDigest: parent.contentDigest,
    terminalReason: "completed" as const,
    exitCode: 0,
    signal: null,
    startedAt: "2026-09-25T00:00:00.000Z",
    finishedAt: "2026-09-25T00:01:00.000Z",
    startStep: segment.startStep,
    endStep: segment.endStep,
    startTimePs: segment.startTimePs,
    endTimePs: segment.endTimePs,
    engine: {
      engine: "amber",
      executable: "sander",
      version: "26",
      buildDigest: digest("4"),
      environmentDigest: digest("5"),
      compatibilityVersion: "1.0.0",
    },
    artifacts: [restart, trajectory, artifact("mdout", "6"), artifact("mdinfo", "7")],
    warnings: [],
    errors: [],
    validationStatus: "passed" as const,
    validationRefs: ["synthetic-validation"],
  };
  const observations = AmberExecutableSchema.options.map((executable) =>
    executable === "cpptraj"
      ? { executable, available: true, version: "synthetic-26", binarySha256: digest("8") }
      : { executable, available: false },
  );
  return {
    missionId: segment.missionId,
    system: {
      id: "system",
      revision: 1,
      systemClass: "soluble",
      manifestDigest: digest("9"),
      topologyDigest: map.topologyDigest,
      coordinateDigest: map.coordinateDigest,
      atomMapDigest: atomMap.mapDigest,
    },
    atomMap,
    segment: { ...segment, segmentDigest: computeTrajectorySegmentDigest(segment) },
    stageResult: { ...stage, resultDigest: computeMdStageResultDigest(stage) },
    topology: {
      role: "topology",
      logicalPath: "inputs/system.prmtop",
      mediaType: "application/vnd.amber.prmtop",
      sha256: map.topologyDigest,
    },
    trajectory: {
      role: "trajectory",
      logicalPath: "inputs/production.nc",
      mediaType: trajectory.mediaType,
      sha256: trajectory.contentDigest,
    },
    environment: {
      schemaVersion: "amber-environment/v1",
      observations,
      environmentDigest: sha256Canonical(observations),
      capabilities: {
        amberToolsPreparation: false,
        referenceMd: false,
        optimizedCpuMd: false,
        gpuMd: false,
        trajectoryAnalysis: true,
      },
    },
    soluteComponentId: "solute",
    window: { first: 2, last: 5, stride: 2 },
    frameMapping: { firstStep: 20, firstTimePs: 0.04, cadenceSteps: 20, cadenceTimePs: 0.04 },
    workspace: "analysis",
  };
}

function observation(request = fixture()): AmberPilotAnalysisObservation {
  const plan = renderAmberPilotAnalysis(request);
  const log = "---------- RUN END ---------------------------------------------------\n";
  const tables = {
    phi: "#Frame phi\n1 -60\n2 -62\n",
    psi: "#Frame psi\n1 120\n2 130\n",
    rmsd: "#Frame rmsd\n1 0\n2 0.14\n",
    rg: "#Frame rg\n1 2.1\n2 2.2\n",
  };
  return {
    log,
    tables,
    receipt: {
      operationReceiptId: "analysis-receipt",
      analysisPlanDigest: plan.manifest.analysisPlanDigest,
      commandDigest: plan.manifest.commandDigest,
      exitCode: 0,
      signal: null,
      outputDigests: {
        "cpptraj.log": sha256Bytes(log),
        ...Object.fromEntries(
          plan.manifest.outputContracts.map((contract) => [
            contract.role,
            sha256Bytes(tables[contract.metric]),
          ]),
        ),
      },
    },
  };
}

describe("canonical capped alanine analysis", () => {
  test("derives deterministic dihedrals, heavy RMSD/Rg, imaging, and selected-frame reference", () => {
    const request = fixture();
    const first = renderAmberPilotAnalysis(request);
    expect(first).toEqual(renderAmberPilotAnalysis(structuredClone(request)));
    expect(first.input.content).toBe(
      [
        "parm inputs/system.prmtop",
        "trajin inputs/production.nc 2 5 2",
        "autoimage anchor @1-22",
        "dihedral phi @5 @7 @9 @15 out analysis/phi.dat",
        "dihedral psi @7 @9 @15 @17 out analysis/psi.dat",
        "rms rmsd @2,5-7,9,11,15-17,19 first out analysis/rmsd.dat",
        "radgyr rg @2,5-7,9,11,15-17,19 nomax out analysis/rg.dat",
        "run",
        "quit",
        "",
      ].join("\n"),
    );
    expect(first.manifest.expectedRows).toBe(2);
    expect(first.manifest.rmsdReference.sourceFrame).toBe(2);
    expect(first.command.inputs.map((input) => input.sha256)).toEqual([
      first.input.sha256,
      request.topology.sha256,
      request.trajectory.sha256,
    ]);
    expect(first.manifest.executionBinding.binarySha256).toBe(digest("8"));
  });

  test("material window, environment and map changes cannot reuse plan identity", () => {
    const request = fixture();
    const initial = renderAmberPilotAnalysis(request);
    request.window.first = 1;
    expect(renderAmberPilotAnalysis(request).manifest.analysisPlanDigest).not.toBe(
      initial.manifest.analysisPlanDigest,
    );
    request.environment.observations.find((item) => item.executable === "cpptraj")!.binarySha256 =
      digest("f");
    request.environment.environmentDigest = sha256Canonical(request.environment.observations);
    expect(renderAmberPilotAnalysis(request).manifest.analysisPlanDigest).not.toBe(
      initial.manifest.analysisPlanDigest,
    );
  });

  test("rejects raw masks, unknown metrics, empty selections, missing atoms and map reorder", () => {
    for (const extra of [{ mask: ":1-3" }, { metrics: ["unknown"] }, { rawScript: "quit" }])
      expect(() => renderAmberPilotAnalysis({ ...fixture(), ...extra })).toThrow();
    expect(() => renderAmberPilotAnalysis({ ...fixture(), soluteComponentId: "missing" })).toThrow(
      /22 capped/,
    );
    const missing = fixture();
    missing.atomMap.entries[4]!.atomName = "XX";
    missing.atomMap.mapDigest = computeAtomMapDigest(missing.atomMap);
    missing.system.atomMapDigest = missing.atomMap.mapDigest;
    expect(() => renderAmberPilotAnalysis(missing)).toThrow(/residue identities/);
    const reordered = fixture();
    [reordered.atomMap.entries[0], reordered.atomMap.entries[1]] = [
      reordered.atomMap.entries[1]!,
      reordered.atomMap.entries[0]!,
    ];
    reordered.atomMap.mapDigest = computeAtomMapDigest(reordered.atomMap);
    reordered.system.atomMapDigest = reordered.atomMap.mapDigest;
    expect(() => renderAmberPilotAnalysis(reordered)).toThrow(/ordered/);
  });

  test("rejects other missions, topology/trajectory drift, unvalidated sources and invalid windows", () => {
    for (const mutate of [
      (value: AmberPilotAnalysisRequest) => {
        value.missionId = "other";
      },
      (value: AmberPilotAnalysisRequest) => {
        value.topology.sha256 = digest("f");
      },
      (value: AmberPilotAnalysisRequest) => {
        value.trajectory.sha256 = digest("f");
      },
      (value: AmberPilotAnalysisRequest) => {
        value.stageResult.validationStatus = "not_run";
        value.stageResult.resultDigest = computeMdStageResultDigest(value.stageResult);
      },
      (value: AmberPilotAnalysisRequest) => {
        value.segment.netcdf.hasPeriodicBox = false;
        value.segment.segmentDigest = computeTrajectorySegmentDigest(value.segment);
      },
      (value: AmberPilotAnalysisRequest) => {
        value.window.last = 6;
      },
      (value: AmberPilotAnalysisRequest) => {
        value.window.first = 6;
      },
      (value: AmberPilotAnalysisRequest) => {
        value.window.stride = 0;
      },
      (value: AmberPilotAnalysisRequest) => {
        value.frameMapping.firstStep = 101;
      },
      (value: AmberPilotAnalysisRequest) => {
        value.frameMapping.cadenceTimePs = Infinity;
      },
    ]) {
      const request = fixture();
      mutate(request);
      expect(() => renderAmberPilotAnalysis(request)).toThrow();
    }
  });

  test("parses receipt-bound decimal tables with exact source frame, step, time and units", () => {
    const request = fixture();
    const result = inspectAmberPilotAnalysis(request, observation(request));
    expect(result.findings).toEqual([]);
    expect(result.status).toBe("valid");
    expect(result.series[0]!.points).toEqual([
      { frame: 1, sourceFrame: 2, step: 40, timePs: 0.08, value: -60 },
      { frame: 2, sourceFrame: 4, step: 80, timePs: 0.16, value: -62 },
    ]);
    expect(result.series.map((series) => series.unit)).toEqual([
      "degree",
      "degree",
      "angstrom",
      "angstrom",
    ]);
    expect(result.trajectoryBytesDecoded).toBe(false);
    expect(result.scientificAssessment).toBe("not_performed");
    expect(result.scientificApprovalGranted).toBe(false);
    expect(result).toEqual(inspectAmberPilotAnalysis(request, observation(request)));
  });

  test("refuses another plan, changed output bytes and incomplete receipt inventory", () => {
    const request = fixture();
    const observed = observation(request);
    expect(() => inspectAmberPilotAnalysis({ ...request, workspace: "other" }, observed)).toThrow(
      /exact analysis/,
    );
    observed.tables.phi += "3 0\n";
    expect(
      inspectAmberPilotAnalysis(request, observed).findings.some(
        (finding) => finding.code === "table_digest_mismatch",
      ),
    ).toBe(true);
    delete observed.receipt.outputDigests["analysis.0"];
    expect(() => inspectAmberPilotAnalysis(request, observed)).toThrow(/inventory/);
  });

  test("fails closed on malformed, nonfinite, duplicate, gapped, partial and out-of-range data", () => {
    for (const text of [
      "",
      "#Frame WRONG\n1 0\n2 1\n",
      "#Frame phi\n1 NaN\n2 1\n",
      "#Frame phi\n1 1e999\n2 1\n",
      "#Frame phi\n1 0x10\n2 1\n",
      "#Frame phi\n1 181\n2 1\n",
      "#Frame phi\n1 -181\n2 1\n",
      "#Frame phi\n1 0\n1 1\n",
      "#Frame phi\n1 0\n3 1\n",
      "#Frame phi\n1 0\n",
      "#Frame phi\n1 0\n2 1\n3 1\n",
      "#Frame phi\n1 0 EXTRA\n2 1\n",
      `#Frame phi\n${"0".repeat(1025)}\n`,
    ]) {
      const request = fixture();
      const observed = observation(request);
      observed.tables.phi = text;
      observed.receipt.outputDigests["analysis.0"] = sha256Bytes(text);
      expect(inspectAmberPilotAnalysis(request, observed).status).toBe("invalid");
    }
    const request = fixture();
    const observed = observation(request);
    observed.tables.rg = "#Frame rg\n1 -1\n2 2\n";
    observed.receipt.outputDigests["analysis.3"] = sha256Bytes(observed.tables.rg);
    expect(
      inspectAmberPilotAnalysis(request, observed).findings.some(
        (finding) => finding.code === "value_out_of_range",
      ),
    ).toBe(true);
  });

  test("rejects missing logs, wrong log bytes, errors/warnings and failed execution", () => {
    for (const log of [
      "",
      "RUN BEGIN\n",
      "Error: Invalid mask\nRUN END\n",
      "Warning: No atoms selected\nRUN END\n",
    ]) {
      const request = fixture();
      const observed = observation(request);
      observed.log = log;
      observed.receipt.outputDigests["cpptraj.log"] = sha256Bytes(log);
      expect(inspectAmberPilotAnalysis(request, observed).status).toBe("invalid");
    }
    const request = fixture();
    const observed = observation(request);
    observed.receipt.exitCode = 1;
    expect(inspectAmberPilotAnalysis(request, observed).execution).toBe("failed");
    observed.log += "changed";
    expect(
      inspectAmberPilotAnalysis(request, observed).findings.some(
        (finding) => finding.code === "log_digest_mismatch",
      ),
    ).toBe(true);
  });
});
