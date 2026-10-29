import { describe, expect, test } from "bun:test";
import {
  AtomMapSchemaVersion,
  MdProtocolSchemaVersion,
  MdStageSchemaVersion,
  computeAtomMapDigest,
  computeBiomolecularSystemManifestDigest,
  computeMdStageSpecDigest,
  computeMdRestraintSelectionDigest,
  digestCanonical,
  type AtomMap,
} from "@eigengrid/scientific-schema";
import {
  MdAdapterDescriptorVersion,
  MdAdapterDescriptorSchema,
  MdControlTupleSchema,
  computeMdAdapterDescriptorDigest,
  prepareMdRenderRequest,
  assertMdRenderRequest,
  mdControlTuple,
  type MdRenderRequestInput,
} from "./adapter-port";
import { makeInput } from "./md-fixtures";

function material(): MdRenderRequestInput {
  const source = makeInput();
  const system = source.system;
  const map: AtomMap = {
    schemaVersion: AtomMapSchemaVersion,
    id: "fixture-map",
    revision: 1,
    systemManifestId: system.id,
    systemManifestRevision: system.revision,
    indexBase: 1,
    atomCount: 5,
    topologyDigest: system.topologyDigest,
    coordinateDigest: system.coordinateDigest,
    mapDigest: "0".repeat(64),
    entries: Array.from({ length: 5 }, (_, i) => ({
      systemAtomIndex: i + 1,
      componentId: i < 2 ? "protein-1" : "water-1",
      componentAtomIndex: i < 2 ? i + 1 : i - 1,
      residueIndex: i < 2 ? 1 : 2,
      residueName: i < 2 ? "ALA" : "WAT",
      atomName: `C${i}`,
      element: "C",
    })),
  };
  map.mapDigest = computeAtomMapDigest(map);
  system.atomMapDigest = map.mapDigest;
  system.manifestDigest = computeBiomolecularSystemManifestDigest(system);
  const stage = source.protocol.stages[0]!;
  stage.system = {
    ...stage.system,
    manifestDigest: system.manifestDigest,
    atomMapDigest: map.mapDigest,
  };
  stage.stageDigest = computeMdStageSpecDigest(stage);
  const profile = {
    schemaVersion: MdAdapterDescriptorVersion,
    adapterId: "amber.fixture-renderer",
    adapterVersion: "1.0.0",
    engine: source.environment.engine,
    protocolSchemaVersion: MdProtocolSchemaVersion,
    stageSchemaVersion: MdStageSchemaVersion,
    rendererCompatibilityVersions: ["1.0.0"],
    controlTuples: [mdControlTuple(stage)],
    maximumAtomCount: 10,
    descriptorDigest: "0".repeat(64),
  };
  profile.descriptorDigest = computeMdAdapterDescriptorDigest(profile);
  return {
    stage,
    system,
    atomMap: map,
    descriptor: profile,
    expectedEngine: structuredClone(profile.engine),
  };
}

