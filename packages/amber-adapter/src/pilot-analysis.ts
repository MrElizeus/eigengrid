import {
  AtomMapSchema,
  BiomolecularSystemManifestReferenceSchema,
  MdStageResultSchema,
  TrajectorySegmentSchema,
  assertMdStageResultDigest,
  assertTrajectorySegmentDigest,
} from "@eigengrid/scientific-schema";
import { z } from "zod";
import { assertCanonicalAtomMapDigest } from "./atom-map";
import { sha256Bytes, sha256Canonical } from "./canonical";
import {
  CommandInputSchema,
  LogicalPathSchema,
  Sha256Schema,
  commandRequestDigest,
} from "./contracts";
import { CpptrajFrameWindowSchema, renderCpptrajPlan } from "./cpptraj";
import { AmberEnvironmentManifestSchema } from "./environment";
import { createAmberHostExecutionRequest } from "./execution";

const id = z.string().min(1).max(256);
const boundedStep = z.number().int().nonnegative().max(1_000_000_000_000);
const boundedTime = z.number().finite().nonnegative().max(1_000_000_000);
export const AmberPilotAnalysisRequestSchema = z
  .object({
    missionId: id,
    system: BiomolecularSystemManifestReferenceSchema,
    atomMap: AtomMapSchema,
    stageResult: MdStageResultSchema,
    segment: TrajectorySegmentSchema,
    topology: CommandInputSchema,
    trajectory: CommandInputSchema,
    environment: AmberEnvironmentManifestSchema,
    soluteComponentId: id,
    window: CpptrajFrameWindowSchema,
    /** Explicit source-frame mapping, never guessed from a trajectory filename. */
    frameMapping: z
      .object({
        firstStep: boundedStep,
        firstTimePs: boundedTime,
        cadenceSteps: boundedStep.refine((value) => value > 0),
        cadenceTimePs: boundedTime.refine((value) => value > 0),
      })
      .strict(),
    workspace: LogicalPathSchema,
  })
  .strict();
export type AmberPilotAnalysisRequest = z.infer<typeof AmberPilotAnalysisRequestSchema>;
export const AmberPilotMetricSchema = z.enum(["phi", "psi", "rmsd", "rg"]);
export type AmberPilotMetric = z.infer<typeof AmberPilotMetricSchema>;
const metrics = AmberPilotMetricSchema.options;
const maximumRows = 100_000;
const maximumTableBytes = 8 * 1024 * 1024;

/**
 * Bounded ACE–ALA–NME analysis. Atom masks are derived solely from the exact
 * canonical map. No raw masks, expressions, alternate metrics or scripts enter
 * this API. Planning grants no scientific approval or execution authority.
 */
