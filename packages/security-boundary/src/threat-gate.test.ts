import { describe, expect, test } from "bun:test";
import { authorizeSecurityInvocation } from "./authorization";
import {
  EG031_CONTRACT_THREAT_IDS,
  EG031_EXTERNAL_THREAT_IDS,
  EG031_THREAT_COVERAGE,
  runEg031AdversarialGate,
} from "./threat-gate";
import { validSecurityScenario } from "./test-fixtures";

describe("Stable adversarial gate", () => {
  test("denies every contract-level boundary escape with complete threat coverage", () => {
    const report = runEg031AdversarialGate(validSecurityScenario());
    expect(report.verdict).toBe("CONTRACT_PASS");
    expect(report.maturity).toBe("CONTRACT_VERIFIED");
    expect(report.productionEligible).toBe(false);
    expect(report.results).toHaveLength(EG031_CONTRACT_THREAT_IDS.length);
    expect(report.results.every(({ passed }) => passed)).toBe(true);
    expect(new Set(report.results.map(({ threatId }) => threatId))).toEqual(
      new Set(EG031_CONTRACT_THREAT_IDS),
    );
  });

  test("keeps runtime isolation threats external rather than laundering them into a unit pass", () => {
    const report = runEg031AdversarialGate(validSecurityScenario());
    expect(report.externalThreats).toEqual(EG031_EXTERNAL_THREAT_IDS);
    for (const threatId of EG031_EXTERNAL_THREAT_IDS) {
      expect(EG031_THREAT_COVERAGE.find((entry) => entry.threatId === threatId)).toMatchObject({
        evidence: "external_host_required",
      });
    }
  });

  test("has exactly one declared coverage owner for every stable threat", () => {
    const ids = EG031_THREAT_COVERAGE.map(({ threatId }) => threatId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(
      new Set([...EG031_CONTRACT_THREAT_IDS, ...EG031_EXTERNAL_THREAT_IDS]),
    );
  });

  test("refuses to run a negative corpus against an already-denied baseline", () => {
    const scenario = validSecurityScenario();
    scenario.request = { ...(scenario.request as object), capability: "admin.shell" };
    expect(authorizeSecurityInvocation(scenario).verdict).toBe("deny");
    expect(() => runEg031AdversarialGate(scenario)).toThrow("baseline must be allowed");
  });

  test("never places adversarial secret material in the gate report", () => {
    const serialized = JSON.stringify(runEg031AdversarialGate(validSecurityScenario()));
    expect(serialized).not.toContain("secretmaterial");
    expect(serialized).not.toContain("OPENAI_API_KEY");
  });
});