describe("pure, exact MD renderer port", () => {
  test("binds material and tuple without claiming execution or qualification", () => {
    const input = material(),
      before = structuredClone(input);
    const first = prepareMdRenderRequest(input),
      second = prepareMdRenderRequest(structuredClone(input));
    expect(first).toEqual(second);
    expect(input).toEqual(before);
    expect(first.qualification).toBe("render_only_not_authorized");
    expect(first.requestDigest).toBe(digestCanonical({ ...first, requestDigest: undefined }));
    first.stage.temperature!.points[0]!.kelvin = 2;
    expect(input).toEqual(before);
  });
  test("revalidates wire requests against the registered adapter before translation", () => {
    const input = material();
    const request = prepareMdRenderRequest(input);
    expect(assertMdRenderRequest(JSON.parse(JSON.stringify(request)), input.descriptor)).toEqual(
      request,
    );
    const other = structuredClone(input.descriptor);
    other.adapterVersion = "2.0.0";
    other.descriptorDigest = computeMdAdapterDescriptorDigest(other);
    expect(() => assertMdRenderRequest(request, other)).toThrow(
      expect.objectContaining({ code: "ENGINE_MISMATCH" }),
    );
    for (const field of ["requestDigest", "controlTupleDigest"] as const) {
      const altered = { ...structuredClone(request), [field]: "f".repeat(64) };
      expect(() => assertMdRenderRequest(altered, input.descriptor)).toThrow(
        expect.objectContaining({ code: "REQUEST_DIGEST_MISMATCH" }),
      );
    }
    for (const patch of [
      { qualification: "production_qualified" },
      { schemaVersion: "unknown/v2" },
      { shell: "sbatch" },
    ]) {
      expect(() => assertMdRenderRequest({ ...request, ...patch }, input.descriptor)).toThrow(
        expect.objectContaining({ code: "INVALID_RENDER_INPUT" }),
      );
    }
    request.stage.steps++;
    expect(() => assertMdRenderRequest(request, input.descriptor)).toThrow();
  });
  test.each(["build", "environment", "engine", "executable"])(
    "does not swap the expected %s",
    (field) => {
      const input = material();
      if (field === "build") input.expectedEngine.buildDigest = "9".repeat(64);
      if (field === "environment") input.expectedEngine.environmentDigest = "9".repeat(64);
      if (field === "engine") input.expectedEngine.engine = "gromacs";
      if (field === "executable") input.expectedEngine.executable = "another-engine";
      expect(() => prepareMdRenderRequest(input)).toThrow(
        expect.objectContaining({ code: "ENGINE_MISMATCH" }),
      );
    },
  );
  test("rejects tampered descriptor, unknown controls and raw commands", () => {
    const input = material();
    input.descriptor.maximumAtomCount++;
    expect(() => prepareMdRenderRequest(input)).toThrow(
      expect.objectContaining({ code: "DESCRIPTOR_DIGEST_MISMATCH" }),
    );
    expect(
      MdAdapterDescriptorSchema.safeParse({ ...input.descriptor, argv: ["sbatch"] }).success,
    ).toBe(false);
    expect(
      MdControlTupleSchema.safeParse({ ...input.descriptor.controlTuples[0], rawKeyword: 1 })
        .success,
    ).toBe(false);
    input.descriptor.engine.executable = "/path/to/pmemd";
    expect(() => prepareMdRenderRequest(input)).toThrow();
  });
  test("does not infer an unlisted control combination or renderer version", () => {
    for (const field of ["time", "renderer", "count"] as const) {
      const input = material();
      if (field === "time") {
        input.stage.timeStepPs = 0.001;
        input.stage.simulatedTimePs = 1;
        input.stage.stageDigest = computeMdStageSpecDigest(input.stage);
      }
      if (field === "renderer") {
        input.stage.rendererCompatibilityVersion = "2.0.0";
        input.stage.stageDigest = computeMdStageSpecDigest(input.stage);
      }
      if (field === "count") {
        input.descriptor.maximumAtomCount = 2;
        input.descriptor.descriptorDigest = computeMdAdapterDescriptorDigest(input.descriptor);
      }
      expect(() => prepareMdRenderRequest(input)).toThrow(
        expect.objectContaining({ code: "UNSUPPORTED_CONTROLS" }),
      );
    }
  });
  test("rejects ambiguous or foreign atom mapping even when rehashed", () => {
    const input = material();
    input.atomMap.entries[1]!.systemAtomIndex = 1;
    input.atomMap.mapDigest = computeAtomMapDigest(input.atomMap);
    expect(() => prepareMdRenderRequest(input)).toThrow();
    const other = material();
    other.atomMap.systemManifestId = "foreign";
    other.atomMap.mapDigest = computeAtomMapDigest(other.atomMap);
    expect(() => prepareMdRenderRequest(other)).toThrow();
  });
  test("rejects rehashed component substitution in the same topology", () => {
    const input = material();
    input.atomMap.entries[0]!.componentId = "unknown-protein";
    input.atomMap.entries[1]!.componentId = "unknown-protein";
    input.atomMap.mapDigest = computeAtomMapDigest(input.atomMap);
    input.system.atomMapDigest = input.atomMap.mapDigest;
    input.system.manifestDigest = computeBiomolecularSystemManifestDigest(input.system);
    input.stage.system.atomMapDigest = input.atomMap.mapDigest;
    input.stage.system.manifestDigest = input.system.manifestDigest;
    input.stage.stageDigest = computeMdStageSpecDigest(input.stage);
    expect(() => prepareMdRenderRequest(input)).toThrow(
      expect.objectContaining({ code: "MATERIAL_MISMATCH" }),
    );
  });
  test("requires resolved and in-range atom selections for rendering", () => {
    for (const indices of [undefined, [6], [1]]) {
      const input = material();
      input.stage.restraints = [
        {
          id: "r",
          kind: "positional",
          sourceDecisionId: "construct-decision-1",
          schedule: [{ step: 0, forceConstant: 1 }],
          selections: [
            {
              id: "selection",
              atomCount: 1,
              description: "fixture",
              atomIndices: indices,
              definitionDigest: indices
                ? computeMdRestraintSelectionDigest(input.atomMap.mapDigest, indices)
                : "0".repeat(64),
            },
          ],
        },
      ];
      input.stage.stageDigest = computeMdStageSpecDigest(input.stage);
      input.descriptor.controlTuples = [mdControlTuple(input.stage)];
      input.descriptor.descriptorDigest = computeMdAdapterDescriptorDigest(input.descriptor);
      if (!indices || indices[0] === 6)
        expect(() => prepareMdRenderRequest(input)).toThrow(
          expect.objectContaining({ code: "UNRESOLVED_SELECTION" }),
        );
      else expect(prepareMdRenderRequest(input).stage.restraints).toHaveLength(1);
    }
  });
});