export function renderAmberPilotAnalysis(value: unknown) {
  const request = AmberPilotAnalysisRequestSchema.parse(value);
  const map = assertCanonicalAtomMapDigest(request.atomMap, request.system.atomMapDigest);
  const stage = assertMdStageResultDigest(request.stageResult);
  const segment = assertTrajectorySegmentDigest(request.segment);
  const trajectory = stage.artifacts.find((artifact) => artifact.role === "trajectory");
  const restart = stage.artifacts.find((artifact) => artifact.role === "restart");
  if (
    request.system.systemClass !== "soluble" ||
    map.atomCount > 5_000 ||
    map.systemManifestId !== request.system.id ||
    map.systemManifestRevision !== request.system.revision ||
    map.topologyDigest !== request.system.topologyDigest ||
    map.coordinateDigest !== request.system.coordinateDigest ||
    request.topology.sha256 !== map.topologyDigest ||
    request.trajectory.sha256 !== segment.trajectory.contentDigest ||
    request.trajectory.mediaType !== segment.trajectory.mediaType ||
    stage.missionId !== request.missionId ||
    segment.missionId !== request.missionId ||
    stage.id !== segment.stageResultId ||
    stage.replicaId !== segment.replicaId ||
    stage.segmentIndex !== segment.segmentIndex ||
    stage.parentRestartDigest !== segment.parentRestart.contentDigest ||
    stage.startStep !== segment.startStep ||
    stage.endStep !== segment.endStep ||
    stage.startTimePs !== segment.startTimePs ||
    stage.endTimePs !== segment.endTimePs ||
    stage.stageKind !== "production" ||
    stage.terminalReason !== "completed" ||
    stage.validationStatus !== "passed" ||
    stage.exitCode !== 0 ||
    stage.signal !== null ||
    stage.errors.length > 0 ||
    segment.continuity.status !== "verified" ||
    segment.netcdf.atomCount !== map.atomCount ||
    !segment.netcdf.hasPeriodicBox ||
    segment.continuity.expectedStartStep !== segment.startStep ||
    segment.continuity.expectedStartTimePs !== segment.startTimePs ||
    trajectory === undefined ||
    restart === undefined ||
    sha256Canonical(trajectory) !== sha256Canonical(segment.trajectory) ||
    sha256Canonical(restart) !== sha256Canonical(segment.restart)
  )
    throw new Error(
      "Pilot analysis must bind one exact validated production mission, system, AtomMap, segment and artifact inventory",
    );

  const window = request.window;
  const expectedRows = Math.floor((window.last - window.first) / window.stride) + 1;
  const mapping = request.frameMapping;
  const finalSourceStep = mapping.firstStep + (segment.frameCount - 1) * mapping.cadenceSteps;
  const finalSourceTime = mapping.firstTimePs + (segment.frameCount - 1) * mapping.cadenceTimePs;
  if (
    window.last > segment.frameCount ||
    expectedRows > maximumRows ||
    !Number.isSafeInteger(finalSourceStep) ||
    !Number.isFinite(finalSourceTime) ||
    mapping.firstStep < segment.startStep ||
    finalSourceStep > segment.endStep ||
    mapping.firstTimePs < segment.startTimePs ||
    finalSourceTime > segment.endTimePs + 1e-9
  ) {
    throw new Error(
      "Pilot frame window and explicit frame mapping must fit the exact segment and bounded row count",
    );
  }
  const solute = map.entries.filter((atom) => atom.componentId === request.soluteComponentId);
  if (
    solute.length !== 22 ||
    solute.some((atom, index) => atom.systemAtomIndex !== index + 1) ||
    map.entries.slice(22).some((atom) => atom.residueName !== "WAT")
  ) {
    throw new Error(
      "Pilot selection requires exactly the 22 capped alanine atoms followed only by water",
    );
  }
  const residueIds = [...new Set(solute.map((atom) => atom.residueIndex))];
  const expected = [
    ["ACE", ["CH3", "HH31", "HH32", "HH33", "C", "O"]],
    ["ALA", ["N", "H", "CA", "HA", "CB", "HB1", "HB2", "HB3", "C", "O"]],
    ["NME", ["N", "H", "CH3", "HH31", "HH32", "HH33"]],
  ] as const;
  if (
    residueIds.length !== 3 ||
    expected.some(([name, names], index) => {
      const atoms = solute.filter((atom) => atom.residueIndex === residueIds[index]);
      return (
        atoms.some((atom) => atom.residueName !== name || atom.element !== atom.atomName[0]) ||
        atoms
          .map((atom) => atom.atomName)
          .sort()
          .join("\0") !== [...names].sort().join("\0")
      );
    })
  )
    throw new Error(
      "Pilot AtomMap must contain exact ACE, ALA and NME residue identities without missing or duplicate atoms",
    );
  const atom = (residue: number, name: string) =>
    solute.find((entry) => entry.residueIndex === residueIds[residue] && entry.atomName === name)!
      .systemAtomIndex;
  const phi: [number, number, number, number] = [
    atom(0, "C"),
    atom(1, "N"),
    atom(1, "CA"),
    atom(1, "C"),
  ];
  const psi: [number, number, number, number] = [
    atom(1, "N"),
    atom(1, "CA"),
    atom(1, "C"),
    atom(2, "N"),
  ];
  const heavy = solute
    .filter((entry) => entry.element !== "H")
    .map((entry) => entry.systemAtomIndex);
  const anchor = solute.map((entry) => entry.systemAtomIndex);
  const root = request.workspace;
  const rendered = renderCpptrajPlan({
    topology: request.topology,
    trajectories: [request.trajectory],
    trajectoryWindows: [window],
    autoimage: true,
    autoimageAnchor: anchor,
    analyses: [
      { kind: "dihedral", name: "phi", atomIndices: phi, outputPath: `${root}/phi.dat` },
      { kind: "dihedral", name: "psi", atomIndices: psi, outputPath: `${root}/psi.dat` },
      {
        kind: "rmsd_atoms",
        name: "rmsd",
        atomIndices: heavy,
        reference: "first",
        massWeighted: false,
        outputPath: `${root}/rmsd.dat`,
      },
      {
        kind: "radius_of_gyration",
        name: "rg",
        atomIndices: heavy,
        massWeighted: false,
        outputPath: `${root}/rg.dat`,
      },
    ],
    scriptPath: `${root}/cpptraj.in`,
    logPath: `${root}/cpptraj.log`,
    cwd: root,
  });
  const execution = createAmberHostExecutionRequest(rendered.command, request.environment);
  const material = {
    schemaVersion: "eigengrid.amber-pilot-analysis/v1" as const,
    rendererVersion: "1.0.0" as const,
    executionEligibility: "requires_exact_scientific_and_site_authority" as const,
    missionId: request.missionId,
    system: request.system,
    atomMapDigest: map.mapDigest,
    stageResultDigest: stage.resultDigest,
    segmentDigest: segment.segmentDigest,
    inputArtifacts: { topology: request.topology, trajectory: request.trajectory },
    executionBinding: execution.binding,
    selections: { phi, psi, heavy, anchor },
    imaging: "autoimage_solute_anchor" as const,
    rmsdReference: { kind: "first_selected_frame" as const, sourceFrame: window.first },
    massWeighted: false as const,
    window,
    frameMapping: mapping,
    expectedRows,
    outputContracts: metrics.map((metric, index) => ({
      metric,
      role: `analysis.${index}`,
      path: `${root}/${metric}.dat`,
      columns: ["Frame", metric],
      unit: metric === "phi" || metric === "psi" ? ("degree" as const) : ("angstrom" as const),
    })),
    scriptDigest: rendered.input.sha256,
    commandDigest: commandRequestDigest(rendered.command),
  };
  return { ...rendered, manifest: { ...material, analysisPlanDigest: sha256Canonical(material) } };
}

