import { sha256Bytes } from "./canonical";
import {
  computeCanonicalAtomMapDigest,
  deriveAmberAtomMapView,
  type AmberAtomMapViewEntry,
} from "./atom-map";
import {
  commandRequestDigest,
  LogicalPathSchema,
  validateCommandSpec,
  type CommandInput,
  type CommandOutput,
  type CommandSpec,
  type LogicalPath,
} from "./contracts";
import { renderCpptrajPlan } from "./cpptraj";
import { renderLeapAssembly } from "./leap";
import { renderMdin, type MdStageSpec } from "./mdin";
import { renderAntechamber, renderParmchk2 } from "./parameterization";
import { parseLeapOutput } from "./leap-diagnostics";
import { parseFakeMdout, type FakeMdOutputParseResult } from "./parsers";
import { renderMdStageCommand } from "./stage";
import { validateAmberTopology, type AmberTopologyValidationResult } from "./validation";

export interface FakeArtifact {
  logicalPath: LogicalPath;
  mediaType: string;
  content: string;
  sha256: string;
}

export interface FakeExecutionReceipt {
  schemaVersion: "amber-fake-receipt/v1";
  requestDigest: string;
  status: "completed";
  artifacts: Array<{
    role: string;
    logicalPath: LogicalPath;
    mediaType: string;
    producedBy: "executable" | "captured_stdout" | "captured_stderr" | "captured_combined";
    sha256: string;
  }>;
}

function fixedWidth(values: number[], width: number, perLine: number, format: "int" | "float") {
  const rendered = values.map((value) =>
    format === "int"
      ? String(value).padStart(width)
      : value.toExponential(8).replace("e", "E").padStart(width),
  );
  const lines: string[] = [];
  for (let index = 0; index < rendered.length; index += perLine) {
    lines.push(rendered.slice(index, index + perLine).join(""));
  }
  return `${lines.join("\n")}\n`;
}

function fixedText(values: string[], width: number, perLine: number): string {
  const rendered = values.map((value) => value.slice(0, width).padEnd(width));
  const lines: string[] = [];
  for (let index = 0; index < rendered.length; index += perLine) {
    lines.push(rendered.slice(index, index + perLine).join(""));
  }
  return `${lines.join("\n")}\n`;
}

function fakePrmtop(): string {
  const pointers = Array.from({ length: 32 }, () => 0);
  pointers[0] = 3;
  pointers[1] = 3;
  pointers[3] = 1;
  pointers[11] = 2;
  pointers[15] = 1;
  pointers[18] = 3;
  pointers[27] = 1;
  pointers[28] = 2;
  return [
    "%VERSION  VERSION_STAMP = V0001.000  DATE = 01/01/70  00:00:00",
    "%FLAG TITLE",
    "%FORMAT(20a4)",
    "FAKE AMBER FIXTURE",
    "%FLAG POINTERS",
    "%FORMAT(10I8)",
    fixedWidth(pointers, 8, 10, "int").trimEnd(),
    "%FLAG ATOM_NAME",
    "%FORMAT(20a4)",
    fixedText(["CA", "C1", "O1"], 4, 20).trimEnd(),
    "%FLAG CHARGE",
    "%FORMAT(5E16.8)",
    fixedWidth([0, 1.82223, -1.82223], 16, 5, "float").trimEnd(),
    "%FLAG MASS",
    "%FORMAT(5E16.8)",
    fixedWidth([12.01, 12.01, 16], 16, 5, "float").trimEnd(),
    "%FLAG ATOM_TYPE_INDEX",
    "%FORMAT(10I8)",
    fixedWidth([1, 2, 3], 8, 10, "int").trimEnd(),
    "%FLAG NUMBER_EXCLUDED_ATOMS",
    "%FORMAT(10I8)",
    fixedWidth([0, 0, 0], 8, 10, "int").trimEnd(),
    "%FLAG NONBONDED_PARM_INDEX",
    "%FORMAT(10I8)",
    fixedWidth([1, 1, 1, 1, 1, 1, 1, 1, 1], 8, 10, "int").trimEnd(),
    "%FLAG RESIDUE_LABEL",
    "%FORMAT(20a4)",
    fixedText(["ALA", "LIG"], 4, 20).trimEnd(),
    "%FLAG RESIDUE_POINTER",
    "%FORMAT(10I8)",
    fixedWidth([1, 2], 8, 10, "int").trimEnd(),
    "%FLAG BONDS_INC_HYDROGEN",
    "%FORMAT(10I8)",
    "",
    "%FLAG BONDS_WITHOUT_HYDROGEN",
    "%FORMAT(10I8)",
    fixedWidth([3, 6, 1], 8, 10, "int").trimEnd(),
    "%FLAG AMBER_ATOM_TYPE",
    "%FORMAT(20a4)",
    fixedText(["CT", "c3", "oh"], 4, 20).trimEnd(),
    "%FLAG BOX_DIMENSIONS",
    "%FORMAT(5E16.8)",
    fixedWidth([90, 40, 40, 60], 16, 5, "float").trimEnd(),
    "%FLAG SOLVENT_POINTERS",
    "%FORMAT(3I8)",
    fixedWidth([2, 2, 2], 8, 3, "int").trimEnd(),
    "%FLAG ATOMS_PER_MOLECULE",
    "%FORMAT(10I8)",
    fixedWidth([1, 2], 8, 10, "int").trimEnd(),
    "",
  ].join("\n");
}

