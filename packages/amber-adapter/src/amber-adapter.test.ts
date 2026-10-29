import { describe, expect, test } from "bun:test";
import {
  commandRequestDigest,
  createCommandSpec,
  validateCommandSpec,
  type CommandInput,
} from "./contracts";
import { renderCpptrajPlan } from "./cpptraj";
import {
  assertAmberEnvironmentManifest,
  discoverAmberEnvironment,
  selectAmberMdEngine,
  type CommandProbe,
} from "./environment";
import {
  AMBER_HOST_EXECUTION_SUPPORT,
  FailClosedAmberHostExecutionGateway,
  createAmberHostExecutionRequest,
} from "./execution";
import { renderLeapAssembly, type LeapAssemblyPlan } from "./leap";
import { renderMdin } from "./mdin";
import { renderAntechamber, renderParmchk2 } from "./parameterization";
import { parseLeapOutput } from "./leap-diagnostics";
import { parseFakeCpptrajTable, parseFakeMdinfo, parseFakeMdout } from "./parsers";
import {
  segmentRequestDigest,
  validateSegmentAgainstRequest,
  validateSegmentContinuity,
  type SegmentRequest,
  type TrajectorySegment,
} from "./segments";
import { renderMdStageCommand } from "./stage";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);

function artifact(
  role: string,
  logicalPath: string,
  mediaType = "application/octet-stream",
  sha256 = digestA,
): CommandInput {
  return { role, logicalPath, mediaType, sha256 };
}

