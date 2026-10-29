import { describe, expect, test } from "bun:test";
import { sealContract, type SpeciesContract } from "@eigengrid/colony-contracts";
import { ZERO_DIGEST } from "../../colony-contracts/src/test-fixtures";
import { SpeciesRegistry, SpeciesRegistryError } from "./species-registry";
import { CampaignDefinitionShapeSchema, parseCampaignDefinition } from "./state";
import {
  campaignDefinition,
  colonyBudget,
  speciesContract,
  speciesIdentity,
  workOrder,
  workUnit,
} from "./runtime-test-fixtures";

describe("species registry", () => {
  test("binds an accepted exact contract and treats same-digest registration as idempotent", () => {
    const contract = speciesContract();
    const registry = new SpeciesRegistry();
    expect(registry.register(contract).duplicate).toBe(false);
    expect(registry.register(contract).duplicate).toBe(true);
    expect(registry.resolve(speciesIdentity(contract))).toEqual(contract);
  });

  test("rejects merged IDs and routes external profiles away from the native runtime", () => {
    const base = speciesContract();
    const merged = sealContract({
      ...base,
      identity: { id: "eigengrid.scientific-critic/v1", version: "1.0.0" },
      contractDigest: ZERO_DIGEST,
    }) as SpeciesContract;
    expect(() => new SpeciesRegistry([merged])).toThrow(SpeciesRegistryError);

    const external = sealContract({
      ...base,
      identity: { id: "eigengrid.slurm-incident/v1", version: "1.0.0" },
      contractDigest: ZERO_DIGEST,
    }) as SpeciesContract;
    const registry = new SpeciesRegistry([external]);
    expect(() => registry.assertAdmissible(speciesIdentity(external), "shadow")).toThrow(
      /external Myrmex profile/,
    );
  });

  test("requires qualified promotion for qualified execution while permitting unqualified shadow", () => {
    const unqualified = speciesContract("unqualified");
    expect(
      new SpeciesRegistry([unqualified]).assertAdmissible(speciesIdentity(unqualified), "shadow"),
    ).toEqual(unqualified);
    expect(() =>
      new SpeciesRegistry([unqualified]).assertAdmissible(
        speciesIdentity(unqualified),
        "qualified",
      ),
    ).toThrow(/not admissible/);

    const qualified = speciesContract("qualified");
    expect(
      new SpeciesRegistry([qualified]).assertAdmissible(speciesIdentity(qualified), "qualified"),
    ).toEqual(qualified);
  });
});

describe("finite campaign definition", () => {
  test("seals and verifies one exact species/base-bound finite DAG", () => {
    const definition = campaignDefinition(speciesContract());
    expect(parseCampaignDefinition(definition)).toEqual(definition);
    expect(() => parseCampaignDefinition({ ...definition, objective: "tampered" })).toThrow(
      /digest mismatch/,
    );
  });

  test("rejects cyclic DAGs and unordered competing writers", () => {
    const contract = speciesContract();
    const first = workUnit(workOrder(contract, "1"), "unit-1", ["unit-2"]);
    const second = workUnit(workOrder(contract, "2"), "unit-2", ["unit-1"]);
    const valid = campaignDefinition(contract);
    expect(
      CampaignDefinitionShapeSchema.safeParse({
        ...valid,
        budget: colonyBudget({
          modelCalls: 12,
          inputTokens: 24_000,
          outputTokens: 12_000,
          costMicrounits: 1_500_000,
          wallTimeMs: 360_000,
          corrections: 6,
          frontierCalls: 2,
        }),
        workUnits: [first, second],
      }).success,
    ).toBe(false);

    const left = { ...first, dependencies: [], ownershipKey: "candidate:shared" };
    const right = { ...second, dependencies: [], ownershipKey: "candidate:shared" };
    expect(
      CampaignDefinitionShapeSchema.safeParse({
        ...valid,
        budget: colonyBudget({
          modelCalls: 12,
          inputTokens: 24_000,
          outputTokens: 12_000,
          costMicrounits: 1_500_000,
          wallTimeMs: 360_000,
          corrections: 6,
          frontierCalls: 2,
        }),
        maximumParallelism: 2,
        workUnits: [left, right],
      }).success,
    ).toBe(false);
  });

  test("rejects child allocations that exceed the campaign budget", () => {
    const definition = campaignDefinition(speciesContract());
    expect(
      CampaignDefinitionShapeSchema.safeParse({
        ...definition,
        budget: { ...definition.budget, modelCalls: definition.budget.modelCalls - 1 },
      }).success,
    ).toBe(false);
  });
});