function fakeRst7(identity: string, includeVelocities = false): string {
  const coordinates = [0, 0, 0, 1, 0, 0, 2, 0, 0];
  const velocities = includeVelocities ? Array.from({ length: 9 }, () => 0.001) : [];
  const values = [...coordinates, ...velocities, 40, 40, 60, 90, 90, 90];
  const lines: string[] = [];
  for (let index = 0; index < values.length; index += 6) {
    lines.push(
      values
        .slice(index, index + 6)
        .map((value) => value.toFixed(7).padStart(12))
        .join(""),
    );
  }
  return `Fake restart ${identity.slice(0, 12)}\n${String(3).padStart(6)}  0.0000000\n${lines.join("\n")}\n`;
}

function fakeMdout(operation: string): string {
  const step = operation.endsWith("minimization") ? 100 : 500;
  return [
    ` NSTEP = ${step}  TIME(PS) = 1.000  TEMP(K) = 300.00  PRESS = 1.00`,
    " Etot   = -1.2345000E+03  EKtot   = 2.0000000E+02  EPtot = -1.4345000E+03",
    " VOLUME = 9.6000000E+04  Density = 1.0010",
    " 5.  TIMINGS",
    " Total wall time: 0.01 seconds",
    "",
  ].join("\n");
}

function fakeOutput(output: CommandOutput, command: CommandSpec, digest: string): string {
  if (command.executable === "antechamber") {
    return [
      "@<TRIPOS>MOLECULE",
      "LIG",
      "2 1 1 0 0",
      "SMALL",
      "bcc",
      "@<TRIPOS>ATOM",
      "1 C1 0.0000 0.0000 0.0000 c3 1 LIG 0.100000",
      "2 O1 1.0000 0.0000 0.0000 oh 1 LIG -0.100000",
      "@<TRIPOS>BOND",
      "1 1 2 1",
      "",
    ].join("\n");
  }
  if (command.executable === "parmchk2") {
    return [
      "remark generated by deterministic fake parmchk2",
      "MASS",
      "",
      "BOND",
      "",
      "NONBON",
      "",
    ].join("\n");
  }
  if (command.executable === "tleap") {
    if (output.role === "topology.prmtop") return fakePrmtop();
    if (output.role === "coordinates.rst7") return fakeRst7(digest);
    if (output.role === "coordinates.pdb") {
      return [
        "ATOM      1  CA  ALA A   1       0.000   0.000   0.000  1.00  0.00           C",
        "HETATM    2  C1  LIG B   1       1.000   0.000   0.000  1.00  0.00           C",
        "HETATM    3  O1  LIG B   1       2.000   0.000   0.000  1.00  0.00           O",
        "CONECT    2    3",
        "END",
        "",
      ].join("\n");
    }
    return "Welcome to LEaP\nChecking Unit.\nExiting LEaP: Errors = 0; Warnings = 0; Notes = 0.\n";
  }
  if (["sander", "pmemd", "pmemd.cuda"].includes(command.executable)) {
    if (output.role === "stage.mdout") return fakeMdout(command.operation);
    if (output.role === "stage.mdinfo") {
      return "NSTEP = 500 TIME(PS) = 1.000 TEMP(K) = 300.00 PRESS = 1.00\n";
    }
    if (output.role === "stage.restart") {
      return fakeRst7(digest, !command.operation.endsWith("minimization"));
    }
    return `FAKE_NETCDF_V1\nrequest=${digest}\nframes=5\n`;
  }
  if (command.executable === "cpptraj") {
    if (output.role === "cpptraj.log") return "CPPTRAJ fake fixture completed\n";
    return "#Frame Value\n1 0.100000\n2 0.120000\n";
  }
  throw new Error(`Fake engine does not implement ${command.executable}`);
}

