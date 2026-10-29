import { describe, expect, test } from "bun:test";
import {
  EvidenceReferenceSchema,
  WorkUnitSchema,
  digestCanonical,
  type EvidenceReference,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import {
  createBiomolecularSystemBuildRequest,
  systemPreparationEffectIdentity,
} from "./system-preparation-binding";

const T0 = "2026-09-30T00:00:00.000Z";
const T1 = "2026-09-30T01:00:00.000Z";
const D = (character: string): string => character.repeat(64);
const sourceFragment = {
  skillId: "biomolecular.system-provenance",
  version: "1.0.0",
  contentDigest: D("8"),
  fragmentId: "system.prepare",
  fragmentDigest: D("9"),
  relativePath: "biomolecular/system-prepare.yaml",
  selector: "$",
};

const buildBinding = {
  schemaVersion: "eigengrid.biomolecular-system-build-work-unit-binding/v1" as const,
  primaryInputEvidenceId: "evidence-receptor",
  sourceEvidenceRefs: ["evidence-receptor", "evidence-ligand", "evidence-membrane"],
  forceFieldStackEvidenceRef: "evidence-force-field-stack",
  decisionRefs: [
    {
      id: "decision-microstate",
      revision: 2,
      kind: "microstate" as const,
      decisionDigest: D("a"),
      approvalRef: "approval-microstate",
    },
    {
      id: "decision-membrane",
      revision: 1,
      kind: "membrane_model" as const,
      decisionDigest: D("b"),
      approvalRef: "approval-membrane",
    },
  ],
  forceFieldStack: { id: "force-field-ligand", revision: 1, digest: D("c") },
  outputArtifacts: {
    topology: {
      evidenceRef: "evidence-prepared-topology",
      mediaType: "application/vnd.amber.prmtop" as const,
    },
    coordinates: {
      evidenceRef: "evidence-prepared-coordinates",
      mediaType: "application/vnd.amber.rst7" as const,
    },
    atomMap: {
      evidenceRef: "evidence-prepared-atom-map",
      mediaType: "application/vnd.eigengrid.atom-map+json" as const,
    },
  },
};

function workUnit(overrides: Record<string, unknown> = {}): WorkUnit {
  return WorkUnitSchema.parse({
    id: "work-fixture-system-build",
    missionId: "mission-ligand",
    planId: "plan-ligand",
    planVersion: 1,
    kind: "scientific_capability",
    state: "claimed",
    reason: "Prepare one approved synthetic membrane system",
    dependencies: [],
    inputRefs: [
      "evidence-receptor",
      "evidence-ligand",
      "evidence-membrane",
      "evidence-force-field-stack",
    ],
    outputContract: {
      requiredEvidenceKinds: ["topology", "coordinates", "atom_map"],
      requiredObservationKinds: ["artifact_integrity", "topology_integrity"],
    },
    skillRefs: [sourceFragment],
    protocolFragment: {
      schemaVersion: "eigengrid.scientific-capability-fragment/v1",
      id: "fragment-fixture-system-build",
      kind: "scientific_capability",
      capability: {
        id: "biomolecular.build-system",
        version: "1.0.0",
        contractDigest: D("d"),
      },
      reason: "Assemble the reviewed receptor, ligand and membrane inputs",
      parameters: {
        manifestId: "system-ligand",
        manifestRevision: 1,
        manifestDigest: D("e"),
        systemBuild: buildBinding,
      },
      sourceFragments: [sourceFragment],
      riskClass: 3,
    },
    retryPolicy: { maximumAttempts: 1, ambiguityRequiresReconciliation: true },
    approvalPolicy: { required: true, minimumRole: "scientific-reviewer" },
    executionPolicy: { capability: "biomolecular.build-system", riskClass: 3 },
    revision: 2,
    claimOwner: "head-ligand",
    claimExpiresAt: T1,
    jobId: null,
    attemptId: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });
}

function evidence(id: string, kind: EvidenceReference["kind"], digest: string): EvidenceReference {
  return EvidenceReferenceSchema.parse({
    id,
    missionId: "mission-ligand",
    kind,
    uri: `cas://sha256/${digest}`,
    contentDigest: digest,
    immutable: true,
    sourceId: "source-review",
    createdAt: T0,
  });
}

function inputs(): EvidenceReference[] {
  return [
    evidence("evidence-receptor", "structure", D("1")),
    evidence("evidence-ligand", "artifact", D("2")),
    evidence("evidence-membrane", "artifact", D("3")),
    evidence("evidence-force-field-stack", "force_field_stack", D("c")),
  ];
}

function approvedDecisions() {
  return buildBinding.decisionRefs.map((reference) => ({
    ...reference,
    missionId: "mission-ligand",
    status: "approved" as const,
  }));
}

describe("Amber system-preparation request binding", () => {
  test("builds one deterministic v2 request from exact immutable mission inputs", () => {
    const unit = workUnit();
    const request = createBiomolecularSystemBuildRequest({
      workUnit: unit,
      evidence: inputs(),
      decisions: approvedDecisions(),
    });
    const identity = systemPreparationEffectIdentity(unit);

    expect(request.schemaVersion).toBe("eigengrid.biomolecular-system-build-request/v2");
    expect(request.missionId).toBe(unit.missionId);
    expect(request.planId).toBe(unit.planId);
    expect(request.intendedJobId).toBe(identity.jobId);
    expect(request.intendedAttemptId).toBe(identity.attemptId);
    expect(request.inputEvidenceId).toBe("evidence-receptor");
    expect(request.sourceEvidence).toEqual([
      { id: "evidence-ligand", contentDigest: D("2") },
      { id: "evidence-membrane", contentDigest: D("3") },
      { id: "evidence-receptor", contentDigest: D("1") },
    ]);
    expect(request.outputArtifacts.topology.evidenceRef).toBe("evidence-prepared-topology");
    expect(request.parametersDigest).toBe(digestCanonical(unit.protocolFragment.parameters));
    expect(JSON.stringify(request)).not.toMatch(/executable|argv|shell|filesystemPath/iu);
    expect(systemPreparationEffectIdentity(unit)).toEqual(identity);
  });

  test("rejects mutable, cross-mission, missing, or digest-mismatched inputs", () => {
    const unit = workUnit();
    const mutable = inputs().map((item) =>
      item.id === "evidence-ligand" ? { ...item, immutable: false } : item,
    );
    expect(() =>
      createBiomolecularSystemBuildRequest({
        workUnit: unit,
        evidence: mutable,
        decisions: approvedDecisions(),
      }),
    ).toThrow(/immutable evidence/u);

    const crossMission = inputs().map((item) =>
      item.id === "evidence-receptor" ? { ...item, missionId: "mission-other" } : item,
    );
    expect(() =>
      createBiomolecularSystemBuildRequest({
        workUnit: unit,
        evidence: crossMission,
        decisions: approvedDecisions(),
      }),
    ).toThrow(/this mission/u);

    const wrongStackDigest = inputs().map((item) =>
      item.id === "evidence-force-field-stack" ? { ...item, contentDigest: D("f") } : item,
    );
    expect(() =>
      createBiomolecularSystemBuildRequest({
        workUnit: unit,
        evidence: wrongStackDigest,
        decisions: approvedDecisions(),
      }),
    ).toThrow(/stack evidence digest/u);
  });

  test("rejects extra WorkUnit inputs, missing outputs, and identity drift", () => {
    const unit = workUnit({ inputRefs: [...workUnit().inputRefs, "unbound-input"] });
    expect(() =>
      createBiomolecularSystemBuildRequest({
        workUnit: unit,
        evidence: inputs(),
        decisions: approvedDecisions(),
      }),
    ).toThrow(/exactly its source and force-field evidence/u);

    const missingOutput = workUnit({
      outputContract: {
        requiredEvidenceKinds: ["topology", "coordinates"],
        requiredObservationKinds: ["artifact_integrity", "topology_integrity"],
      },
    });
    expect(() =>
      createBiomolecularSystemBuildRequest({
        workUnit: missingOutput,
        evidence: inputs(),
        decisions: approvedDecisions(),
      }),
    ).toThrow(/missing atom_map evidence/u);

    const missingQc = workUnit({
      outputContract: {
        requiredEvidenceKinds: ["topology", "coordinates", "atom_map"],
        requiredObservationKinds: ["artifact_integrity"],
      },
    });
    expect(() =>
      createBiomolecularSystemBuildRequest({
        workUnit: missingQc,
        evidence: inputs(),
        decisions: approvedDecisions(),
      }),
    ).toThrow(/missing topology_integrity QC observation/u);

    const pending = approvedDecisions().map((decision) =>
      decision.id === "decision-microstate"
        ? { ...decision, status: "proposed" as const }
        : decision,
    );
    expect(() =>
      createBiomolecularSystemBuildRequest({
        workUnit: workUnit(),
        evidence: inputs(),
        decisions: pending,
      }),
    ).toThrow(/durably approved/u);

    expect(() =>
      createBiomolecularSystemBuildRequest({
        workUnit: workUnit(),
        evidence: inputs(),
        decisions: approvedDecisions().filter((decision) => decision.id !== "decision-microstate"),
      }),
    ).toThrow(/differ from the exact approved revisions/u);

    const identity = systemPreparationEffectIdentity(workUnit());
    const drift = workUnit({ jobId: "job-other", attemptId: identity.attemptId });
    expect(() => systemPreparationEffectIdentity(drift)).toThrow(
      /conflicting durable job identity/u,
    );
  });
});
