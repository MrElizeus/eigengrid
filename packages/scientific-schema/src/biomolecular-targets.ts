import { z } from "zod";

/** Generic PDB identifier syntax; benchmark membership belongs to a profile. */
export const PdbIdentifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9]{4}$/u, "Expected a four-character PDB identifier");
export type PdbIdentifier = z.infer<typeof PdbIdentifierSchema>;

/** Generic PubChem CID syntax; benchmark membership belongs to a profile. */
export const PubChemCidSchema = z.number().int().positive().safe();
export type PubChemCid = z.infer<typeof PubChemCidSchema>;

/** Network-visible acquisition policy. `cache_only` must never fall through to a fetch. */
export const BiomolecularAcquisitionCachePolicySchema = z.enum([
  "cache_only",
  "prefer_cache",
  "refresh",
]);
export type BiomolecularAcquisitionCachePolicy = z.infer<
  typeof BiomolecularAcquisitionCachePolicySchema
>;