export type RenderedAmberPilotAnalysis = ReturnType<typeof renderAmberPilotAnalysis>;

const receiptSchema = z
  .object({
    operationReceiptId: id,
    analysisPlanDigest: Sha256Schema,
    commandDigest: Sha256Schema,
    exitCode: z.number().int().nonnegative().nullable(),
    signal: z.string().min(1).max(64).nullable(),
    outputDigests: z.record(z.string(), Sha256Schema),
  })
  .strict()
  .refine(
    (value) => (value.exitCode === null) !== (value.signal === null),
    "Exactly one terminal exit or signal observation is required",
  );
export const AmberPilotAnalysisObservationSchema = z
  .object({
    receipt: receiptSchema,
    log: z.string().max(1_048_576),
    tables: z
      .object({
        phi: z.string().max(maximumTableBytes),
        psi: z.string().max(maximumTableBytes),
        rmsd: z.string().max(maximumTableBytes),
        rg: z.string().max(maximumTableBytes),
      })
      .strict(),
  })
  .strict();
export type AmberPilotAnalysisObservation = z.infer<typeof AmberPilotAnalysisObservationSchema>;

export interface AmberPilotAnalysisFinding {
  code: string;
  metric?: AmberPilotMetric;
  line?: number;
  message: string;
}
export interface AmberPilotAnalysisPoint {
  frame: number;
  sourceFrame: number;
  step: number;
  timePs: number;
  value: number;
}

/**
 * Verify bounded numeric output bytes against an exact caller-supplied receipt.
 * Receipt authenticity belongs to the durable runtime. This inspects derived
 * tables; it does not decode or certify the input trajectory or judge science.
 */
