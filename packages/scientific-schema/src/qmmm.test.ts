import { describe, expect, test } from "bun:test";

import {
  QmmmProtocolSchema,
  QmmmProtocolSchemaVersion,
  QmmmRegionSelectionSchema,
  QmmmRegionSelectionSchemaVersion,
  assertQmmmProtocolDigest,
  computeQmmmProtocolDigest,
  computeQmmmRegionSelectionDigest,
  type QmmmDecisionCategory,
  type QmmmDecisionReference,
} from "./index";

const digest = (character: string) => character.repeat(64);
const system = {
  id: "system-water",
  revision: 3,
  systemClass: "soluble" as const,
  manifestDigest: digest("a"),
  topologyDigest: digest("b"),
  coordinateDigest: digest("c"),
  atomMapDigest: digest("d"),
};

function decision(category: QmmmDecisionCategory): QmmmDecisionReference {
  return {
    id: `decision-${category}`,
    revision: 1,
    category,
    decisionDigest: digest(
      (
        {
          region: "1",
          charge_spin: "2",
          theory: "3",
          embedding: "4",
          boundary: "5",
          convergence: "6",
        } as const
      )[category],
    ),
    approvalRef: `approval-${category}`,
  };
}

function region() {
  const base = {
    schemaVersion: QmmmRegionSelectionSchemaVersion,
    id: "qmmm-region-water",
    revision: 1,
    system,
    atomMap: {
      id: "atom-map-water",
      revision: 2,
      digest: system.atomMapDigest,
      atomCount: 3,
      indexBase: 1 as const,
    },
    selectionClass: "all_qm_engine_check" as const,
    atomIndices: [1, 2, 3],
    sourceEvidenceRefs: ["evidence-region-review"],
    decision: decision("region"),
  };
  return { ...base, selectionDigest: computeQmmmRegionSelectionDigest(base) };
}

function protocol() {
  const regionValue = region();
  const decisions = (
    ["region", "charge_spin", "theory", "embedding", "boundary", "convergence"] as const
  ).map(decision);
  const base = {
    schemaVersion: QmmmProtocolSchemaVersion,
    id: "qmmm-protocol-water-pm3",
    missionId: "mission-qmmm-water",
    revision: 1,
    status: "draft" as const,
    system,
    parentMdProtocol: { id: "md-protocol-water", revision: 2, digest: digest("e") },
    appliedStageIds: ["stage-qmmm-minimization"],
    region: regionValue,
    electronicState: {
      qmCharge: 0,
      spinMultiplicity: 1,
      decision: decision("charge_spin"),
    },
    theory: {
      provider: "amber-sqm" as const,
      theory: "PM3",
      qualificationEvidenceRef: "ambertools-26-pm3-water-smoke",
      decision: decision("theory"),
    },
    embedding: {
      mode: "electrostatic" as const,
      cutoffAngstrom: 999,
      longRangeTreatment: "direct_cutoff" as const,
      decision: decision("embedding"),
    },
    boundary: {
      mode: "no_covalent_boundary" as const,
      covalentBonds: [],
      decision: decision("boundary"),
    },
    convergence: {
      maximumScfIterations: 1000,
      scfConvergenceTolerance: 1e-8,
      failureDisposition: "stop_and_escalate" as const,
      automaticScientificCorrectionAttempts: 0 as const,
      escalationConditions: [
        "SCF does not converge under the exact approved protocol",
        "material charge, spin, region, theory, embedding, or boundary change is proposed",
      ],
      decision: decision("convergence"),
    },
    decisionRefs: decisions,
    rendererCompatibilityVersion: "1.0.0",
    assumptions: ["This tiny water fixture is execution evidence, not biomolecular validation"],
    limitations: ["PM3 water smoke only; no production or transferable accuracy claim"],
    createdAt: "2026-08-30T12:00:00.000Z",
    updatedAt: "2026-08-30T12:00:00.000Z",
  };
  return { ...base, protocolDigest: computeQmmmProtocolDigest(base) };
}

