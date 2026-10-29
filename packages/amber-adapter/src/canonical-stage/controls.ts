import {
  type MdExecutionBindingParameters,
  type MdStageSpec as CanonicalMdStageSpec,
} from "@eigengrid/scientific-schema";
import {
  AMBER_ENVIRONMENT_BINDING_VERSION,
  assertAmberEnvironmentBinding,
} from "../environment-binding";
import type { MdStageSpec as AdapterMdStageSpec } from "../mdin";
import { PMEMD26_CUDA_PROFILE, SANDER26_CPU_PROFILE } from "../sander26-profile";
import { AMBER_CANONICAL_STAGE_MAPPING_VERSION, type AmberCanonicalStageMapping } from "./schemas";
import { canonicalState } from "./inputs";
import { mappingDecisionIdentity } from "./decisions";
import type { AmberAtomMapViewEntry } from "../atom-map";
import { deriveAmberAtomMask } from "./restraint-mask";

function assertEngineResourceCompatibility(
  stage: CanonicalMdStageSpec,
  mapping: AmberCanonicalStageMapping,
): void {
  const gpuEngine = mapping.engineSelection.engine === "pmemd.cuda";
  if (gpuEngine !== stage.resourceProfile.gpuCount > 0) {
    throw new Error("AMBER engine selection does not match the canonical GPU resource request");
  }
  const derivedEngine = stage.resourceProfile.gpuCount > 0 ? "pmemd.cuda" : "sander";
  if (mapping.engineSelection.engine !== derivedEngine) {
    throw new Error(
      `AMBER engine selection is not derivable from the stage resource contract; expected ${derivedEngine}`,
    );
  }
  const environment = assertAmberEnvironmentBinding(mapping.environment);
  if (environment.executable !== mapping.engineSelection.engine) {
    throw new Error("AMBER environment binding does not match the selected MD engine");
  }
  if (
    environment.canonicalSnapshot.engine.compatibilityVersion !==
      AMBER_CANONICAL_STAGE_MAPPING_VERSION ||
    environment.bindingVersion !== AMBER_ENVIRONMENT_BINDING_VERSION
  ) {
    throw new Error("AMBER environment compatibility version does not match the stage mapper");
  }
}

function assertNoUnboundMaterialMappings(stage: CanonicalMdStageSpec): void {
  if (stage.kind === "minimization" && stage.minimization === undefined) {
    throw new Error(
      "AMBER minimization rendering is unavailable until the exact cycle split is part of the canonical approved stage",
    );
  }
  if (
    stage.restraints.some((restraint) =>
      restraint.selections.some((selection) => selection.atomIndices === undefined),
    )
  ) {
    throw new Error(
      "AMBER restraint rendering is unavailable until the canonical approved payload binds exact atom indices",
    );
  }
}

function assertSupportedCoreControls(
  stage: CanonicalMdStageSpec,
  mapping: AmberCanonicalStageMapping,
): void {
  const constraints = mapping.constraints;
  if (
    (stage.constraints.bondsToHydrogen &&
      (constraints.algorithm !== "shake" ||
        constraints.bondsToHydrogen !== true ||
        constraints.tolerance !== stage.constraints.tolerance ||
        constraints.maximumIterations !== stage.constraints.maximumIterations)) ||
    (!stage.constraints.bondsToHydrogen &&
      (constraints.algorithm !== "none" ||
        constraints.bondsToHydrogen !== false ||
        constraints.tolerance !== null ||
        constraints.maximumIterations !== null))
  ) {
    throw new Error("AMBER constraint mapping must bind the exact canonical SHAKE controls");
  }
  if (stage.nonbonded.electrostatics !== "pme" || stage.nonbonded.ewaldTolerance === undefined) {
    throw new Error("Canonical AMBER mapper supports only explicit periodic PME electrostatics");
  }
  if (mapping.pmeElectrostatics.ewaldTolerance !== stage.nonbonded.ewaldTolerance) {
    throw new Error("AMBER PME mapping does not bind the canonical Ewald tolerance exactly");
  }
  if (stage.constraints.bondsToHydrogen) {
    const engine = mapping.environment.canonicalSnapshot.engine;
    if (mapping.engineSelection.engine === "pmemd.cuda") {
      if (
        engine.executable !== PMEMD26_CUDA_PROFILE.executable ||
        engine.version !== PMEMD26_CUDA_PROFILE.version ||
        engine.buildDigest !== PMEMD26_CUDA_PROFILE.binarySha256 ||
        stage.constraints.maximumIterations !== PMEMD26_CUDA_PROFILE.maximumShakeIterations
      ) {
        throw new Error(
          "GPU SHAKE requires the exact Amber 26 CUDA build and compiled iteration limit",
        );
      }
    } else {
      if (
        engine.executable !== SANDER26_CPU_PROFILE.executable ||
        engine.version !== SANDER26_CPU_PROFILE.version ||
        engine.buildDigest !== SANDER26_CPU_PROFILE.binarySha256 ||
        stage.constraints.maximumIterations !== SANDER26_CPU_PROFILE.maximumShakeIterations
      ) {
        throw new Error(
          "SHAKE requires the exact reviewed sander 26 build and compiled iteration limit",
        );
      }
    }
    if (stage.kind === "minimization") {
      throw new Error("The canonical AMBER minimization profile does not use SHAKE");
    }
  }
}