describe("safe command contracts", () => {
  test("antechamber rendering is deterministic, inventoried, and permanently shell-free", () => {
    const request = {
      ligand: artifact("source", "inputs/ligand.sdf", "chemical/x-mdl-sdfile"),
      outputMol2: "work/ligand.mol2",
      formalCharge: 1,
      residueName: "LIG",
    } as const;
    const first = renderAntechamber(request);
    const second = renderAntechamber(request);

    expect(first).toEqual(second);
    expect(first.shell).toBe(false);
    expect(first.executable).toBe("antechamber");
    expect(first.argv).toEqual([
      "-i",
      "inputs/ligand.sdf",
      "-fi",
      "sdf",
      "-o",
      "work/ligand.mol2",
      "-fo",
      "mol2",
      "-at",
      "gaff2",
      "-c",
      "bcc",
      "-nc",
      "1",
      "-rn",
      "LIG",
      "-pf",
      "y",
    ]);
    expect(first.inputs.map((item) => item.logicalPath)).toEqual(["inputs/ligand.sdf"]);
    expect(first.outputs.map((item) => item.logicalPath)).toEqual(["work/ligand.mol2"]);
    expect(commandRequestDigest(first)).toBe(commandRequestDigest(second));
    expect(commandRequestDigest(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(first).toLowerCase()).not.toContain("prepi");
  });

  test("rejects raw commands, unknown executables/options, redirection, and host paths", () => {
    const safe = renderAntechamber({
      ligand: artifact("source", "inputs/ligand.sdf", "chemical/x-mdl-sdfile"),
      outputMol2: "work/ligand.mol2",
      formalCharge: 0,
      residueName: "LIG",
    });
    expect(() => validateCommandSpec({ ...safe, shell: true })).toThrow();
    expect(() => validateCommandSpec({ ...safe, command: "antechamber -i x" })).toThrow();
    expect(() => validateCommandSpec({ ...safe, operation: "amber.stage.production" })).toThrow(
      /does not match/,
    );
    expect(() => validateCommandSpec({ ...safe, executable: "/bin/sh" })).toThrow();
    expect(() => validateCommandSpec({ ...safe, argv: [...safe.argv, ">", "work/log"] })).toThrow();
    expect(() => validateCommandSpec({ ...safe, argv: [...safe.argv, "--raw"] })).toThrow();
    expect(() =>
      renderAntechamber({
        ligand: artifact("source", "/etc/passwd", "chemical/x-mdl-sdfile"),
        outputMol2: "work/ligand.mol2",
        formalCharge: 0,
        residueName: "LIG",
      }),
    ).toThrow();
    expect(() =>
      renderAntechamber({
        ligand: artifact("source", "inputs/../secret.sdf", "chemical/x-mdl-sdfile"),
        outputMol2: "work/ligand.mol2",
        formalCharge: 0,
        residueName: "LIG",
      }),
    ).toThrow();
  });

  test("requires every path argument to occur in the closed inventory", () => {
    expect(() =>
      createCommandSpec({
        operation: "amber.tleap.assemble",
        executable: "tleap",
        argv: ["-f", "work/untracked.in"],
        cwd: "work",
        inputs: [artifact("leap.input", "work/declared.in", "text/plain")],
        outputs: [
          {
            role: "leap.log",
            logicalPath: "outputs/tleap.log",
            mediaType: "text/plain",
            producedBy: "captured_combined",
          },
        ],
      }),
    ).toThrow(/inventory/);
  });

  test("parmchk2 accepts only a materialized MOL2 digest and emits frcmod", () => {
    const command = renderParmchk2({
      ligandMol2: artifact("mol2", "work/ligand.mol2", "chemical/x-mol2", digestB),
      outputFrcmod: "outputs/ligand.frcmod",
    });
    expect(command.inputs[0]?.sha256).toBe(digestB);
    expect(command.outputs).toEqual([
      {
        role: "ligand.frcmod",
        logicalPath: "outputs/ligand.frcmod",
        mediaType: "application/vnd.amber.frcmod",
        producedBy: "executable",
      },
    ]);
    expect(JSON.stringify(command).toLowerCase()).not.toContain("prepi");
  });
});

describe("explicit environment discovery", () => {
  test("uses only the injected probe and derives exact capabilities", async () => {
    const observed: string[] = [];
    const probe: CommandProbe = {
      async probe(executable) {
        observed.push(executable);
        return {
          executable,
          available: executable !== "pmemd.cuda",
          ...(executable === "pmemd.cuda"
            ? { diagnostic: "not installed" }
            : { version: "24.0", binarySha256: digestA }),
        };
      },
    };
    const manifest = await discoverAmberEnvironment(probe);
    expect(observed).toEqual([
      "antechamber",
      "parmchk2",
      "tleap",
      "sander",
      "pmemd",
      "pmemd.cuda",
      "cpptraj",
    ]);
    expect(manifest.capabilities).toEqual({
      amberToolsPreparation: true,
      referenceMd: true,
      optimizedCpuMd: true,
      gpuMd: false,
      trajectoryAnalysis: true,
    });
    expect(selectAmberMdEngine(manifest, "best-available")).toBe("pmemd");
    expect(manifest.environmentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(() => selectAmberMdEngine(manifest, "gpu")).toThrow(/not observed/);
    expect(() =>
      selectAmberMdEngine(
        { ...manifest, capabilities: { ...manifest.capabilities, gpuMd: true } },
        "best-available",
      ),
    ).toThrow(/capability is inconsistent/);
    expect(() =>
      assertAmberEnvironmentManifest({
        ...manifest,
        observations: [...manifest.observations].reverse(),
      }),
    ).toThrow(/canonical closed executable order/);
  });

  test("fails when a probe returns an observation for another executable", async () => {
    const probe: CommandProbe = {
      async probe() {
        return { executable: "sander", available: true, version: "24", binarySha256: digestA };
      },
    };
    await expect(discoverAmberEnvironment(probe)).rejects.toThrow(/identity mismatch/);
  });

  test("does not advertise CUDA when the binary exists but the GPU probe is unusable", async () => {
    const probe: CommandProbe = {
      async probe(executable) {
        return {
          executable,
          available: true,
          version: "24.0",
          binarySha256: digestA,
          ...(executable === "pmemd.cuda" ? { gpu: false } : {}),
        };
      },
    };
    const manifest = await discoverAmberEnvironment(probe);
    expect(manifest.capabilities.gpuMd).toBe(false);
    expect(selectAmberMdEngine(manifest, "best-available")).toBe("pmemd");
  });
});

describe("deterministic typed renderers", () => {
  const leapPlan: LeapAssemblyPlan = {
    forceFields: ["leaprc.protein.ff19SB", "leaprc.gaff2", "leaprc.lipid21"],
    frcmods: [artifact("frcmod", "inputs/ligand.frcmod", "application/vnd.amber.frcmod")],
    components: [
      {
        variable: "receptor",
        format: "pdb" as const,
        artifact: artifact("receptor", "inputs/receptor.pdb", "chemical/x-pdb"),
      },
      {
        variable: "ligand",
        format: "mol2" as const,
        artifact: artifact("ligand", "inputs/ligand.mol2", "chemical/x-mol2", digestB),
      },
    ],
    scriptPath: "work/tleap.in",
    topologyPath: "outputs/system.prmtop",
    coordinatesPath: "outputs/system.rst7",
    snapshotPdbPath: "outputs/system.pdb",
    logPath: "outputs/tleap.log",
  };

  test("LEaP uses the proper typed loaders and declares every input/output", () => {
    const first = renderLeapAssembly(leapPlan);
    const second = renderLeapAssembly(leapPlan);
    expect(first).toEqual(second);
    expect(first.input.content).toContain("loadamberparams inputs/ligand.frcmod");
    expect(first.input.content).toContain("ligand = loadmol2 inputs/ligand.mol2");
    expect(first.input.content).not.toContain("prepi");
    expect(first.command.inputs.map((item) => item.logicalPath)).toEqual([
      "work/tleap.in",
      "inputs/ligand.frcmod",
      "inputs/receptor.pdb",
      "inputs/ligand.mol2",
    ]);
    expect(first.command.outputs.map((item) => item.role)).toEqual([
      "topology.prmtop",
      "coordinates.rst7",
      "coordinates.pdb",
      "leap.log",
    ]);
    expect(first.command.outputs.at(-1)?.producedBy).toBe("captured_combined");
    expect(first.command.argv).not.toContain(">");
  });

  test("adds membrane salt from the exact prepacked-water count after separate neutralization", () => {
    const plan: LeapAssemblyPlan = {
      forceFields: ["leaprc.protein.ff14SB", "leaprc.lipid21", "leaprc.water.tip3p"],
      frcmods: [],
      components: [
        { variable: "receptor", format: "pdb", artifact: artifact("r", "in/receptor.pdb") },
        { variable: "ligand", format: "mol2", artifact: artifact("l", "in/ligand.mol2") },
        { variable: "bilayer", format: "pdb", artifact: artifact("m", "in/membrane.pdb") },
        { variable: "waters", format: "pdb", artifact: artifact("w", "in/waters.pdb") },
      ],
      existingSolvent: {
        waterModel: "TIP3P",
        componentVariable: "waters",
        waterMoleculeCount: 370,
      },
      ions: { kind: "neutralize", soluteNetCharge: 1, counterIon: "Cl-" },
      saltPairs: {
        schemaVersion: "eigengrid.leap-salt-pair-policy/v1",
        cation: "Na+",
        anion: "Cl-",
        targetIonicStrengthMolar: 0.15,
        waterMoleculeCount: 370,
        numberOfPairs: 1,
        waterReferenceMolarity: 55.5,
        derivation: "round(Nwater * targetIonicStrengthMolar / 55.5)",
        neutralizationOrder: "separate-before-salt-pairs",
      },
      scriptPath: "work/tleap.in",
      topologyPath: "out/system.prmtop",
      coordinatesPath: "out/system.rst7",
      snapshotPdbPath: "out/system.pdb",
      logPath: "out/tleap.log",
    };
    const script = renderLeapAssembly(plan).input.content;
    expect(script).toContain("system = combine { receptor ligand bilayer waters }");
    expect(script).not.toContain("solvateBox");
    expect(script).not.toContain("solvateOct");
    expect(script.indexOf("addIons system Cl- 1")).toBeGreaterThan(
      script.indexOf("system = combine"),
    );
    expect(script.indexOf("addIonsRand system Na+ 1 Cl- 1")).toBeGreaterThan(
      script.indexOf("addIons system Cl- 1"),
    );
    expect(() =>
      renderLeapAssembly({ ...plan, saltPairs: { ...plan.saltPairs!, numberOfPairs: 2 } }),
    ).toThrow(/must equal/u);
  });

  test("renders all four mdin stages and fails closed for an unreviewed membrane policy", () => {
    const minimization = renderMdin(
      {
        kind: "minimization",
        title: "Minimize fixture",
        maxCycles: 100,
        steepestDescentCycles: 50,
        rmsGradientToleranceKcalMolAngstrom: 0.0001,
        initialStepAngstrom: 0.01,
        cutoffAngstrom: 10,
        restartFormat: "formatted",
        output: { energiesEvery: 10, trajectoryEvery: 0, restartEvery: 100 },
      },
      "work/min.mdin",
    );
    const heatingSpec = {
      kind: "heating",
      title: "Heat fixture",
      steps: 100,
      timestepPs: 0.002,
      initialTemperatureK: 0,
      targetTemperatureK: 300,
      thermostatCollisionPs: 1,
      randomSeed: 42,
      cutoffAngstrom: 10,
      restartFormat: "formatted",
      output: { energiesEvery: 10, trajectoryEvery: 10, restartEvery: 100 },
    } as const;
    const heating = renderMdin(heatingSpec, "work/heat.mdin");
    const maskPrefix = Array.from({ length: 50 }, (_, i) => 1000 + 2 * i).join(",");
    const acceptedMask = `@${maskPrefix},10000`;
    expect(acceptedMask.length).toBe(256);
    expect(
      renderMdin(
        { ...heatingSpec, restraints: { weightKcalMolA2: 10, mask: acceptedMask } },
        "work/mask-boundary.mdin",
      ).content,
    ).toContain(`restraintmask='${acceptedMask}',`);
    expect(() =>
      renderMdin(
        { ...heatingSpec, restraints: { weightKcalMolA2: 10, mask: acceptedMask + "0" } },
        "work/oversized-mask.mdin",
      ),
    ).toThrow();
    const netcdfRestart = renderMdin(
      { ...heatingSpec, restartFormat: "netcdf" },
      "work/heat-netcdf.mdin",
    );
    const membraneBase = {
      title: "Membrane stage",
      ensemble: "npt",
      systemKind: "membrane",
      steps: 100,
      timestepPs: 0.002,
      temperatureK: 300,
      thermostatCollisionPs: 1,
      randomSeed: 43,
      cutoffAngstrom: 10,
      restartFormat: "formatted",
      output: { energiesEvery: 10, trajectoryEvery: 10, restartEvery: 100 },
      pressureBar: 1,
      pressureRelaxationPs: 1,
      pressureCoupling: "semiisotropic",
      barostatAlgorithm: "berendsen",
      surfaceOrientation: "xy",
      membranePressurePolicyReviewed: true,
      surfaceTensionDynCm: 0,
      interfaces: 2,
    } as const;
    const equilibration = renderMdin({ kind: "equilibration", ...membraneBase }, "work/equil.mdin");
    const production = renderMdin(
      { kind: "production", ...membraneBase, randomSeed: 44 },
      "work/prod.mdin",
    );

    expect(minimization.content).toContain("imin=1");
    expect(minimization.content).toContain("ntwx=0");
    expect(minimization.content).toContain("ntmin=1");
    expect(minimization.content).toContain("drms=0.0001");
    expect(minimization.content).toContain("dx0=0.01");
    expect(minimization.content).toContain("ntxo=1");
    expect(heating).toEqual(renderMdin(heatingSpec, "work/heat.mdin"));
    expect(heating.content).toContain("TYPE='TEMP0'");
    expect(netcdfRestart.content).toContain("ntxo=2");
    expect(equilibration.content).toContain("ntp=3");
    expect(equilibration.content).toContain("barostat=1");
    expect(equilibration.content).toContain("csurften=3");
    expect(equilibration.content).toContain("taup=1");
    expect(equilibration.content).toContain("ninterface=2");
    expect(production.content).toContain("irest=1");
    expect(() =>
      renderMdin(
        {
          kind: "equilibration",
          ...membraneBase,
          pressureCoupling: "isotropic",
          membranePressurePolicyReviewed: undefined,
        },
        "work/unsafe.mdin",
      ),
    ).toThrow();
    expect(() =>
      renderMdin({ ...heatingSpec, rawLines: ["DISANG=/tmp/x"] }, "work/raw.mdin"),
    ).toThrow();
    expect(() =>
      renderMdin(
        {
          ...heatingSpec,
          output: { ...heatingSpec.output, trajectoryEvery: heatingSpec.steps + 1 },
        },
        "work/bad-cadence.mdin",
      ),
    ).toThrow(/stage length/);
  });

  test("renders closed sander/pmemd/pmemd.cuda argv and a typed CPPTRAJ plan", () => {
    const mdin = renderMdin(
      {
        kind: "minimization",
        title: "Minimize fixture",
        maxCycles: 100,
        steepestDescentCycles: 50,
        rmsGradientToleranceKcalMolAngstrom: 0.0001,
        initialStepAngstrom: 0.01,
        cutoffAngstrom: 10,
        restartFormat: "formatted",
        output: { energiesEvery: 10, trajectoryEvery: 0, restartEvery: 100 },
      },
      "work/min.mdin",
    );
    for (const engine of ["sander", "pmemd", "pmemd.cuda"] as const) {
      const command = renderMdStageCommand({
        kind: "minimization",
        engine,
        topology: artifact("topology", "inputs/system.prmtop", "application/vnd.amber.prmtop"),
        coordinates: artifact("coordinates", "inputs/system.rst7", "application/vnd.amber.rst7"),
        mdin,
        outputs: {
          mdout: `outputs/${engine}.mdout`,
          restart: `outputs/${engine}.rst7`,
          mdinfo: `outputs/${engine}.mdinfo`,
        },
      });
      expect(command.executable).toBe(engine);
      expect(command.outputs).toHaveLength(3);
      expect(command.argv).not.toContain("-x");
      expect(command.argv).not.toContain("|");
    }

    expect(() =>
      renderMdStageCommand({
        kind: "production",
        engine: "sander",
        topology: artifact("topology", "inputs/system.prmtop", "application/vnd.amber.prmtop"),
        coordinates: artifact("coordinates", "inputs/system.rst7", "application/vnd.amber.rst7"),
        mdin,
        outputs: {
          mdout: "outputs/mismatch.mdout",
          restart: "outputs/mismatch.rst7",
          trajectory: "outputs/mismatch.nc",
          mdinfo: "outputs/mismatch.mdinfo",
        },
      }),
    ).toThrow(/does not match/);

    const restrained = renderMdin(
      {
        kind: "minimization",
        title: "Restrained fixture",
        maxCycles: 100,
        steepestDescentCycles: 50,
        rmsGradientToleranceKcalMolAngstrom: 0.0001,
        initialStepAngstrom: 0.01,
        cutoffAngstrom: 10,
        restartFormat: "formatted",
        output: { energiesEvery: 10, trajectoryEvery: 0, restartEvery: 100 },
        restraints: { weightKcalMolA2: 10, mask: ":1" },
      },
      "work/restrained.mdin",
    );
    const restrainedRequest = {
      kind: "minimization" as const,
      engine: "sander" as const,
      topology: artifact("topology", "inputs/system.prmtop", "application/vnd.amber.prmtop"),
      coordinates: artifact("coordinates", "inputs/system.rst7", "application/vnd.amber.rst7"),
      mdin: restrained,
      outputs: {
        mdout: "outputs/restrained.mdout",
        restart: "outputs/restrained.rst7",
        mdinfo: "outputs/restrained.mdinfo",
      },
    };
    expect(() => renderMdStageCommand(restrainedRequest)).toThrow(/requires explicit/);
    const withReference = renderMdStageCommand({
      ...restrainedRequest,
      referenceCoordinates: restrainedRequest.coordinates,
    });
    expect(withReference.argv.slice(-2)).toEqual(["-ref", "inputs/system.rst7"]);
    expect(() =>
      renderMdStageCommand({
        ...restrainedRequest,
        mdin,
        outputs: { ...restrainedRequest.outputs, restart: "outputs/restrained.ncrst" },
      }),
    ).toThrow(/formatted restart/);

    const cpptraj = renderCpptrajPlan({
      topology: artifact("topology", "inputs/system.prmtop", "application/vnd.amber.prmtop"),
      trajectories: [artifact("trajectory", "inputs/prod.nc", "application/x-netcdf", digestC)],
      analyses: [
        {
          kind: "distance",
          name: "salt_bridge",
          mask1: ":1@NZ",
          mask2: ":2@OD1",
          outputPath: "outputs/salt-bridge.dat",
        },
      ],
      autoimage: true,
      scriptPath: "work/cpptraj.in",
      logPath: "outputs/cpptraj.log",
    });
    expect(cpptraj.input.content).toContain(
      "distance salt_bridge :1@NZ :2@OD1 out outputs/salt-bridge.dat",
    );
    expect(cpptraj.command.outputs.map((item) => item.logicalPath)).toEqual([
      "outputs/salt-bridge.dat",
      "outputs/cpptraj.log",
    ]);
    expect(cpptraj.command.argv).toEqual(["-i", "work/cpptraj.in", "-o", "outputs/cpptraj.log"]);
    expect(() =>
      renderCpptrajPlan({
        topology: artifact("topology", "inputs/system.prmtop", "application/vnd.amber.prmtop"),
        trajectories: [artifact("trajectory", "inputs/prod.nc", "application/x-netcdf")],
        analyses: [
          {
            kind: "rmsd",
            name: "bad",
            mask: ":1\nrun",
            reference: "first",
            outputPath: "outputs/bad.dat",
          },
        ],
        autoimage: true,
        scriptPath: "work/cpptraj.in",
        logPath: "outputs/cpptraj.log",
      }),
    ).toThrow();
  });
});

describe("LEaP diagnostics and fake-engine-only text parsers", () => {
  test("LEaP distinguishes completion, partial output, warnings, and fatal parameters", () => {
    const completed = parseLeapOutput(
      "WARNING: There is a close contact\nExiting LEaP: Errors = 0; Warnings = 1; Notes = 0.\n",
      0,
    );
    expect(completed.terminalReason).toBe("completed");
    expect(completed.warnings[0]?.code).toBe("geometry_warning");
    expect(parseLeapOutput("Welcome to LEaP\n").terminalReason).toBe("partial_output");

    const fatal = parseLeapOutput(
      "Could not find bond parameter for atom types ca - xx\nExiting LEaP: Errors = 1\n",
      0,
    );
    expect(fatal.terminalReason).toBe("fatal");
    expect(fatal.errors.map((item) => item.code)).toContain("missing_parameter");
    expect(parseLeapOutput("", 2).terminalReason).toBe("nonzero_exit");
  });

  test("mdout normalizes telemetry while mdinfo remains partial without a terminal marker", () => {
    const text = [
      "NSTEP = 100 TIME(PS) = 0.200 TEMP(K) = 3.001D+02 PRESS = 1.10",
      "Etot = -1.0D+03 EKtot = 2.0D+02 EPtot = -1.2D+03",
      "VOLUME = 9.5D+04 Density = 1.001",
      "5.  TIMINGS",
    ].join("\n");
    const parsed = parseFakeMdout(text, 0);
    expect(parsed.terminalReason).toBe("completed");
    expect(parsed.samples).toEqual([
      {
        step: 100,
        timePs: 0.2,
        temperatureK: 300.1,
        pressureBar: 1.1,
        totalEnergyKcalMol: -1000,
        kineticEnergyKcalMol: 200,
        potentialEnergyKcalMol: -1200,
        volumeA3: 95000,
        densityGmL: 1.001,
      },
    ]);
    expect(parseFakeMdinfo(text.replace("5.  TIMINGS", "")).terminalReason).toBe("partial_output");
  });

  test("SHAKE, overflow, and nonzero exits cannot be reported as success", () => {
    const shake = parseFakeMdout(
      "NSTEP = 5 TEMP(K) = 999.0\nSHAKE cannot be accomplished\n5.  TIMINGS\n",
      0,
    );
    expect(shake.terminalReason).toBe("engine_fatal");
    expect(shake.errors[0]?.code).toBe("shake_failure");
    expect(parseFakeMdout("NSTEP = 5 Etot = ********", 0).terminalReason).toBe("engine_fatal");
    expect(parseFakeMdout("NSTEP = 5", 9).terminalReason).toBe("nonzero_exit");
  });

  test("parses CPPTRAJ native tables and rejects malformed rows", () => {
    expect(parseFakeCpptrajTable("#Frame RMSD\n1 0.10\n2 0.12\n")).toEqual({
      columns: ["Frame", "RMSD"],
      rows: [
        [1, 0.1],
        [2, 0.12],
      ],
      completed: true,
      errors: [],
    });
    const malformed = parseFakeCpptrajTable("#Frame RMSD\n1 nope\n");
    expect(malformed.completed).toBe(false);
    expect(malformed.errors[0]?.code).toBe("invalid_cpptraj_number");
  });
});

describe("segment continuity and idempotency identities", () => {
  const request: SegmentRequest = {
    schemaVersion: "amber-segment-request/v1",
    replicaId: "replica-1",
    segmentIndex: 0,
    parentRestartDigest: digestA,
    topologyDigest: digestB,
    systemManifestDigest: digestC,
    startStep: 0,
    startTimePs: 0,
    steps: 5000,
    timestepPs: 0.002,
    trajectoryEvery: 50,
    includeStartFrame: false,
    randomSeed: 101,
  };

  test("canonical segment request digests are stable and material changes are distinct", () => {
    expect(segmentRequestDigest(request)).toBe(segmentRequestDigest({ ...request }));
    expect(segmentRequestDigest({ ...request, randomSeed: 102 })).not.toBe(
      segmentRequestDigest(request),
    );
    expect(() => segmentRequestDigest({ ...request, trajectoryEvery: 51 })).toThrow(/divide/);
  });

  test("verifies parent restart, step/time, topology, system, replica, and index", () => {
    const previous: TrajectorySegment = {
      schemaVersion: "amber-trajectory-segment/v1",
      requestDigest: segmentRequestDigest(request),
      replicaId: "replica-1",
      segmentIndex: 0,
      parentRestartDigest: digestA,
      restartDigest: "d".repeat(64),
      topologyDigest: digestB,
      systemManifestDigest: digestC,
      trajectoryDigest: "e".repeat(64),
      startStep: 0,
      endStep: 5000,
      startTimePs: 0,
      endTimePs: 10,
      frameCount: 100,
    };
    expect(validateSegmentAgainstRequest(request, previous)).toEqual({
      continuous: true,
      issues: [],
    });
    const requestMismatch = validateSegmentAgainstRequest(request, {
      ...previous,
      requestDigest: "9".repeat(64),
      endStep: 5001,
      endTimePs: 11,
      frameCount: 99,
    });
    expect(requestMismatch.issues.map((issue) => issue.code)).toEqual([
      "request_digest_mismatch",
      "end_step_mismatch",
      "end_time_mismatch",
      "frame_count_mismatch",
    ]);
    const next: TrajectorySegment = {
      ...previous,
      requestDigest: "f".repeat(64),
      segmentIndex: 1,
      parentRestartDigest: previous.restartDigest,
      restartDigest: "1".repeat(64),
      trajectoryDigest: "2".repeat(64),
      startStep: 5000,
      endStep: 10000,
      startTimePs: 10,
      endTimePs: 20,
    };
    expect(validateSegmentContinuity(previous, next)).toEqual({ continuous: true, issues: [] });
    const broken = validateSegmentContinuity(previous, {
      ...next,
      parentRestartDigest: "3".repeat(64),
      startStep: 5001,
      startTimePs: 10.5,
    });
    expect(broken.continuous).toBe(false);
    expect(broken.issues.map((issue) => issue.code)).toEqual([
      "restart_parent_mismatch",
      "step_discontinuity",
      "time_discontinuity",
    ]);
  });
});

describe("fail-closed host execution boundary", () => {
  test("binds exact binary/environment identity but does not claim E4.7/E4.11", async () => {
    const command = renderAntechamber({
      ligand: artifact("source", "inputs/ligand.sdf", "chemical/x-mdl-sdfile"),
      outputMol2: "work/ligand.mol2",
      formalCharge: 0,
      residueName: "LIG",
    });
    const environment = await discoverAmberEnvironment({
      async probe(executable) {
        return {
          executable,
          available: true,
          version: "24.0",
          binarySha256: digestA,
          ...(executable === "pmemd.cuda" ? { gpu: true } : {}),
        };
      },
    });
    const request = createAmberHostExecutionRequest(command, environment);
    expect(request.binding).toMatchObject({
      executable: "antechamber",
      binarySha256: digestA,
      environmentDigest: environment.environmentDigest,
    });
    expect(AMBER_HOST_EXECUTION_SUPPORT).toMatchObject({
      supported: false,
      e4_7_runner: "pending",
      e4_11_operationLedger: "pending",
    });
    await expect(new FailClosedAmberHostExecutionGateway().execute(request)).rejects.toThrow(
      /process supervisor/,
    );
    expect(() =>
      createAmberHostExecutionRequest(command, {
        ...environment,
        environmentDigest: digestB,
      }),
    ).toThrow(/digest does not match/);
  });
});
