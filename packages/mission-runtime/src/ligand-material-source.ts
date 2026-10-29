import { z } from "zod";
import { digestCanonical, type ForceFieldStackManifest } from "@eigengrid/scientific-schema";

const inventory = z
  .array(
    z
      .object({
        path: z.string().min(1).max(1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        sizeBytes: z
          .number()
          .int()
          .positive()
          .max(16 * 1024 ** 2),
      })
      .strict(),
  )
  .min(1)
  .max(512);

/** Digest the exact atom order, names, GAFF types and serialized charges. This
 * is a byte-integrity proof, not a claim about parameter quality or MD stability. */
export function deriveMol2LigandMaterialDigests(text: string) {
  if (Buffer.byteLength(text) > 16 * 1024 ** 2)
    throw new Error("MOL2 material exceeds bounded size");
  const sections = text.split(/^@<TRIPOS>/mu);
  const molecule = sections.find((x) => x.startsWith("MOLECULE\n"));
  const atomSections = sections.filter((x) => x.startsWith("ATOM\n"));
  if (!molecule || atomSections.length !== 1)
    throw new Error("Single MOL2 molecule/atom section required");
  const declaredCount = Number(molecule.split(/\r?\n/u)[2]?.trim().split(/\s+/u)[0]);
  const atoms = atomSections[0]!
    .split(/\r?\n/u)
    .slice(1)
    .filter((x) => x.trim())
    .map((line, index) => {
      const fields = line.trim().split(/\s+/u);
      if (
        fields.length !== 9 ||
        Number(fields[0]) !== index + 1 ||
        !fields[1] ||
        !fields[5] ||
        ![fields[2], fields[3], fields[4], fields[8]].every(
          (x) => x !== undefined && Number.isFinite(Number(x)),
        )
      )
        throw new Error("Invalid ordered MOL2 atom/charge row");
      return { atom: fields[1]!, type: fields[5]!, charge: Number(fields[8]) };
    });
  if (
    atoms.length === 0 ||
    atoms.length !== declaredCount ||
    new Set(atoms.map((x) => x.atom)).size !== atoms.length
  )
    throw new Error("MOL2 count/name identity is invalid");
  return {
    atomTypeDigest: digestCanonical(atoms.map(({ atom, type }) => ({ atom, type }))),
    chargeDigest: digestCanonical(atoms.map(({ atom, charge }) => ({ atom, charge }))),
    partialCharge: atoms.reduce((sum, x) => sum + x.charge, 0),
  };
}

/** A stack may cite a hash-sealed file inventory as its parameter source. Accept
 * its type/charge subdigests only after following a .mol2 SHA to independently
 * verified, immutable same-mission CAS evidence and deriving both from bytes.
 * Arbitrary paths, labels and bare claimed subdigests never provide authority. */
export async function resolveLinkedLigandMaterialDigests(input: {
  stack: ForceFieldStackManifest;
  evidenceDigests: ReadonlyMap<string, string>;
  load: (digest: string) => Promise<Uint8Array>;
  verifyEvidence: (digest: string, sizeBytes: number) => Promise<void>;
}) {
  const result = new Map<string, Set<string>>();
  for (const ligand of input.stack.ligands) {
    const refs = ligand.parameterSet.sourceEvidenceRefs;
    if (
      [ligand.atomTypeDigest, ligand.chargeDigest].every((d) =>
        refs.some((id) => input.evidenceDigests.get(id) === d),
      )
    )
      continue;
    let matched = false;
    for (const id of refs) {
      if (input.evidenceDigests.get(id) !== ligand.parameterSet.parameterDigest) continue;
      const rows = inventory.parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await input.load(ligand.parameterSet.parameterDigest),
          ),
        ),
      );
      for (const row of rows.filter((x) => /\.mol2$/iu.test(x.path))) {
        await input.verifyEvidence(row.sha256, row.sizeBytes);
        const bytes = await input.load(row.sha256);
        if (bytes.byteLength !== row.sizeBytes) throw new Error("Linked MOL2 size mismatch");
        const observed = deriveMol2LigandMaterialDigests(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
        if (
          observed.atomTypeDigest !== ligand.atomTypeDigest ||
          observed.chargeDigest !== ligand.chargeDigest
        )
          continue;
        if (Math.abs(observed.partialCharge - ligand.formalCharge) > 1e-4)
          throw new Error("Linked MOL2 charge differs from formal ligand state");
        const values = result.get(id) ?? new Set<string>();
        values.add(observed.atomTypeDigest);
        values.add(observed.chargeDigest);
        result.set(id, values);
        matched = true;
      }
    }
    if (!matched)
      throw new Error("Ligand types/charges lack exact direct or linked immutable CAS byte proof");
  }
  return result;
}