/**
 * In-memory contract engine. It executes no binaries and emits only the closed
 * output inventory, making the whole vertical suitable for default CI.
 */
export class FakeAmberEngine {
  readonly #artifacts = new Map<LogicalPath, FakeArtifact>();
  readonly #receipts = new Map<string, FakeExecutionReceipt>();
  readonly #effectCounts = new Map<string, number>();

  seedArtifact(input: {
    logicalPath: LogicalPath;
    mediaType: string;
    content: string;
  }): FakeArtifact {
    const logicalPath = LogicalPathSchema.parse(input.logicalPath);
    const artifact: FakeArtifact = {
      ...input,
      logicalPath,
      sha256: sha256Bytes(input.content),
    };
    const existing = this.#artifacts.get(logicalPath);
    if (existing !== undefined && existing.sha256 !== artifact.sha256) {
      throw new Error(`Refusing to replace immutable fake artifact ${input.logicalPath}`);
    }
    this.#artifacts.set(logicalPath, artifact);
    return { ...artifact };
  }

  getArtifact(path: LogicalPath): FakeArtifact {
    const logicalPath = LogicalPathSchema.parse(path);
    const artifact = this.#artifacts.get(logicalPath);
    if (artifact === undefined) throw new Error(`Fake artifact does not exist: ${path}`);
    return { ...artifact };
  }

  asInput(path: LogicalPath, role: string): CommandInput {
    const artifact = this.getArtifact(path);
    return {
      role,
      logicalPath: artifact.logicalPath,
      mediaType: artifact.mediaType,
      sha256: artifact.sha256,
    };
  }

  execute(value: unknown): FakeExecutionReceipt {
    const command = validateCommandSpec(value);
    const digest = commandRequestDigest(command);
    const previous = this.#receipts.get(digest);
    if (previous !== undefined) {
      for (const expected of previous.artifacts) {
        const actual = this.#artifacts.get(expected.logicalPath);
        if (actual?.sha256 !== expected.sha256) {
          throw new Error(`Cached fake output failed replay verification: ${expected.logicalPath}`);
        }
      }
      return previous;
    }

    for (const expected of command.inputs) {
      const actual = this.#artifacts.get(expected.logicalPath);
      if (actual === undefined) throw new Error(`Missing declared input ${expected.logicalPath}`);
      if (actual.sha256 !== expected.sha256) {
        throw new Error(`Input digest mismatch for ${expected.logicalPath}`);
      }
      if (actual.mediaType !== expected.mediaType) {
        throw new Error(`Input media-type mismatch for ${expected.logicalPath}`);
      }
    }

    const pending = command.outputs.map((output) => {
      const content = fakeOutput(output, command, digest);
      const artifact: FakeArtifact = {
        logicalPath: output.logicalPath,
        mediaType: output.mediaType,
        content,
        sha256: sha256Bytes(content),
      };
      return { output, artifact };
    });
    for (const { artifact } of pending) {
      const existing = this.#artifacts.get(artifact.logicalPath);
      if (existing !== undefined && existing.sha256 !== artifact.sha256) {
        throw new Error(
          `Refusing partial fake execution: output conflict at ${artifact.logicalPath}`,
        );
      }
    }
    for (const { artifact } of pending) this.#artifacts.set(artifact.logicalPath, artifact);
    const artifacts = pending.map(({ output, artifact }) =>
      Object.freeze({ ...output, sha256: artifact.sha256 }),
    );
    const receipt: FakeExecutionReceipt = Object.freeze({
      schemaVersion: "amber-fake-receipt/v1",
      requestDigest: digest,
      status: "completed",
      artifacts: Object.freeze(artifacts) as FakeExecutionReceipt["artifacts"],
    });
    this.#receipts.set(digest, receipt);
    this.#effectCounts.set(digest, 1);
    return receipt;
  }

  effectCount(requestDigest: string): number {
    return this.#effectCounts.get(requestDigest) ?? 0;
  }
}

export interface FakeAmberVerticalResult {
  certificationScope: "contract-choreography-only";
  amberConsumableFixture: false;
  engine: FakeAmberEngine;
  commands: CommandSpec[];
  receipts: FakeExecutionReceipt[];
  topologyValidation: AmberTopologyValidationResult;
  fakeMdParses: FakeMdOutputParseResult[];
}

