import { describe, expect, test } from "bun:test";
import {
  MdStageOperationRequestSchema,
  assertMdStageSpecDigest,
  computeMdRestraintSelectionDigest,
  digestCanonical,
} from "@eigengrid/scientific-schema";
import { canonicalEntriesFromAmberView, deriveAmberAtomMapView } from "./atom-map";
import {
  AMBER_CANONICAL_STAGE_MAPPING_VERSION,
  AMBER_STAGE_OUTPUT_ROLE_MAPPING_VERSION,
  assertAmberCanonicalStageMappingDigest,
  assertRenderedCanonicalAmberStageDigest,
  computeCanonicalMdExecutionBindingDigest,
  mapAmberStageCommandOutputRoles,
  renderCanonicalAmberStage,
} from "./canonical-stage-mapper";
import {
  createAmberEnvironmentBinding,
  computeCanonicalMdEnvironmentDigest,
} from "./environment-binding";
import {
  assertAmberMdStageOperationRequest,
  createAmberMdStageOperationRequest,
} from "./stage-operation-authority";

import {
  digest,
  topologyDigest,
  coordinateDigest,
  parentDigest,
  segmentParentDigest,
  canonicalAtomMap,
  system,
  unsignedStage,
  signedStage,
  adapterEnvironment,
  snapshotBase,
  snapshot,
  environmentBinding,
  decision,
  executionBindingFor,
  unsignedMapping,
  signedMapping,
  reviewedSander26Environment,
  reviewedPmemdCuda26Environment,
  resignStage,
  explicitMinimization,
} from "./canonical-stage.fixture";

