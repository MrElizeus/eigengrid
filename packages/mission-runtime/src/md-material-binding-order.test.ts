import { expect, test } from "bun:test";
import { BiomolecularMaterialPublicationBindingSchema } from "@eigengrid/scientific-schema";
import { materialBindingMatches } from "./md-store-context";

const binding = BiomolecularMaterialPublicationBindingSchema.parse({
  schemaVersion: "eigengrid.biomolecular-material-publication-binding/v1",
  subjectKind: "force_field_stack",
  subject: { id: "stack", revision: 1, digest: "a".repeat(64) },
  sourceEvidenceRefs: ["a", "b", "c"],
  artifactEvidenceRef: "output",
});

test("force-field evidence order is immaterial but changed, missing or duplicate sources are rejected", () => {
  expect(materialBindingMatches(binding, { ...binding, sourceEvidenceRefs: ["c", "a", "b"] })).toBe(
    true,
  );
  for (const sourceEvidenceRefs of [
    ["a", "b"],
    ["a", "b", "b"],
    ["a", "b", "d"],
  ])
    expect(materialBindingMatches(binding, { ...binding, sourceEvidenceRefs })).toBe(false);
  expect(materialBindingMatches(binding, { ...binding, artifactEvidenceRef: "other" })).toBe(false);
  expect(materialBindingMatches(binding, { ...binding, unexpected: true })).toBe(false);
});