export function inspectAmberPilotAnalysis(requestValue: unknown, observationValue: unknown) {
  const plan = renderAmberPilotAnalysis(requestValue);
  const observation = AmberPilotAnalysisObservationSchema.parse(observationValue);
  const receipt = observation.receipt;
  if (
    receipt.analysisPlanDigest !== plan.manifest.analysisPlanDigest ||
    receipt.commandDigest !== plan.manifest.commandDigest
  )
    throw new Error("CPPTRAJ receipt does not bind the exact analysis plan and command");
  const expectedRoles = plan.command.outputs.map((output) => output.role).sort();
  if (Object.keys(receipt.outputDigests).sort().join("\0") !== expectedRoles.join("\0"))
    throw new Error("CPPTRAJ receipt must inventory every exact table and log output");
  const findings: AmberPilotAnalysisFinding[] = [];
  if (receipt.exitCode !== 0 || receipt.signal !== null)
    findings.push({ code: "process_failed", message: "CPPTRAJ did not exit successfully" });
  if (sha256Bytes(observation.log) !== receipt.outputDigests["cpptraj.log"])
    findings.push({
      code: "log_digest_mismatch",
      message: "CPPTRAJ log bytes differ from the receipt",
    });
  if (!/\bRUN END\b/u.test(observation.log))
    findings.push({
      code: "incomplete_log",
      message: "CPPTRAJ log has no completed RUN END marker",
    });
  if (
    /^\s*(?:Error:|Warning:|FATAL\b)|\b(?:Segmentation fault|No atoms selected|0 atoms selected)\b/imu.test(
      observation.log,
    )
  )
    findings.push({
      code: "log_diagnostic",
      message: "CPPTRAJ reported an error, warning or empty selection requiring review",
    });
  const series: Array<{
    metric: AmberPilotMetric;
    unit: "degree" | "angstrom";
    points: AmberPilotAnalysisPoint[];
    sourceDigest: string;
  }> = [];
  const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/u;
  for (const contract of plan.manifest.outputContracts) {
    const text = observation.tables[contract.metric];
    const sourceDigest = sha256Bytes(text);
    const points: AmberPilotAnalysisPoint[] = [];
    series.push({ metric: contract.metric, unit: contract.unit, points, sourceDigest });
    const add = (code: string, message: string, line?: number) =>
      findings.push({
        code,
        metric: contract.metric,
        ...(line === undefined ? {} : { line }),
        message,
      });
    if (sourceDigest !== receipt.outputDigests[contract.role]) {
      add("table_digest_mismatch", "Table bytes differ from the exact receipt");
      continue;
    }
    if (Buffer.byteLength(text, "utf8") > maximumTableBytes) {
      add("table_too_large", "Table exceeds the bounded byte limit");
      continue;
    }
    // CPPTRAJ 59b4b25af93785d0b0cb2dcd9ae82bebb78cd453:
    // src/Action_Radgyr.cpp keeps the supplied name; nomax omits [Max].
    // src/DataSet.cpp and src/DataIO_Std.cpp write Frame starting at one.
    // src/CpptrajState.cpp increments actionSet for each processed frame,
    // so source trajin offsets belong in our separate sourceFrame mapping.
    // https://github.com/Amber-MD/cpptraj/tree/59b4b25af93785d0b0cb2dcd9ae82bebb78cd453
    let header = false;
    let row = 0;
    // Iterate lines without allocating an unbounded array for pathological input.
    let start = 0;
    let lineNumber = 0;
    while (start < text.length) {
      const end = text.indexOf("\n", start);
      const lineEnd = end < 0 ? text.length : end;
      lineNumber += 1;
      if (lineEnd - start > 1024) {
        add("line_too_long", "Table line exceeds the bounded line length", lineNumber);
        break;
      }
      const line = text.slice(start, lineEnd).trim();
      start = lineEnd + 1;
      if (!line) continue;
      if (!header) {
        if (line.split(/\s+/u).join(" ") !== `#Frame ${contract.metric}`) {
          add("header_mismatch", "Table header differs from the exact metric contract", lineNumber);
          break;
        }
        header = true;
        continue;
      }
      row += 1;
      if (row > plan.manifest.expectedRows) {
        add(
          "unexpected_frame_count",
          "Table has more rows than the selected frame window",
          lineNumber,
        );
        break;
      }
      const columns = line.split(/\s+/u);
      if (columns.length !== 2 || columns.some((column) => !decimal.test(column))) {
        add("invalid_numeric_row", "Expected exactly two finite decimal numbers", lineNumber);
        break;
      }
      const frame = Number(columns[0]!.replace(/[dD]/u, "E"));
      const value = Number(columns[1]!.replace(/[dD]/u, "E"));
      if (!Number.isFinite(value) || !Number.isSafeInteger(frame) || frame !== row) {
        add(
          "invalid_frame_or_value",
          "Frame indices must be contiguous from one and values finite",
          lineNumber,
        );
        break;
      }
      const angular = contract.unit === "degree";
      if (angular ? value < -180 || value > 180 : value < 0) {
        add(
          "value_out_of_range",
          "Metric value is outside its defined numerical range",
          lineNumber,
        );
        break;
      }
      const sourceFrame = plan.manifest.window.first + (frame - 1) * plan.manifest.window.stride;
      const mapping = plan.manifest.frameMapping;
      points.push({
        frame,
        sourceFrame,
        step: mapping.firstStep + (sourceFrame - 1) * mapping.cadenceSteps,
        timePs: mapping.firstTimePs + (sourceFrame - 1) * mapping.cadenceTimePs,
        value,
      });
    }
    if (!header) add("missing_header", "Table has no exact metric header");
    if (points.length !== plan.manifest.expectedRows)
      add("incomplete_frame_count", "Table does not contain every selected frame");
  }
  const unsigned = {
    schemaVersion: "eigengrid.amber-pilot-analysis-inspection/v1" as const,
    parserVersion: "1.0.0" as const,
    scope: "derived_table_integrity" as const,
    scientificAssessment: "not_performed" as const,
    trajectoryBytesDecoded: false as const,
    scientificApprovalGranted: false as const,
    analysisPlanDigest: plan.manifest.analysisPlanDigest,
    execution:
      receipt.exitCode === 0 && receipt.signal === null
        ? ("completed" as const)
        : ("failed" as const),
    status: findings.length === 0 ? ("valid" as const) : ("invalid" as const),
    receipt,
    findings,
    series,
  };
  return { ...unsigned, inspectionDigest: sha256Canonical(unsigned) };
}
