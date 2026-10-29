import { z } from "zod";
import {
  BiomolecularSystemManifestSchema,
  BiomolecularSystemBuildRequestSchema,
  canonicalJson,
  digestCanonical,
  computeBiomolecularSystemManifestDigest,
  type EvidenceReference,
  type ExternalOperation,
  type OperationReceipt,
  type WorkUnit,
  type BiomolecularSystemManifest,
  type AtomMap,
} from "@eigengrid/scientific-schema";
import {
  AmberPreparedSystemPackageSchema,
  AmberPreparedSystemQcReportSchema,
  type AmberPreparedSystemPackage,
  assertAmberPreparedSystemPackage,
} from "@eigengrid/amber-adapter";

/** Reviewed scientific material only; the real effect adds publication provenance. */
export const AmberFrozenSystemDraftSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.amber-frozen-system-draft/v1"),
    system: BiomolecularSystemManifestSchema.innerType()
      .omit({ schemaVersion: true, provenance: true, manifestDigest: true })
      .strict(),
    atomMap: z.unknown(),
    forceFieldStack: z.unknown(),
    parameterDigests: z
      .array(z.string().regex(/^[a-f0-9]{64}$/u))
      .min(4)
      .max(64),
    artifacts: AmberPreparedSystemPackageSchema.shape.artifacts,
    qc: AmberPreparedSystemQcReportSchema,
  })
  .strict();

export interface FrozenPreparationSourceProof {
  draft: unknown;
  sourceManifest: unknown;
  sourceManifestEvidenceRef: string;
}

export function assertAtomMapPackageMaterial(
  value: unknown,
  manifest: BiomolecularSystemManifest,
  atomMap: AtomMap,
): AmberPreparedSystemPackage {
  const prepared = assertAmberPreparedSystemPackage(value);
  if (
    canonicalJson(prepared.systemManifest) !== canonicalJson(manifest) ||
    canonicalJson(prepared.atomMap) !== canonicalJson(atomMap)
  )
    throw new Error("AtomMap QC package must be its exact published system and map");
  return prepared;
}

/** The source manifest is self-sealed material metadata, not publication authority. */
export function frozenSourceManifestDigest(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const { manifestDigest, ...material } = value as Record<string, unknown>;
  return typeof manifestDigest === "string" && digestCanonical(material) === manifestDigest
    ? manifestDigest
    : undefined;
}

/** Prove every final field from exact CAS inputs plus the observed receipt.
 * This resolves the pre-effect/final digest cycle without accepting a bare
 * alternate digest or modifying any physical QC check. */
export function assertReceiptDerivedFrozenSource(input: {
  prepared: AmberPreparedSystemPackage;
  workUnit: WorkUnit;
  operation: ExternalOperation;
  receipt: OperationReceipt;
  evidence: readonly EvidenceReference[];
  proof: FrozenPreparationSourceProof;
}): void {
  const { prepared, workUnit, operation, receipt, evidence, proof } = input;
  const request = BiomolecularSystemBuildRequestSchema.parse(operation.request);
  if (
    !("inputEvidenceId" in request) ||
    workUnit.protocolFragment.kind !== "scientific_capability" ||
    operation.state !== "confirmed" ||
    receipt.status !== "confirmed" ||
    receipt.operationId !== operation.id ||
    operation.receiptId !== receipt.id ||
    operation.requestDigest !== receipt.requestDigest ||
    operation.externalIdentity?.publisher !== "eigengrid-frozen-amber-material-adoption/v1"
  )
    throw new Error("Frozen source import requires its exact v2 confirmed adoption receipt");
  const immutableSource = (id: string, document: unknown) => {
    const matches = evidence.filter((e) => e.id === id);
    const digest = digestCanonical(document);
    if (
      matches.length !== 1 ||
      !matches[0]!.immutable ||
      matches[0]!.missionId !== prepared.missionId ||
      matches[0]!.kind !== "source_snapshot" ||
      matches[0]!.uri !== `cas://sha256/${digest}` ||
      matches[0]!.contentDigest !== digest ||
      matches[0]!.sizeBytes !== Buffer.byteLength(canonicalJson(document)) ||
      !workUnit.inputRefs.includes(id) ||
      !request.sourceEvidence.some((e) => e.id === id && e.contentDigest === digest)
    )
      throw new Error("Frozen source must be the exact sealed same-mission CAS input");
    return digest;
  };
  if (immutableSource(request.inputEvidenceId, proof.draft) !== request.inputContentDigest)
    throw new Error("Frozen draft differs from the approved coordinator input");
  immutableSource(proof.sourceManifestEvidenceRef, proof.sourceManifest);
  const source = proof.sourceManifest as Record<string, unknown>;
  if (
    frozenSourceManifestDigest(source) !== workUnit.protocolFragment.parameters.manifestDigest ||
    source.id !== prepared.systemManifest.id ||
    source.revision !== prepared.systemManifest.revision ||
    [
      "topologyDigest",
      "coordinateDigest",
      "atomMapDigest",
      "atomCount",
      "totalCharge",
      "box",
      "forceFieldStack",
      "environment",
    ].some(
      (key) =>
        canonicalJson(source[key]) !==
        canonicalJson(prepared.systemManifest[key as keyof typeof prepared.systemManifest]),
    )
  )
    throw new Error("Frozen source manifest material is not the exact reviewed system");
  const draft = AmberFrozenSystemDraftSchema.parse(proof.draft);
  const base = {
    ...draft.system,
    schemaVersion: "eigengrid.biomolecular-system-manifest/v2" as const,
    provenance: {
      operationId: operation.id,
      operationReceiptId: receipt.id,
      builder: { name: "eigengrid-frozen-amber-material-adoption", version: "1.0.0" },
      createdBy: {
        id: "eigengrid-amber-material-publication",
        kind: "service" as const,
        role: "scientific-mission-owner",
      },
      createdAt: receipt.recordedAt,
    },
  };
  const expected = {
    ...base,
    manifestDigest: computeBiomolecularSystemManifestDigest(base),
  };
  if (
    canonicalJson(expected) !== canonicalJson(prepared.systemManifest) ||
    ["atomMap", "forceFieldStack", "parameterDigests", "artifacts", "qc"].some(
      (key) =>
        canonicalJson(draft[key as keyof typeof draft]) !==
        canonicalJson(prepared[key as keyof typeof prepared]),
    )
  )
    throw new Error("Prepared system differs from its complete receipt-derived frozen source");
}