describe("canonical scientific stage to AMBER mapping", () => {
  test("renders the exact segment seed, never silently reusing the replica initial seed", () => {
    const stage = signedStage();
    const initial = executionBindingFor(stage);
    const continuation = {
      ...initial,
      replicaSegment: { ...initial.replicaSegment!, segmentIndex: 1, segmentSeed: 771_002 },
    };
    const rendered = renderCanonicalAmberStage(
      stage,
      signedMapping(unsignedMapping(stage, continuation)),
      continuation,
      canonicalAtomMap,
    );
    expect(rendered.renderedMdin.content).toContain("ig=771002,");
    expect(rendered.renderedMdin.content).not.toContain("ig=771001,");
    expect(rendered.runtimeBindings.replicaSegment?.segmentSeed).toBe(771_002);
    for (const segment of [
      { ...continuation.replicaSegment, segmentIndex: 2 },
      { ...continuation.replicaSegment, segmentSeed: undefined },
    ]) {
      const binding = { ...continuation, replicaSegment: segment };
      expect(() =>
        renderCanonicalAmberStage(
          stage,
          signedMapping(unsignedMapping(stage, binding)),
          binding,
          canonicalAtomMap,
        ),
      ).toThrow(/per-segment seed schedule/);
    }
    const historical = resignStage({
      ...stage,
      randomSeed: { policy: "fixed" as const, seed: 912_345 },
    });
    expect(assertMdStageSpecDigest(historical).randomSeed).toEqual({
      policy: "fixed",
      seed: 912_345,
    });
    const historicalBinding = executionBindingFor(historical);
    expect(() =>
      renderCanonicalAmberStage(
        historical,
        signedMapping(unsignedMapping(historical, historicalBinding)),
        historicalBinding,
        canonicalAtomMap,
      ),
    ).toThrow(/per-segment seed schedule/);
  });

  test("derives positional restraint masks from the approved canonical atom indices", () => {
    const fixture = explicitMinimization();
    const selection = {
      id: "exact-carbon",
      atomCount: 1,
      atomIndices: [1],
      description: "Canonical carbon atom 1",
      definitionDigest: computeMdRestraintSelectionDigest(canonicalAtomMap.mapDigest, [1]),
    };
    const stage = resignStage({
      ...fixture.stage,
      restraints: [
        {
          id: "restrain-carbon",
          kind: "positional" as const,
          selections: [selection],
          schedule: [{ step: 0, forceConstant: 10 }],
          sourceDecisionId: "restraint-decision",
        },
      ],
      sourceDecisionRefs: [...fixture.stage.sourceDecisionRefs, "restraint-decision"],
    });
    const binding = executionBindingFor(stage);
    const current = unsignedMapping(stage, binding);
    const oldMapping = assertAmberCanonicalStageMappingDigest(fixture.mapping);
    const base = {
      ...oldMapping,
      canonicalStage: current.canonicalStage,
      canonicalWorkUnit: current.canonicalWorkUnit,
      restraintMasks: [
        {
          restraintId: "restrain-carbon",
          selectionId: selection.id,
          selectionDefinitionDigest: selection.definitionDigest,
          amberMask: "@1",
          decision: decision("restraint-decision", "6"),
        },
      ],
      artifactPaths: { ...oldMapping.artifactPaths, referenceArtifactId: "coordinates" },
    };
    const rendered = renderCanonicalAmberStage(
      stage,
      signedMapping(base),
      binding,
      canonicalAtomMap,
    );
    expect(rendered.renderedMdin.content).toContain("restraintmask='@1',");
    expect(rendered.renderedMdin.content).toContain("restraint_wt=10,");
    expect(rendered.commandRequest.argv.slice(-2)).toEqual(["-ref", "inputs/system.rst7"]);
    for (const amberMask of ["@2", ":1", "@1-2", "!:WAT"]) {
      expect(() =>
        renderCanonicalAmberStage(
          stage,
          signedMapping({ ...base, restraintMasks: [{ ...base.restraintMasks[0]!, amberMask }] }),
          binding,
          canonicalAtomMap,
        ),
      ).toThrow(/exact canonical atom selection/);
    }
    const changedSelection = { ...selection, atomIndices: [2] };
    const changed = {
      ...stage,
      restraints: [{ ...stage.restraints[0]!, selections: [changedSelection] }],
    };
    expect(() => assertMdStageSpecDigest(resignStage(changed))).toThrow(
      /exact indices and canonical atom map/,
    );
    const rehashedSelection = {
      ...changedSelection,
      definitionDigest: computeMdRestraintSelectionDigest(canonicalAtomMap.mapDigest, [2]),
    };
    const revised = resignStage({
      ...changed,
      restraints: [{ ...changed.restraints[0]!, selections: [rehashedSelection] }],
    });
    expect(revised.stageDigest).not.toBe(stage.stageDigest);
    expect(() =>
      renderCanonicalAmberStage(revised, signedMapping(base), binding, canonicalAtomMap),
    ).toThrow();
    for (const atomIndices of [
      [1, 1],
      [2, 1],
    ]) {
      const invalid = {
        ...selection,
        atomCount: 2,
        atomIndices,
        definitionDigest: computeMdRestraintSelectionDigest(
          canonicalAtomMap.mapDigest,
          atomIndices,
        ),
      };
      expect(() =>
        assertMdStageSpecDigest(
          resignStage({
            ...stage,
            restraints: [{ ...stage.restraints[0]!, selections: [invalid] }],
          }),
        ),
      ).toThrow(/unique and strictly ordered/);
    }
  });

  test("renders exactly approved minimization controls and its three real outputs", () => {
    const { stage, binding, mapping } = explicitMinimization();
    const rendered = renderCanonicalAmberStage(stage, mapping, binding, canonicalAtomMap);
    for (const control of [
      "ntmin=1,",
      "ncyc=80,",
      "maxcyc=200,",
      "drms=0.0002,",
      "dx0=0.015,",
      "ntwx=0,",
      "ntc=1,",
    ]) {
      expect(rendered.renderedMdin.content).toContain(control);
    }
    expect(rendered.commandRequest.argv).not.toContain("-x");
    expect(rendered.commandRequest.outputs).toHaveLength(3);
    const request = createAmberMdStageOperationRequest(rendered, environmentBinding, {
      workUnitId: "min-wu",
      bindingDigest: computeCanonicalMdExecutionBindingDigest(binding),
      outputContractDigest: digestCanonical(stage.outputs),
    });
    expect(request.stage.kind).toBe("minimization");
    expect(request.outputs.bindings.map((output) => output.canonicalRole)).toEqual([
      "restart",
      "mdout",
      "mdinfo",
    ]);
    expect(() =>
      MdStageOperationRequestSchema.parse({
        ...request,
        stage: { ...request.stage, kind: "production" },
      }),
    ).toThrow();
    expect(() =>
      MdStageOperationRequestSchema.parse({
        ...request,
        stage: { ...request.stage, kind: undefined },
      }),
    ).toThrow();
    for (const controls of [
      { ...stage.minimization, steepestDescentCycles: 81 },
      { ...stage.minimization, rmsGradientToleranceKcalMolAngstrom: 0.0003 },
      { ...stage.minimization, initialStepAngstrom: 0.016 },
    ]) {
      const changed = resignStage({ ...stage, minimization: controls });
      expect(changed.stageDigest).not.toBe(stage.stageDigest);
      expect(() =>
        renderCanonicalAmberStage(changed, mapping, binding, canonicalAtomMap),
      ).toThrow();
    }
    expect(() =>
      renderCanonicalAmberStage(
        stage,
        signedMapping({
          ...mapping,
          minimizationSplit: {
            algorithm: stage.minimization.algorithm,
            steepestDescentCycles: 81,
            decision: decision("minimization-decision", "7"),
          },
        }),
        binding,
        canonicalAtomMap,
      ),
    ).toThrow(/exact canonical minimization controls/);
  });

  test("does not promise periodic minimization checkpoints or a trajectory", () => {
    const { stage, binding, mapping } = explicitMinimization();
    for (const changed of [
      resignStage({
        ...stage,
        checkpoint: { ...stage.checkpoint, stopAfterCheckpointSupported: true },
      }),
      resignStage({ ...stage, outputs: unsignedStage().outputs }),
    ]) {
      const changedBinding = executionBindingFor(changed);
      const current = unsignedMapping(changed, changedBinding);
      expect(() =>
        renderCanonicalAmberStage(
          changed,
          signedMapping({
            ...mapping,
            canonicalStage: current.canonicalStage,
            canonicalWorkUnit: current.canonicalWorkUnit,
          }),
          changedBinding,
          canonicalAtomMap,
        ),
      ).toThrow(/checkpoint|trajectory/);
    }
    const badOutputMapping = signedMapping({
      ...mapping,
      artifactPaths: {
        ...unsignedMapping(stage, binding).artifactPaths,
        inputs: [
          {
            artifactId: "topology",
            role: "topology",
            contentDigest: topologyDigest,
            logicalPath: "inputs/system.prmtop",
          },
          {
            artifactId: "coordinates",
            role: "coordinates",
            contentDigest: coordinateDigest,
            logicalPath: "inputs/system.rst7",
          },
        ],
      },
    });
    expect(() =>
      renderCanonicalAmberStage(stage, badOutputMapping, binding, canonicalAtomMap),
    ).toThrow(/trajectory/);
    expect(() =>
      assertMdStageSpecDigest(
        resignStage({
          ...stage,
          minimization: { ...stage.minimization, steepestDescentCycles: 201 },
        }),
      ),
    ).toThrow(/approved minimization length/);
    expect(() =>
      assertMdStageSpecDigest(
        resignStage({ ...unsignedStage(), minimization: stage.minimization }),
      ),
    ).toThrow(/Dynamics stages cannot/);
  });

  test("maps SHAKE only for the reviewed exact binary and its compiled bound", () => {
    const stage = resignStage({
      ...unsignedStage(),
      constraints: { bondsToHydrogen: true, tolerance: 0.000001, maximumIterations: 3001 },
    });
    const binding = executionBindingFor(stage);
    const base = { ...unsignedMapping(stage, binding), environment: reviewedSander26Environment() };
    const rendered = renderCanonicalAmberStage(
      stage,
      signedMapping(base),
      binding,
      canonicalAtomMap,
    );
    for (const control of ["ntc=2,", "ntf=2,", "tol=0.000001,", "jfastw=0,"]) {
      expect(rendered.renderedMdin.content).toContain(control);
    }
    expect(rendered.renderedMdin.content).not.toContain("3001"); // No invented Amber input keyword.
    expect(() =>
      renderCanonicalAmberStage(
        stage,
        signedMapping({ ...base, environment: reviewedSander26Environment(digest("e")) }),
        binding,
        canonicalAtomMap,
      ),
    ).toThrow(/exact reviewed sander/);
    for (const maximumIterations of [100, 3000, 3002]) {
      const changed = resignStage({
        ...stage,
        constraints: { ...stage.constraints, maximumIterations },
      });
      const changedBinding = executionBindingFor(changed);
      expect(() =>
        renderCanonicalAmberStage(
          changed,
          signedMapping({
            ...unsignedMapping(changed, changedBinding),
            environment: base.environment,
          }),
          changedBinding,
          canonicalAtomMap,
        ),
      ).toThrow(/compiled iteration limit/);
    }
  });

  test("maps the exact Amber 26 Beast pmemd.cuda SHAKE profile without inheriting the CPU bound", () => {
    const base = unsignedStage();
    const membrane = resignStage({
      ...base,
      system: { ...base.system, systemClass: "membrane" as const },
      ensemble: "npt" as const,
      barostat: {
        kind: "berendsen" as const,
        coupling: "semiisotropic" as const,
        targetPressureBar: 1,
        relaxationTimePs: 1,
      },
      constraints: { bondsToHydrogen: true, tolerance: 0.00001, maximumIterations: 3000 },
      resourceProfile: { ...base.resourceProfile, gpuCount: 1 },
      sourceDecisionRefs: [...base.sourceDecisionRefs, "membrane-pressure-decision"],
    });
    const binding = executionBindingFor(membrane);
    const mappingBase = {
      ...unsignedMapping(membrane, binding),
      environment: reviewedPmemdCuda26Environment(),
      engineSelection: { engine: "pmemd.cuda" as const },
      membranePressure: {
        mode: "constant_surface_tension" as const,
        algorithm: "berendsen" as const,
        targetPressureBar: 1,
        pressureRelaxationPs: 1,
        surfaceOrientation: "xy" as const,
        surfaceTensionDynCm: 0,
        interfaces: 2 as const,
        decision: decision("membrane-pressure-decision", "8"),
      },
    };
    const rendered = renderCanonicalAmberStage(
      membrane,
      signedMapping(mappingBase),
      binding,
      canonicalAtomMap,
    );
    for (const control of [
      "ntp=3,",
      "barostat=1,",
      "csurften=3,",
      "gamma_ten=0,",
      "ninterface=2,",
      "ntc=2,",
      "ntf=2,",
      "tol=0.00001,",
      "jfastw=0,",
    ]) {
      expect(rendered.renderedMdin.content).toContain(control);
    }

    const wrongBinary = reviewedPmemdCuda26Environment(digest("e"));
    expect(() =>
      renderCanonicalAmberStage(
        membrane,
        signedMapping({ ...mappingBase, environment: wrongBinary }),
        binding,
        canonicalAtomMap,
      ),
    ).toThrow(/exact Amber 26 CUDA build/);

    const wrongIterationBound = resignStage({
      ...membrane,
      constraints: { ...membrane.constraints, maximumIterations: 3001 },
    });
    const wrongBinding = executionBindingFor(wrongIterationBound);
    expect(() =>
      renderCanonicalAmberStage(
        wrongIterationBound,
        signedMapping({
          ...unsignedMapping(wrongIterationBound, wrongBinding),
          environment: mappingBase.environment,
          engineSelection: mappingBase.engineSelection,
          membranePressure: mappingBase.membranePressure,
        }),
        wrongBinding,
        canonicalAtomMap,
      ),
    ).toThrow(/exact Amber 26 CUDA build/);
  });

  test("renders a digest-bound subset without shell or host paths", () => {
    const stage = signedStage();
    const executionBinding = executionBindingFor(stage);
    const mappingBase = unsignedMapping(stage, executionBinding);
    const mapping = signedMapping(mappingBase);
    const rendered = renderCanonicalAmberStage(stage, mapping, executionBinding, canonicalAtomMap);

    expect(rendered.canonicalStage).toEqual({
      id: stage.id,
      revision: stage.revision,
      kind: stage.kind,
      stageDigest: stage.stageDigest,
    });
    expect(rendered.mapping).toEqual({
      version: AMBER_CANONICAL_STAGE_MAPPING_VERSION,
      digest: mapping.mappingDigest,
    });
    expect(rendered.renderedMdin.content).toContain("ntc=1,");
    expect(rendered.renderedMdin.content).toContain("ew_type=0,");
    expect(rendered.renderedMdin.content).toContain("dsum_tol=0.00001,");
    expect(rendered.renderedMdin.content).toContain("ig=771001,");
    expect(rendered.commandRequest.shell).toBe(false);
    expect(rendered.commandRequest.argv).toContain("inputs/parent.rst7");
    expect(
      rendered.commandRequest.inputs.find((input) => input.role === "coordinates.input")?.sha256,
    ).toBe(segmentParentDigest);
    expect(rendered.commandRequest.argv.join(" ")).not.toContain("/tmp");
    expect(rendered.runtimeBindings.resourceProfile).toEqual(stage.resourceProfile);
    expect(rendered.runtimeBindings.acceptanceCriteria).toEqual(stage.acceptanceCriteria);
    expect(rendered.runtimeBindings.atomMapView.canonicalAtomMap.mapDigest).toBe(
      stage.system.atomMapDigest,
    );
    expect(rendered.runtimeBindings.atomMapView.viewDigest).not.toBe(stage.system.atomMapDigest);
    expect(rendered.executionBindingDigest).toBe(
      computeCanonicalMdExecutionBindingDigest(executionBinding),
    );
    expect(rendered.runtimeBindings.replicaSegment).toEqual(executionBinding.replicaSegment!);
    expect(rendered.runtimeBindings.replicaSegment?.replicaSeed).toBe(771_001);
    expect(rendered.runtimeBindings.parentRestart?.contentDigest).toBe(segmentParentDigest);
    const templateRestartMapping = signedMapping({
      ...mappingBase,
      artifactPaths: {
        ...mappingBase.artifactPaths,
        inputs: mappingBase.artifactPaths.inputs.map((input) =>
          input.role === "parent_restart" ? { ...input, contentDigest: parentDigest } : input,
        ),
      },
    });
    expect(() =>
      renderCanonicalAmberStage(stage, templateRestartMapping, executionBinding, canonicalAtomMap),
    ).toThrow(/does not match canonical artifact/);
    expect(rendered.renderDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(() =>
      assertRenderedCanonicalAmberStageDigest({
        ...rendered,
        runtimeBindings: {
          ...rendered.runtimeBindings,
          checkpoint: { ...rendered.runtimeBindings.checkpoint, retainCount: 99 },
        },
      }),
    ).toThrow(/render digest mismatch/);
    expect(() =>
      assertRenderedCanonicalAmberStageDigest({
        ...rendered,
        executionBindingDigest: digest("f"),
      }),
    ).toThrow(/render digest mismatch/i);
  });

  test("fails closed when material minimization or membrane payloads lack a canonical owner", () => {
    const productionBase = unsignedStage();
    const minimization = resignStage({
      ...productionBase,
      id: "minimization-1",
      sequence: 1,
      kind: "minimization" as const,
      name: "Initial minimization",
      parentStageId: null,
      requiredParentOutputRole: null,
      inputs: [
        productionBase.inputs[0]!,
        {
          artifactId: "coordinates",
          evidenceRef: "evidence-coordinates",
          role: "coordinates" as const,
          contentDigest: coordinateDigest,
          mediaType: "application/vnd.amber.rst7",
        },
      ],
      ensemble: "none",
      steps: 200,
      timeStepPs: null,
      simulatedTimePs: null,
      temperature: null,
      thermostat: { kind: "none" },
      barostat: { kind: "none" },
      randomSeed: null,
      checkpoint: { ...productionBase.checkpoint, cadenceSteps: 100 },
      outputs: productionBase.outputs.map((output) =>
        output.role === "restart" ? { ...output, cadenceSteps: 100 } : output,
      ),
      sourceDecisionRefs: [...productionBase.sourceDecisionRefs, "minimization-decision"],
    });
    const minimizationBinding = executionBindingFor(minimization);
    const minimizationMappingBase = unsignedMapping(minimization, minimizationBinding);
    const minimizationMapping = signedMapping({
      ...minimizationMappingBase,
      minimizationSplit: {
        algorithm: "steepest_descent_then_conjugate_gradient",
        steepestDescentCycles: 80,
        decision: decision("minimization-decision", "7"),
      },
      artifactPaths: {
        ...minimizationMappingBase.artifactPaths,
        inputs: [
          minimizationMappingBase.artifactPaths.inputs[0]!,
          {
            artifactId: "coordinates",
            role: "coordinates",
            contentDigest: coordinateDigest,
            logicalPath: "inputs/system.rst7",
          },
        ],
      },
    });
    expect(() =>
      renderCanonicalAmberStage(
        minimization,
        minimizationMapping,
        minimizationBinding,
        canonicalAtomMap,
      ),
    ).toThrow(/cycle split is part of the canonical approved stage/);

    const membraneBase = {
      ...productionBase,
      system: { ...productionBase.system, systemClass: "membrane" as const },
      ensemble: "npt" as const,
      barostat: {
        kind: "berendsen" as const,
        coupling: "semiisotropic" as const,
        targetPressureBar: 1,
        relaxationTimePs: 1,
      },
      constraints: { bondsToHydrogen: true, tolerance: 0.000001, maximumIterations: 3001 },
      sourceDecisionRefs: [...productionBase.sourceDecisionRefs, "membrane-pressure-decision"],
    };
    const membrane = resignStage(membraneBase);
    const membraneBinding = executionBindingFor(membrane);
    const membraneMappingBase = {
      ...unsignedMapping(membrane, membraneBinding),
      environment: reviewedSander26Environment(),
    };
    expect(() =>
      renderCanonicalAmberStage(
        membrane,
        signedMapping(membraneMappingBase),
        membraneBinding,
        canonicalAtomMap,
      ),
    ).toThrow(/explicit reviewed pressure mapping/);
    const membraneMapping = signedMapping({
      ...membraneMappingBase,
      membranePressure: {
        mode: "constant_surface_tension",
        algorithm: "berendsen",
        targetPressureBar: 1,
        pressureRelaxationPs: 1,
        surfaceOrientation: "xy",
        surfaceTensionDynCm: 0,
        interfaces: 2,
        decision: decision("membrane-pressure-decision", "8"),
      },
    });
    const renderedMembrane = renderCanonicalAmberStage(
      membrane,
      membraneMapping,
      membraneBinding,
      canonicalAtomMap,
    );
    for (const control of [
      "ntp=3,",
      "barostat=1,",
      "pres0=1,",
      "taup=1,",
      "csurften=3,",
      "gamma_ten=0,",
      "ninterface=2,",
      "ntc=2,",
      "ntf=2,",
      "tol=0.000001,",
    ]) {
      expect(renderedMembrane.renderedMdin.content).toContain(control);
    }
    const pressureControls = {
      mode: "constant_surface_tension" as const,
      algorithm: "berendsen" as const,
      targetPressureBar: 1,
      pressureRelaxationPs: 1,
      surfaceOrientation: "xy" as const,
      surfaceTensionDynCm: 0,
      interfaces: 2 as const,
      decision: decision("membrane-pressure-decision", "8"),
    };
    const alteredPressure = signedMapping({
      ...membraneMappingBase,
      membranePressure: { ...pressureControls, pressureRelaxationPs: 2 },
    });
    expect(() =>
      renderCanonicalAmberStage(membrane, alteredPressure, membraneBinding, canonicalAtomMap),
    ).toThrow(/exactly match the approved Amber 26 controls/);
    const alteredConstraints = signedMapping({
      ...membraneMapping,
      constraints: {
        algorithm: "shake" as const,
        bondsToHydrogen: true as const,
        tolerance: 0.000001,
        maximumIterations: 3000,
      },
    });
    expect(() =>
      renderCanonicalAmberStage(membrane, alteredConstraints, membraneBinding, canonicalAtomMap),
    ).toThrow(/constraint mapping must bind the exact canonical SHAKE controls/);
  });

  test("rejects canonical digest tampering and mapping drift", () => {
    const stage = signedStage();
    const executionBinding = executionBindingFor(stage);
    const mappingBase = unsignedMapping(stage, executionBinding);
    const mapping = signedMapping(mappingBase);
    expect(() =>
      renderCanonicalAmberStage(
        { ...stage, name: "tampered" },
        mapping,
        executionBinding,
        canonicalAtomMap,
      ),
    ).toThrow(/digest mismatch/i);
    expect(() =>
      renderCanonicalAmberStage(
        stage,
        { ...mapping, restart: { ...mappingBase.restart, format: "netcdf" } },
        executionBinding,
        canonicalAtomMap,
      ),
    ).toThrow(/mapping digest mismatch/i);
  });

  test("requires the exact WorkUnit plan, system, protocol, and stage binding", () => {
    const stage = signedStage();
    const executionBinding = executionBindingFor(stage);
    const mappingBase = unsignedMapping(stage, executionBinding);
    const mapping = signedMapping(mappingBase);

    const staleBinding = {
      ...executionBinding,
      stage: { ...executionBinding.stage, revision: 2 },
    };
    expect(() => renderCanonicalAmberStage(stage, mapping, staleBinding, canonicalAtomMap)).toThrow(
      /binding digest mismatch/,
    );

    const staleStageMappingBase = unsignedMapping(stage, staleBinding);
    expect(() =>
      renderCanonicalAmberStage(
        stage,
        signedMapping(staleStageMappingBase),
        staleBinding,
        canonicalAtomMap,
      ),
    ).toThrow(/stage identity/);

    for (const field of ["plan", "system", "protocol"] as const) {
      const driftedMapping = {
        ...mappingBase,
        canonicalWorkUnit: {
          ...mappingBase.canonicalWorkUnit,
          [field]: { ...mappingBase.canonicalWorkUnit[field], approvalRef: `false-${field}` },
        },
      };
      expect(() =>
        renderCanonicalAmberStage(
          stage,
          signedMapping(driftedMapping),
          executionBinding,
          canonicalAtomMap,
        ),
      ).toThrow(new RegExp(`${field} identity`));
    }
  });

  test("rejects decision laundering for derived fields and missing stage decisions", () => {
    const stage = signedStage();
    const validBinding = executionBindingFor(stage);

    const mappingBase = unsignedMapping(stage, validBinding);
    for (const alteredMapping of [
      {
        ...mappingBase,
        engineSelection: {
          ...mappingBase.engineSelection,
          decision: decision("construct-decision", "3"),
        },
      },
      {
        ...mappingBase,
        restart: { ...mappingBase.restart, decision: decision("construct-decision", "3") },
      },
      {
        ...mappingBase,
        pmeElectrostatics: {
          ...mappingBase.pmeElectrostatics,
          decision: decision("construct-decision", "3"),
        },
      },
    ]) {
      expect(() =>
        renderCanonicalAmberStage(
          stage,
          signedMapping(alteredMapping),
          validBinding,
          canonicalAtomMap,
        ),
      ).toThrow();
    }

    const missingDecisionBinding = {
      ...validBinding,
      decisions: validBinding.decisions.filter((reference) => reference.id !== "pose-decision"),
    };
    const missingMapping = signedMapping(unsignedMapping(stage, missingDecisionBinding));
    expect(() =>
      renderCanonicalAmberStage(stage, missingMapping, missingDecisionBinding, canonicalAtomMap),
    ).toThrow(/no exact decision reference.*pose-decision/);
  });

  test("derives PME, restart format, and the CPU engine without decision authority", () => {
    const stage = signedStage();
    const executionBinding = executionBindingFor(stage);
    const mappingBase = unsignedMapping(stage, executionBinding);

    const pmeDrift = signedMapping({
      ...mappingBase,
      pmeElectrostatics: { ...mappingBase.pmeElectrostatics, ewaldTolerance: 0.00002 },
    });
    expect(() =>
      renderCanonicalAmberStage(stage, pmeDrift, executionBinding, canonicalAtomMap),
    ).toThrow(/Ewald tolerance exactly/);

    const restartDrift = signedMapping({
      ...mappingBase,
      restart: { format: "netcdf" },
    });
    expect(() =>
      renderCanonicalAmberStage(stage, restartDrift, executionBinding, canonicalAtomMap),
    ).toThrow(/restart media type/);

    const unsupportedCpuPmemd = signedMapping({
      ...mappingBase,
      engineSelection: { engine: "pmemd" },
    });
    expect(() =>
      renderCanonicalAmberStage(stage, unsupportedCpuPmemd, executionBinding, canonicalAtomMap),
    ).toThrow(/expected sander/);
  });

  test("fails closed for unsupported ensembles, thermostats, barostats, constraints, and electrostatics", () => {
    const base = unsignedStage();
    const variants = [
      {
        ...base,
        ensemble: "nve" as const,
        // NVE is supported by engine adapter, but a reference-temperature ramp is not.
        temperature: {
          points: [
            { step: 0, kelvin: 300 },
            { step: base.steps, kelvin: 310 },
          ],
        },
        thermostat: { kind: "none" as const },
      },
      {
        ...base,
        thermostat: { kind: "berendsen" as const, couplingTimePs: 1 },
      },
      {
        ...base,
        ensemble: "npt" as const,
        barostat: {
          kind: "berendsen" as const,
          coupling: "isotropic" as const,
          targetPressureBar: 1,
          relaxationTimePs: 2,
        },
      },
      {
        ...base,
        constraints: { bondsToHydrogen: true, tolerance: 0.00001, maximumIterations: 100 },
      },
      {
        ...base,
        nonbonded: {
          cutoffAngstrom: 10,
          electrostatics: "reaction_field" as const,
          periodicBoundary: true as const,
        },
      },
    ];
    for (const variant of variants) {
      const stage = resignStage(variant);
      const executionBinding = executionBindingFor(stage);
      const mapping = signedMapping(unsignedMapping(stage, executionBinding));
      expect(() =>
        renderCanonicalAmberStage(stage, mapping, executionBinding, canonicalAtomMap),
      ).toThrow();
    }
  });

  test("fails closed for restraint masks until the approved typed payload is durable", () => {
    const base = unsignedStage();
    const restrained = resignStage({
      ...base,
      restraints: [
        {
          id: "restraint-1",
          kind: "positional" as const,
          selections: [
            {
              id: "protein-heavy",
              definitionDigest: digest("5"),
              atomCount: 20,
              description: "protein heavy atoms",
            },
          ],
          schedule: [
            { step: 0, forceConstant: 10 },
            { step: 1_000, forceConstant: 0 },
          ],
          sourceDecisionId: "restraint-decision",
        },
      ],
      sourceDecisionRefs: [...base.sourceDecisionRefs, "restraint-decision"],
    });
    const executionBinding = executionBindingFor(restrained);
    const mappingBase = unsignedMapping(restrained, executionBinding);
    const mapping = signedMapping({
      ...mappingBase,
      restraintMasks: [
        {
          restraintId: "restraint-1",
          selectionId: "protein-heavy",
          selectionDefinitionDigest: digest("5"),
          amberMask: "!:WAT",
          decision: decision("restraint-decision", "6"),
        },
      ],
      artifactPaths: { ...mappingBase.artifactPaths, referenceArtifactId: "parent-restart" },
    });
    expect(() =>
      renderCanonicalAmberStage(restrained, mapping, executionBinding, canonicalAtomMap),
    ).toThrow(/canonical approved payload/);
  });

  test("rejects unsafe logical paths, exact input drift, and stage-kind mismatch", () => {
    const stage = signedStage();
    const executionBinding = executionBindingFor(stage);
    const base = unsignedMapping(stage, executionBinding);
    const unsafe = {
      ...base,
      artifactPaths: { ...base.artifactPaths, mdin: "/tmp/raw.mdin" },
    };
    expect(() =>
      renderCanonicalAmberStage(stage, signedMapping(unsafe), executionBinding, canonicalAtomMap),
    ).toThrow(/logical paths must be relative/);

    const driftedInput = {
      ...base,
      artifactPaths: {
        ...base.artifactPaths,
        inputs: base.artifactPaths.inputs.map((input) =>
          input.role === "topology" ? { ...input, contentDigest: digest("7") } : input,
        ),
      },
    };
    expect(() =>
      renderCanonicalAmberStage(
        stage,
        signedMapping(driftedInput),
        executionBinding,
        canonicalAtomMap,
      ),
    ).toThrow(/does not match canonical artifact/);

    const kindMismatch = {
      ...base,
      canonicalStage: { ...base.canonicalStage, kind: "equilibration" as const },
    };
    expect(() =>
      renderCanonicalAmberStage(
        stage,
        signedMapping(kindMismatch),
        executionBinding,
        canonicalAtomMap,
      ),
    ).toThrow(/canonical stage identity/);
  });

  test("uses a versioned closed output-role map, never path suffix inference", () => {
    const stage = signedStage();
    const executionBinding = executionBindingFor(stage);
    const rendered = renderCanonicalAmberStage(
      stage,
      signedMapping(unsignedMapping(stage, executionBinding)),
      executionBinding,
      canonicalAtomMap,
    );
    expect(rendered.outputRoleMapping.version).toBe(AMBER_STAGE_OUTPUT_ROLE_MAPPING_VERSION);
    expect(rendered.outputRoleMapping.bindings).toEqual([
      { engineRole: "stage.restart", canonicalRole: "restart" },
      { engineRole: "stage.trajectory", canonicalRole: "trajectory" },
      { engineRole: "stage.mdout", canonicalRole: "mdout" },
      { engineRole: "stage.mdinfo", canonicalRole: "mdinfo" },
    ]);
    const swappedPaths = {
      ...rendered.commandRequest,
      outputs: rendered.commandRequest.outputs.map((output) =>
        output.role === "stage.mdout"
          ? { ...output, logicalPath: "outputs/production.mdinfo" }
          : output.role === "stage.mdinfo"
            ? { ...output, logicalPath: "outputs/production.mdout" }
            : output,
      ),
    };
    expect(mapAmberStageCommandOutputRoles(swappedPaths)).toEqual(rendered.outputRoleMapping);
    expect(() =>
      mapAmberStageCommandOutputRoles({
        ...rendered.commandRequest,
        outputs: rendered.commandRequest.outputs.map((output) =>
          output.role === "stage.mdinfo" ? { ...output, role: "stage.unknown" } : output,
        ),
      }),
    ).toThrow(/closed canonical role mapping/);
  });

  test("derives a command-free v2 operation authority from the exact render and environment", () => {
    const stage = signedStage();
    const executionBinding = executionBindingFor(stage);
    const rendered = renderCanonicalAmberStage(
      stage,
      signedMapping(unsignedMapping(stage, executionBinding)),
      executionBinding,
      canonicalAtomMap,
    );
    const authority = {
      workUnitId: "work-unit-production-1",
      bindingDigest: computeCanonicalMdExecutionBindingDigest(executionBinding),
      outputContractDigest: digestCanonical(stage.outputs),
    };
    const request = createAmberMdStageOperationRequest(rendered, environmentBinding, authority);
    expect(request.stage).toEqual({
      id: stage.id,
      revision: stage.revision,
      digest: stage.stageDigest,
      kind: stage.kind,
    });
    expect(request.environment.engine).toEqual(snapshot.engine);
    expect(request.environment.binaryDigest).toBe(snapshot.engine.buildDigest);
    expect(request.render.mdinDigest).toBe(rendered.renderedMdin.sha256);
    expect(request.outputs.bindings.map((binding) => binding.canonicalRole)).toEqual([
      "restart",
      "trajectory",
      "mdout",
      "mdinfo",
    ]);
    expect(JSON.stringify(request)).not.toMatch(/argv|logicalPath|shell/u);
    expect(
      assertAmberMdStageOperationRequest(request, rendered, environmentBinding, authority),
    ).toEqual(request);

    expect(() =>
      assertAmberMdStageOperationRequest(
        {
          ...request,
          render: { ...request.render, commandRequestDigest: digest("8") },
        },
        rendered,
        environmentBinding,
        authority,
      ),
    ).toThrow(/exact verified render/);
    expect(
      MdStageOperationRequestSchema.safeParse({
        ...request,
        schemaVersion: "eigengrid.md-stage-operation-request/v1",
      }).success,
    ).toBe(false);
    expect(
      MdStageOperationRequestSchema.safeParse({
        ...request,
        outputs: { ...request.outputs, bindings: request.outputs.bindings.slice(0, 3) },
      }).success,
    ).toBe(false);

    const otherSnapshotBase = { ...snapshotBase, id: "environment-2" };
    const otherSnapshot = {
      ...otherSnapshotBase,
      environmentDigest: computeCanonicalMdEnvironmentDigest(otherSnapshotBase),
    };
    const otherBinding = createAmberEnvironmentBinding(otherSnapshot, adapterEnvironment, "sander");
    expect(() => createAmberMdStageOperationRequest(rendered, otherBinding, authority)).toThrow(
      /another environment binding/,
    );
  });

  test("derives a lossless AMBER atom view bound to the manifest's canonical digest", () => {
    const view = deriveAmberAtomMapView(canonicalAtomMap, system.atomMapDigest);
    expect(canonicalEntriesFromAmberView(view)).toEqual(canonicalAtomMap.entries);
    expect(view.entries.map((entry) => entry.topologyIndex)).toEqual([1, 2]);
    expect(() => deriveAmberAtomMapView(canonicalAtomMap, digest("8"))).toThrow(
      /manifest identity/,
    );
    const stage = signedStage();
    const executionBinding = executionBindingFor(stage);
    expect(() =>
      renderCanonicalAmberStage(
        stage,
        signedMapping(unsignedMapping(stage, executionBinding)),
        executionBinding,
        {
          ...canonicalAtomMap,
          entries: canonicalAtomMap.entries.slice(0, 1),
        },
      ),
    ).toThrow();
  });

  test("rejects environment snapshot or binary drift before rendering", () => {
    const stage = signedStage();
    const executionBinding = executionBindingFor(stage);
    const base = unsignedMapping(stage, executionBinding);
    const drifted = {
      ...base,
      environment: {
        ...base.environment,
        canonicalSnapshot: {
          ...base.environment.canonicalSnapshot,
          engine: { ...base.environment.canonicalSnapshot.engine, version: "25" },
        },
      },
    };
    expect(() =>
      renderCanonicalAmberStage(stage, signedMapping(drifted), executionBinding, canonicalAtomMap),
    ).toThrow(/environment.*digest mismatch|build identity/i);
  });
});
