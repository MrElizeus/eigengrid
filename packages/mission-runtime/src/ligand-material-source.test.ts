import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalJson, type ForceFieldStackManifest } from "@eigengrid/scientific-schema";
import {
  deriveMol2LigandMaterialDigests,
  resolveLinkedLigandMaterialDigests,
} from "./ligand-material-source";

// Ephemeral unit material; never a system, parameter qualification or receipt.
const mol2 =
  "@<TRIPOS>MOLECULE\nunit-ligand\n2 1 1 0 0\nSMALL\nUSER_CHARGES\n@<TRIPOS>ATOM\n1 C1 0 0 0 c3 1 LIG 0.4\n2 N1 1 0 0 n4 1 LIG 0.6\n@<TRIPOS>BOND\n1 1 2 1\n";
const encoder = new TextEncoder();
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const observed = deriveMol2LigandMaterialDigests(mol2);
function fixture() {
  const rows = [
    { path: "parameters/unit.mol2", sha256: sha(mol2), sizeBytes: Buffer.byteLength(mol2) },
  ];
  const manifest = canonicalJson(rows),
    digest = sha(manifest);
  const stack = {
    ligands: [
      {
        componentId: "unit-only",
        formalCharge: 1,
        atomTypeDigest: observed.atomTypeDigest,
        chargeDigest: observed.chargeDigest,
        parameterSet: { parameterDigest: digest, sourceEvidenceRefs: ["unit-inventory"] },
      },
    ],
  } as ForceFieldStackManifest;
  const objects = new Map([
    [digest, encoder.encode(manifest)],
    [sha(mol2), encoder.encode(mol2)],
  ]);
  return {
    stack,
    objects,
    input: {
      stack,
      evidenceDigests: new Map([["unit-inventory", digest]]),
      load: async (d: string) => {
        const bytes = objects.get(d);
        if (!bytes) throw new Error("CAS absent");
        if (createHash("sha256").update(bytes).digest("hex") !== d)
          throw new Error("CAS digest mismatch");
        return bytes;
      },
      verifyEvidence: async (d: string, n: number) => {
        if (d !== sha(mol2) || n !== Buffer.byteLength(mol2))
          throw new Error("Immutable mission evidence absent");
      },
    },
  };
}
test("derives type/charge digests only from exact ordered MOL2 bytes", () => {
  expect(observed.partialCharge).toBe(1);
  for (const text of [
    mol2.replace("2 1 1 0 0", "3 1 1 0 0"),
    mol2.replace("2 N1", "1 N1"),
    mol2.replace("N1 1 0 0", "C1 1 0 0"),
    mol2.replace("LIG 0.6", "LIG NaN"),
  ])
    expect(() => deriveMol2LigandMaterialDigests(text)).toThrow();
});
test("accepts type/charge subdigests proven through an exact inventory and immutable linked CAS bytes", async () => {
  const { input } = fixture();
  const result = await resolveLinkedLigandMaterialDigests(input);
  expect(result.get("unit-inventory")?.has(observed.atomTypeDigest)).toBe(true);
  expect(result.get("unit-inventory")?.has(observed.chargeDigest)).toBe(true);
});
test("refuses missing/cross-mission evidence, changed linked bytes and falsely claimed subdigests", async () => {
  const f = fixture();
  await expect(
    resolveLinkedLigandMaterialDigests({
      ...f.input,
      verifyEvidence: async () => {
        throw new Error("wrong mission");
      },
    }),
  ).rejects.toThrow();
  f.objects.set(sha(mol2), encoder.encode(mol2.replace("c3", "c2")));
  await expect(resolveLinkedLigandMaterialDigests(f.input)).rejects.toThrow();
  const g = fixture();
  g.stack.ligands[0]!.chargeDigest = "0".repeat(64);
  await expect(resolveLinkedLigandMaterialDigests(g.input)).rejects.toThrow();
  const h = fixture();
  h.stack.ligands[0]!.formalCharge = 0;
  await expect(resolveLinkedLigandMaterialDigests(h.input)).rejects.toThrow();
});
