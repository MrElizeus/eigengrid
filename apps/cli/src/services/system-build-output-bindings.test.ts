import { expect, test } from "bun:test";
import { assertSystemBuildOutputBindings } from "./amber-material-publication";

const roles = ["topology", "coordinates", "atomMap"] as const;
const artifacts = {
  topology: { evidenceRef: "prepared-topology", mediaType: "application/vnd.amber.prmtop" },
  coordinates: { evidenceRef: "prepared-coordinates", mediaType: "application/vnd.amber.rst7" },
  atomMap: { evidenceRef: "prepared-map", mediaType: "application/vnd.eigengrid.atom-map+json" },
};
test("requires each approved output to be the exact frozen artifact identity and media type", () => {
  const outputs = structuredClone(artifacts);
  expect(() => assertSystemBuildOutputBindings({ outputs, artifacts } as never)).not.toThrow();
  for (const role of roles) {
    const wrongId = structuredClone(outputs);
    wrongId[role].evidenceRef = "different";
    expect(() =>
      assertSystemBuildOutputBindings({ outputs: wrongId, artifacts } as never),
    ).toThrow();
    const wrongType = structuredClone(outputs);
    wrongType[role].mediaType = "application/octet-stream";
    expect(() =>
      assertSystemBuildOutputBindings({ outputs: wrongType, artifacts } as never),
    ).toThrow();
  }
});

test("source bindings require exact system and component refs with immutable same-mission digests", async () => {
  const { assertSystemBuildSourceBindings } = await import("./amber-material-publication");
  const hash = "a".repeat(64);
  const entry = (id: string) => ({
    id,
    missionId: "mission",
    immutable: true,
    contentDigest: hash,
    uri: `cas://sha256/${hash}`,
  });
  const draft = {
    system: {
      missionId: "mission",
      sourceEvidenceRefs: ["draft", "manifest"],
      components: { proteins: [{ sourceEvidenceRefs: ["peptide"] }], waters: [] },
    },
  };
  const request = {
    sourceEvidence: ["draft", "manifest", "peptide"].map((id) => ({ id, contentDigest: hash })),
  };
  const evidence = request.sourceEvidence.map(({ id }) => entry(id));
  expect(() =>
    assertSystemBuildSourceBindings({ draft, request, evidence } as never),
  ).not.toThrow();
  expect(() =>
    assertSystemBuildSourceBindings({
      draft,
      request: { sourceEvidence: request.sourceEvidence.slice(1) },
      evidence,
    } as never),
  ).toThrow();
  expect(() =>
    assertSystemBuildSourceBindings({
      draft,
      request,
      evidence: evidence.map((e) => (e.id === "peptide" ? { ...e, missionId: "other" } : e)),
    } as never),
  ).toThrow();
  expect(() =>
    assertSystemBuildSourceBindings({
      draft,
      request,
      evidence: evidence.map((e) =>
        e.id === "peptide" ? { ...e, contentDigest: "b".repeat(64) } : e,
      ),
    } as never),
  ).toThrow();
});

test("output IDs reject cross-mission collisions and duplicate receipt authority", async () => {
  const { assertSystemBuildOutputAvailability } = await import("./amber-material-publication");
  const hash = "a".repeat(64);
  const artifact = (evidenceRef: string, mediaType: string) => ({
    evidenceRef,
    mediaType,
    sha256: hash,
    sizeBytes: 1,
  });
  const material = {
    topology: artifact("top", "application/vnd.amber.prmtop"),
    coordinates: artifact("crd", "application/vnd.amber.rst7"),
    atomMap: artifact("map", "application/vnd.eigengrid.atom-map+json"),
    snapshotPdb: artifact("pdb", "chemical/x-pdb"),
    qcReport: artifact("qc", "application/json"),
  };
  const evidence = {
    id: "top",
    missionId: "mission",
    workUnitId: "unit",
    sourceId: "receipt",
    immutable: true,
    kind: "topology",
    mediaType: material.topology.mediaType,
    contentDigest: hash,
    sizeBytes: 1,
    uri: `cas://sha256/${hash}`,
  };
  const base = {
    missionId: "mission",
    workUnitId: "unit",
    receiptId: "receipt",
    artifacts: material,
    evidence: [evidence],
  };
  expect(() => assertSystemBuildOutputAvailability(base as never)).not.toThrow();
  expect(() =>
    assertSystemBuildOutputAvailability({
      ...base,
      evidence: [{ ...evidence, missionId: "other" }],
    } as never),
  ).toThrow();
  expect(() =>
    assertSystemBuildOutputAvailability({
      ...base,
      evidence: [{ ...evidence, id: "other-id" }],
    } as never),
  ).toThrow();
});