describe("QM/MM scientific authority contracts", () => {
  test("binds a reviewed region, scientific controls, exact MD stages, and stable approval digest", () => {
    const draft = protocol();
    expect(QmmmRegionSelectionSchema.parse(draft.region).atomIndices).toEqual([1, 2, 3]);
    expect(assertQmmmProtocolDigest(draft)).toEqual(draft);

    const approved = {
      ...draft,
      status: "approved" as const,
      approvedByRef: "approval-qmmm-protocol-water-pm3",
      updatedAt: "2026-08-30T13:00:00.000Z",
    };
    expect(computeQmmmProtocolDigest(approved)).toBe(draft.protocolDigest);
    expect(assertQmmmProtocolDigest(approved).status).toBe("approved");
  });

  test("rejects stale atom maps, unordered/out-of-range atoms, and an unapproved region category", () => {
    const value = region();
    expect(
      QmmmRegionSelectionSchema.safeParse({
        ...value,
        atomMap: { ...value.atomMap, digest: digest("f") },
      }).success,
    ).toBe(false);
    expect(QmmmRegionSelectionSchema.safeParse({ ...value, atomIndices: [1, 1, 4] }).success).toBe(
      false,
    );
    expect(
      QmmmRegionSelectionSchema.safeParse({
        ...value,
        decision: decision("theory"),
      }).success,
    ).toBe(false);
  });

  test("rejects boundary bonds that do not cross from the approved QM region into MM", () => {
    const value = protocol();
    const withBoundary = {
      ...value,
      region: {
        ...value.region,
        selectionClass: "hybrid_qm_mm" as const,
        atomIndices: [1],
        selectionDigest: computeQmmmRegionSelectionDigest({
          ...value.region,
          selectionClass: "hybrid_qm_mm",
          atomIndices: [1],
          selectionDigest: undefined,
        }),
      },
      boundary: {
        mode: "engine_managed_link_atoms" as const,
        engineFamily: "amber" as const,
        method: "amber-qmmm-default" as const,
        covalentBonds: [{ qmAtomIndex: 1, mmAtomIndex: 2, evidenceRef: "bond-evidence" }],
        qualificationEvidenceRef: "amber-link-atom-evidence",
        decision: decision("boundary"),
      },
    };
    const rebound = { ...withBoundary, protocolDigest: computeQmmmProtocolDigest(withBoundary) };
    expect(QmmmProtocolSchema.safeParse(rebound).success).toBe(true);

    expect(
      QmmmProtocolSchema.safeParse({
        ...rebound,
        boundary: {
          ...rebound.boundary,
          covalentBonds: [{ qmAtomIndex: 2, mmAtomIndex: 1, evidenceRef: "bond-evidence" }],
        },
      }).success,
    ).toBe(false);
  });

  test("distinguishes an all-QM module check from a true hybrid QM/MM region", () => {
    const allQm = region();
    expect(QmmmRegionSelectionSchema.parse(allQm).selectionClass).toBe("all_qm_engine_check");
    expect(
      QmmmRegionSelectionSchema.safeParse({
        ...allQm,
        selectionClass: "hybrid_qm_mm",
        selectionDigest: computeQmmmRegionSelectionDigest({
          ...allQm,
          selectionClass: "hybrid_qm_mm",
          selectionDigest: undefined,
        }),
      }).success,
    ).toBe(false);
    expect(
      QmmmRegionSelectionSchema.safeParse({
        ...allQm,
        selectionClass: "all_qm_engine_check",
        atomIndices: [1, 2],
        selectionDigest: computeQmmmRegionSelectionDigest({
          ...allQm,
          atomIndices: [1, 2],
          selectionDigest: undefined,
        }),
      }).success,
    ).toBe(false);
  });

  test("requires all six exact decisions, unique target stages, approval binding, and no autonomous corrections", () => {
    const value = protocol();
    expect(
      QmmmProtocolSchema.safeParse({
        ...value,
        decisionRefs: value.decisionRefs.map((item) =>
          item.category === "boundary" ? decision("region") : item,
        ),
      }).success,
    ).toBe(false);
    expect(
      QmmmProtocolSchema.safeParse({
        ...value,
        electronicState: {
          ...value.electronicState,
          decision: { ...value.electronicState.decision, decisionDigest: digest("f") },
        },
      }).success,
    ).toBe(false);
    expect(
      QmmmProtocolSchema.safeParse({
        ...value,
        appliedStageIds: ["stage-qmmm-minimization", "stage-qmmm-minimization"],
      }).success,
    ).toBe(false);
    expect(QmmmProtocolSchema.safeParse({ ...value, status: "approved" }).success).toBe(false);
    expect(
      QmmmProtocolSchema.safeParse({
        ...value,
        convergence: { ...value.convergence, automaticScientificCorrectionAttempts: 1 },
      }).success,
    ).toBe(false);
  });
});