function restraintForStage(
  stage: CanonicalMdStageSpec,
  mapping: AmberCanonicalStageMapping,
  executionBinding: MdExecutionBindingParameters,
  atomCount: number,
  atomEntries: readonly AmberAtomMapViewEntry[],
): { weightKcalMolA2: number; mask: string } | undefined {
  if (stage.restraints.length === 0) {
    if (mapping.restraintMasks.length > 0 || mapping.artifactPaths.referenceArtifactId !== null) {
      throw new Error("Unrestrained canonical stages cannot declare AMBER restraint mappings");
    }
    return undefined;
  }
  if (stage.restraints.length !== 1 || mapping.restraintMasks.length !== 1) {
    throw new Error("Canonical AMBER mapper supports at most one positional restraint");
  }
  const restraint = stage.restraints[0]!;
  if (restraint.kind !== "positional") {
    throw new Error("Canonical AMBER mapper supports only positional restraints");
  }
  const points = restraint.schedule;
  if (
    points[0]?.step !== 0 ||
    points.some((point) => point.forceConstant !== points[0]!.forceConstant)
  ) {
    throw new Error("Canonical AMBER mapper supports only constant positional-restraint schedules");
  }
  const selection = restraint.selections[0]!;
  const mask = mapping.restraintMasks[0]!;
  if (
    mask.restraintId !== restraint.id ||
    mask.selectionId !== selection.id ||
    mask.selectionDefinitionDigest !== selection.definitionDigest ||
    mask.decision.id !== restraint.sourceDecisionId
  ) {
    throw new Error(
      "AMBER restraint-mask mapping does not match the canonical restraint selection",
    );
  }
  const state = canonicalState(stage, executionBinding);
  if (mapping.artifactPaths.referenceArtifactId !== state.artifactId) {
    throw new Error(
      "Restrained AMBER stages must use the exact canonical state input as reference",
    );
  }
  const derivedMask = deriveAmberAtomMask(selection.atomIndices!, atomCount, atomEntries);
  if (mask.amberMask !== derivedMask) {
    throw new Error("AMBER restraint mask does not equal the exact canonical atom selection");
  }
  return { weightKcalMolA2: points[0]!.forceConstant, mask: derivedMask };
}

function resolvedSeed(
  stage: CanonicalMdStageSpec,
  executionBinding: MdExecutionBindingParameters,
): number {
  if (stage.kind === "production") {
    const segment = executionBinding.replicaSegment;
    if (
      stage.randomSeed?.policy !== "replica_segment" ||
      segment?.segmentSeed === undefined ||
      segment.segmentIndex >= stage.randomSeed.segmentCount
    ) {
      throw new Error("Production requires an exact, finite approved per-segment seed schedule");
    }
    return segment.segmentSeed;
  }
  if (stage.randomSeed === null) throw new Error("Dynamics stage is missing a canonical seed");
  if (stage.randomSeed.policy === "replica_segment")
    throw new Error("Replica seeds require production");
  return stage.randomSeed.policy === "fixed" ? stage.randomSeed.seed : stage.randomSeed.derivedSeed;
}

