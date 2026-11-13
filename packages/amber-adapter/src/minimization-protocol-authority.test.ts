import { expect, test } from "bun:test";
import {
  assertAmberCanonicalStageMappingDigest,
  computeCanonicalMdExecutionBindingDigest,
  renderCanonicalAmberStage,
} from "./canonical-stage-mapper";
import {
  canonicalAtomMap,
  explicitMinimization,
  executionBindingFor,
  resignStage,
  signedMapping,
} from "./canonical-stage.fixture";

function fixture() {
  const old = explicitMinimization();
  const stage = resignStage({
    ...old.stage,
    sourceDecisionRefs: old.stage.sourceDecisionRefs.filter((id) => id !== "minimization-decision"),
  });
  const binding = executionBindingFor(stage);
  const parsed = assertAmberCanonicalStageMappingDigest(old.mapping);
  if (parsed.schemaVersion !== "eigengrid.amber-canonical-stage-mapping/v3")
    throw new Error("v3 fixture required");
  const { mappingDigest: _oldDigest, ...oldMapping } = parsed;
  const mapping = signedMapping({
    ...oldMapping,
    schemaVersion: "eigengrid.amber-canonical-stage-mapping/v4",
    mappingVersion: "4.0.0",
    canonicalStage: { ...oldMapping.canonicalStage, stageDigest: stage.stageDigest },
    canonicalWorkUnit: {
      ...oldMapping.canonicalWorkUnit,
      bindingDigest: computeCanonicalMdExecutionBindingDigest(binding),
    },
    minimizationSplit: {
      algorithm: stage.minimization.algorithm,
      steepestDescentCycles: stage.minimization.steepestDescentCycles,
      protocol: binding.protocol,
      stage: { id: stage.id, revision: stage.revision, digest: stage.stageDigest },
    },
  });
  const verified = assertAmberCanonicalStageMappingDigest(mapping);
  if (
    verified.schemaVersion !== "eigengrid.amber-canonical-stage-mapping/v4" ||
    !verified.minimizationSplit
  )
    throw new Error("v4 split fixture required");
  return {
    stage,
    binding,
    mapping: { ...verified, minimizationSplit: verified.minimizationSplit },
  };
}
test("v4 uses exact approved protocol and stage, without inventing a biomolecular split decision", () => {
  const f = fixture();
  const output = renderCanonicalAmberStage(f.stage, f.mapping, f.binding, canonicalAtomMap);
  expect(output.mapping.version).toBe("4.0.0");
  expect(output.renderedMdin.content).toContain("ncyc=80,");
  expect(f.stage.sourceDecisionRefs).not.toContain("minimization-decision");
  const legacy = explicitMinimization();
  expect(
    renderCanonicalAmberStage(legacy.stage, legacy.mapping, legacy.binding, canonicalAtomMap)
      .mapping.version,
  ).toBe("3.0.0");
});
test("v4 rejects altered stage, protocol approval, digest, revision and controls", () => {
  const f = fixture();
  for (const mapping of [
    {
      ...f.mapping,
      minimizationSplit: {
        ...f.mapping.minimizationSplit,
        protocol: { ...f.mapping.minimizationSplit.protocol, approvalRef: "other" },
      },
    },
    {
      ...f.mapping,
      minimizationSplit: {
        ...f.mapping.minimizationSplit,
        protocol: { ...f.mapping.minimizationSplit.protocol, digest: "a".repeat(64) },
      },
    },
    {
      ...f.mapping,
      minimizationSplit: {
        ...f.mapping.minimizationSplit,
        protocol: { ...f.mapping.minimizationSplit.protocol, revision: 2 },
      },
    },
    {
      ...f.mapping,
      minimizationSplit: {
        ...f.mapping.minimizationSplit,
        stage: { ...f.mapping.minimizationSplit.stage, id: "other" },
      },
    },
    {
      ...f.mapping,
      minimizationSplit: {
        ...f.mapping.minimizationSplit,
        stage: { ...f.mapping.minimizationSplit.stage, digest: "b".repeat(64) },
      },
    },
    {
      ...f.mapping,
      minimizationSplit: { ...f.mapping.minimizationSplit, steepestDescentCycles: 81 },
    },
  ]) {
    const { mappingDigest: _digest, ...unsigned } = mapping;
    expect(() =>
      renderCanonicalAmberStage(f.stage, signedMapping(unsigned), f.binding, canonicalAtomMap),
    ).toThrow();
  }
  for (const change of [
    { rmsGradientToleranceKcalMolAngstrom: 0.2 },
    { initialStepAngstrom: 0.1 },
    { steepestDescentCycles: 81 },
  ]) {
    const changed = resignStage({
      ...f.stage,
      minimization: { ...f.stage.minimization, ...change },
    });
    expect(() =>
      renderCanonicalAmberStage(changed, f.mapping, f.binding, canonicalAtomMap),
    ).toThrow();
  }
});

test("legacy and new schemas cannot be mixed or silently reinterpreted", () => {
  const f = fixture();
  const { mappingDigest: _digest, ...mapping } = f.mapping;
  expect(() =>
    assertAmberCanonicalStageMappingDigest(
      signedMapping({
        ...mapping,
        schemaVersion: "eigengrid.amber-canonical-stage-mapping/v3",
        mappingVersion: "3.0.0",
      }),
    ),
  ).toThrow();
  const legacy = assertAmberCanonicalStageMappingDigest(explicitMinimization().mapping);
  if (legacy.schemaVersion !== "eigengrid.amber-canonical-stage-mapping/v3")
    throw new Error("legacy required");
  const { mappingDigest: _legacyDigest, ...old } = legacy;
  expect(() =>
    assertAmberCanonicalStageMappingDigest(
      signedMapping({
        ...old,
        schemaVersion: "eigengrid.amber-canonical-stage-mapping/v4",
        mappingVersion: "4.0.0",
      }),
    ),
  ).toThrow();
});