function stageOutputPaths(name: string) {
  return {
    mdout: `outputs/stages/${name}.mdout` as LogicalPath,
    restart: `outputs/stages/${name}.rst7` as LogicalPath,
    ...(name === "minimization" ? {} : { trajectory: `outputs/stages/${name}.nc` as LogicalPath }),
    mdinfo: `outputs/stages/${name}.mdinfo` as LogicalPath,
  };
}

/** Executes parameterize -> LEaP -> min -> heat -> equil -> prod -> CPPTRAJ in memory. */
export function runFakeAmberVertical(): FakeAmberVerticalResult {
  const engine = new FakeAmberEngine();
  const commands: CommandSpec[] = [];
  const receipts: FakeExecutionReceipt[] = [];
  engine.seedArtifact({
    logicalPath: "inputs/ligand.sdf",
    mediaType: "chemical/x-mdl-sdfile",
    content: "Fake ligand\n  EigenGrid\n\n  0  0  0  0  0  0            999 V3000\nM  END\n$$$$\n",
  });
  engine.seedArtifact({
    logicalPath: "inputs/receptor.pdb",
    mediaType: "chemical/x-pdb",
    content:
      "ATOM      1  CA  ALA A   1       0.000   0.000   0.000  1.00  0.00           C\nEND\n",
  });

  const antechamber = renderAntechamber({
    ligand: engine.asInput("inputs/ligand.sdf", "ligand.sdf"),
    outputMol2: "work/ligand.mol2",
    formalCharge: 0,
    residueName: "LIG",
  });
  commands.push(antechamber);
  receipts.push(engine.execute(antechamber));

  const parmchk2 = renderParmchk2({
    ligandMol2: engine.asInput("work/ligand.mol2", "ligand.mol2"),
    outputFrcmod: "work/ligand.frcmod",
  });
  commands.push(parmchk2);
  receipts.push(engine.execute(parmchk2));

  const leap = renderLeapAssembly({
    forceFields: ["leaprc.protein.ff19SB", "leaprc.gaff2", "leaprc.lipid21", "leaprc.water.opc"],
    frcmods: [engine.asInput("work/ligand.frcmod", "ligand.frcmod")],
    components: [
      {
        variable: "receptor",
        format: "pdb",
        artifact: engine.asInput("inputs/receptor.pdb", "receptor.pdb"),
      },
      {
        variable: "ligand",
        format: "mol2",
        artifact: engine.asInput("work/ligand.mol2", "ligand.mol2"),
      },
    ],
    scriptPath: "work/tleap.in",
    topologyPath: "outputs/system.prmtop",
    coordinatesPath: "outputs/system.rst7",
    snapshotPdbPath: "outputs/system.pdb",
    logPath: "outputs/tleap.log",
  });
  engine.seedArtifact(leap.input);
  commands.push(leap.command);
  receipts.push(engine.execute(leap.command));

  const atomMapEntries: Array<Omit<AmberAtomMapViewEntry, "topologyIndex">> = [
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
  const canonicalAtomMapBase = {
    schemaVersion: "eigengrid.atom-map/v1" as const,
    id: "fake-atom-map",
    revision: 1,
    systemManifestId: "fake-system",
    systemManifestRevision: 1,
    indexBase: 1 as const,
    atomCount: atomMapEntries.length,
    topologyDigest: engine.getArtifact("outputs/system.prmtop").sha256,
    coordinateDigest: engine.getArtifact("outputs/system.rst7").sha256,
    entries: atomMapEntries,
  };
  const canonicalAtomMap = {
    ...canonicalAtomMapBase,
    mapDigest: computeCanonicalAtomMapDigest(canonicalAtomMapBase),
  };
  const atomMapView = deriveAmberAtomMapView(canonicalAtomMap, canonicalAtomMap.mapDigest);
  const topologyValidation = validateAmberTopology({
    prmtop: engine.getArtifact("outputs/system.prmtop").content,
    rst7: engine.getArtifact("outputs/system.rst7").content,
    atomMapView,
    expectedCanonicalAtomMapDigest: canonicalAtomMap.mapDigest,
    expectedAtomCount: 3,
    expectedTotalCharge: 0,
    requirePeriodicBox: true,
  });
  if (!topologyValidation.valid) throw new Error("The built-in fake topology failed validation");

  const stages: MdStageSpec[] = [
    {
      kind: "minimization",
      title: "Fixture restrained minimization",
      maxCycles: 200,
      steepestDescentCycles: 100,
      rmsGradientToleranceKcalMolAngstrom: 0.0001,
      initialStepAngstrom: 0.01,
      cutoffAngstrom: 10,
      restartFormat: "formatted",
      output: { energiesEvery: 20, trajectoryEvery: 0, restartEvery: 200 },
      restraints: { weightKcalMolA2: 10, mask: ":1-2" },
    },
    {
      kind: "heating",
      title: "Fixture heating",
      steps: 500,
      timestepPs: 0.002,
      initialTemperatureK: 0,
      targetTemperatureK: 300,
      thermostatCollisionPs: 1,
      randomSeed: 101,
      cutoffAngstrom: 10,
      restartFormat: "formatted",
      output: { energiesEvery: 50, trajectoryEvery: 100, restartEvery: 500 },
      restraints: { weightKcalMolA2: 5, mask: ":1-2" },
    },
    {
      kind: "equilibration",
      title: "Fixture membrane equilibration",
      ensemble: "npt",
      systemKind: "membrane",
      steps: 500,
      timestepPs: 0.002,
      temperatureK: 300,
      thermostatCollisionPs: 1,
      randomSeed: 102,
      cutoffAngstrom: 10,
      restartFormat: "formatted",
      output: { energiesEvery: 50, trajectoryEvery: 100, restartEvery: 500 },
      pressureBar: 1,
      pressureRelaxationPs: 1,
      pressureCoupling: "semiisotropic",
      barostatAlgorithm: "berendsen",
      surfaceOrientation: "xy",
      membranePressurePolicyReviewed: true,
      surfaceTensionDynCm: 0,
      interfaces: 2,
      restraints: { weightKcalMolA2: 1, mask: ":1-2" },
    },
    {
      kind: "production",
      title: "Fixture production",
      ensemble: "npt",
      systemKind: "membrane",
      steps: 500,
      timestepPs: 0.002,
      temperatureK: 300,
      thermostatCollisionPs: 1,
      randomSeed: 103,
      cutoffAngstrom: 10,
      restartFormat: "formatted",
      output: { energiesEvery: 50, trajectoryEvery: 100, restartEvery: 500 },
      pressureBar: 1,
      pressureRelaxationPs: 1,
      pressureCoupling: "semiisotropic",
      barostatAlgorithm: "berendsen",
      surfaceOrientation: "xy",
      membranePressurePolicyReviewed: true,
      surfaceTensionDynCm: 0,
      interfaces: 2,
    },
  ];
  let coordinatePath: LogicalPath = "outputs/system.rst7";
  const fakeMdParses: FakeMdOutputParseResult[] = [];
  for (const stage of stages) {
    const name = stage.kind;
    const mdin = renderMdin(stage, `work/stages/${name}.mdin`);
    engine.seedArtifact(mdin);
    const stageCommand = renderMdStageCommand({
      kind: stage.kind,
      engine: "sander",
      topology: engine.asInput("outputs/system.prmtop", "topology.prmtop"),
      coordinates: engine.asInput(coordinatePath, "coordinates.input"),
      mdin,
      ...(mdin.requiresReferenceCoordinates
        ? { referenceCoordinates: engine.asInput(coordinatePath, "coordinates.reference") }
        : {}),
      outputs: stageOutputPaths(name),
    });
    commands.push(stageCommand);
    receipts.push(engine.execute(stageCommand));
    coordinatePath = stageOutputPaths(name).restart;
    fakeMdParses.push(parseFakeMdout(engine.getArtifact(stageOutputPaths(name).mdout).content, 0));
  }

  const cpptraj = renderCpptrajPlan({
    topology: engine.asInput("outputs/system.prmtop", "topology.prmtop"),
    trajectories: [engine.asInput("outputs/stages/production.nc", "trajectory.production")],
    analyses: [
      {
        kind: "rmsd",
        name: "protein_rmsd",
        mask: ":1@CA",
        reference: "first",
        outputPath: "outputs/analysis/protein-rmsd.dat",
      },
    ],
    autoimage: true,
    scriptPath: "work/cpptraj.in",
    logPath: "outputs/analysis/cpptraj.log",
  });
  engine.seedArtifact(cpptraj.input);
  commands.push(cpptraj.command);
  receipts.push(engine.execute(cpptraj.command));

  const leapParse = parseLeapOutput(engine.getArtifact("outputs/tleap.log").content, 0);
  if (!leapParse.completed || fakeMdParses.some((parsed) => !parsed.completed)) {
    throw new Error("The built-in fake vertical emitted an invalid completion marker");
  }
  return {
    certificationScope: "contract-choreography-only",
    amberConsumableFixture: false,
    engine,
    commands,
    receipts,
    topologyValidation,
    fakeMdParses,
  };
}