function adapterStage(
  stage: CanonicalMdStageSpec,
  mapping: AmberCanonicalStageMapping,
  executionBinding: MdExecutionBindingParameters,
  verifiedDecisionIdentities: Set<string>,
  cadence: { energiesEvery: number; trajectoryEvery: number; restartEvery: number },
  atomCount: number,
  atomEntries: readonly AmberAtomMapViewEntry[],
): AdapterMdStageSpec {
  assertSupportedCoreControls(stage, mapping);
  const common = {
    title: `Canonical stage ${stage.sequence}`,
    cutoffAngstrom: stage.nonbonded.cutoffAngstrom,
    restartFormat: mapping.restart.format,
    output: cadence,
    nonbonded: {
      electrostatics: "pme" as const,
      ewaldTolerance: stage.nonbonded.ewaldTolerance!,
    },
    constraints: {
      bondsToHydrogen: stage.constraints.bondsToHydrogen,
      ...(stage.constraints.bondsToHydrogen ? { tolerance: stage.constraints.tolerance! } : {}),
    },
    restraints: restraintForStage(stage, mapping, executionBinding, atomCount, atomEntries),
  };
  if (stage.kind === "minimization") {
    if (!mapping.minimizationSplit) {
      throw new Error("Minimization requires an explicit, digest-bound AMBER cycle split");
    }
    const controls = stage.minimization!;
    if (
      mapping.minimizationSplit.algorithm !== controls.algorithm ||
      mapping.minimizationSplit.steepestDescentCycles !== controls.steepestDescentCycles
    ) {
      throw new Error("AMBER cycle split must equal the exact canonical minimization controls");
    }
    if (mapping.membranePressure !== null) {
      throw new Error("Minimization cannot declare a membrane pressure mapping");
    }
    return {
      kind: "minimization",
      ...common,
      maxCycles: stage.steps,
      steepestDescentCycles: controls.steepestDescentCycles,
      rmsGradientToleranceKcalMolAngstrom: controls.rmsGradientToleranceKcalMolAngstrom,
      initialStepAngstrom: controls.initialStepAngstrom,
      output: { ...cadence, trajectoryEvery: 0 },
    };
  }
  if (mapping.minimizationSplit !== null) {
    throw new Error("Dynamics stages cannot declare a minimization split mapping");
  }
  if (stage.ensemble === "nve") {
    if (
      stage.kind === "heating" ||
      stage.sequence === 1 ||
      stage.thermostat.kind !== "none" ||
      stage.barostat.kind !== "none" ||
      mapping.membranePressure !== null ||
      stage.temperature?.points.length !== 1 ||
      stage.temperature.points[0]?.step !== 0
    ) {
      throw new Error(
        "NVE requires a parent restart, no thermostat/pressure and one reference temperature",
      );
    }
    return {
      ...common,
      kind: stage.kind,
      ensemble: "nve",
      systemKind: stage.system.systemClass,
      steps: stage.steps,
      timestepPs: stage.timeStepPs!,
    };
  }
  if (stage.thermostat.kind !== "langevin") {
    throw new Error("Canonical AMBER mapper supports only the Langevin thermostat for dynamics");
  }
  if (stage.ensemble === "none") {
    throw new Error(`Canonical AMBER mapper does not support ${stage.ensemble} dynamics`);
  }
  const dynamics = {
    ...common,
    steps: stage.steps,
    timestepPs: stage.timeStepPs!,
    thermostatCollisionPs: stage.thermostat.collisionFrequencyPerPs,
    randomSeed: resolvedSeed(stage, executionBinding),
  };
  const maximumTimestep = stage.constraints.bondsToHydrogen ? 0.002 : 0.001;
  if (stage.timeStepPs! > maximumTimestep) {
    throw new Error(
      `Canonical AMBER dynamics is limited to a ${maximumTimestep} ps timestep for its constraints`,
    );
  }
  if (stage.kind === "heating") {
    if (stage.ensemble !== "nvt" || stage.barostat.kind !== "none") {
      throw new Error("Canonical AMBER heating supports only NVT without a barostat");
    }
    if (mapping.membranePressure !== null) {
      throw new Error("NVT heating cannot declare a membrane pressure mapping");
    }
    const points = stage.temperature!.points;
    if (points.length !== 2 || points[0]!.step !== 0 || points[1]!.step !== stage.steps) {
      throw new Error("Canonical AMBER heating supports exactly one linear full-stage ramp");
    }
    return {
      kind: "heating",
      ...dynamics,
      initialTemperatureK: points[0]!.kelvin,
      targetTemperatureK: points[1]!.kelvin,
    };
  }
  const points = stage.temperature!.points;
  if (stage.sequence === 1) {
    throw new Error("AMBER equilibration/production requires an exact parent restart input");
  }
  if (points.length !== 1 || points[0]!.step !== 0) {
    throw new Error("Canonical AMBER equilibration/production supports only constant temperature");
  }
  if (stage.ensemble === "nvt") {
    if (stage.barostat.kind !== "none" || mapping.membranePressure !== null) {
      throw new Error("NVT stages cannot declare pressure mappings");
    }
    return {
      kind: stage.kind,
      ...dynamics,
      ensemble: "nvt",
      systemKind: stage.system.systemClass,
      temperatureK: points[0]!.kelvin,
    };
  }
  if (stage.system.systemClass === "soluble") {
    if (
      stage.barostat.kind !== "monte_carlo" ||
      stage.barostat.compressibilityPerBar !== undefined ||
      stage.barostat.coupling !== "isotropic" ||
      mapping.membranePressure !== null
    ) {
      throw new Error("Soluble NPT requires isotropic coupling and no membrane pressure mapping");
    }
    return {
      kind: stage.kind,
      ...dynamics,
      ensemble: "npt",
      systemKind: "soluble",
      temperatureK: points[0]!.kelvin,
      pressureBar: stage.barostat.targetPressureBar,
      pressureRelaxationPs: stage.barostat.relaxationTimePs,
      pressureCoupling: "isotropic",
      barostatAlgorithm: "monte_carlo",
    };
  }
  if (stage.barostat.kind !== "berendsen") {
    throw new Error("Membrane NPT requires the Berendsen barostat qualified for Amber 26");
  }
  if (stage.barostat.coupling !== "semiisotropic" || mapping.membranePressure === null) {
    throw new Error(
      "Membrane NPT requires semi-isotropic coupling and an explicit reviewed pressure mapping",
    );
  }
  const pressure = mapping.membranePressure;
  if (
    stage.barostat.kind !== "berendsen" ||
    stage.barostat.compressibilityPerBar !== undefined ||
    pressure.algorithm !== "berendsen" ||
    pressure.targetPressureBar !== stage.barostat.targetPressureBar ||
    pressure.pressureRelaxationPs !== stage.barostat.relaxationTimePs ||
    pressure.surfaceOrientation !== "xy"
  ) {
    throw new Error("Membrane pressure mapping must exactly match the approved Amber 26 controls");
  }
  const pressureReviewIdentity = mappingDecisionIdentity(mapping.membranePressure.decision);
  const membranePressurePolicyReviewed = verifiedDecisionIdentities.has(pressureReviewIdentity)
    ? (true as const)
    : undefined;
  if (membranePressurePolicyReviewed !== true) {
    throw new Error("Membrane pressure mapping lacks an exact approved WorkUnit decision");
  }
  return {
    kind: stage.kind,
    ...dynamics,
    ensemble: "npt",
    systemKind: "membrane",
    temperatureK: points[0]!.kelvin,
    pressureBar: stage.barostat.targetPressureBar,
    pressureRelaxationPs: stage.barostat.relaxationTimePs,
    pressureCoupling: "semiisotropic",
    barostatAlgorithm: "berendsen",
    membranePressurePolicyReviewed,
    surfaceOrientation: mapping.membranePressure.surfaceOrientation,
    surfaceTensionDynCm: mapping.membranePressure.surfaceTensionDynCm,
    interfaces: mapping.membranePressure.interfaces,
  };
}

export { assertEngineResourceCompatibility, assertNoUnboundMaterialMappings, adapterStage };
