import {
  PdbIdentifierSchema,
  PubChemCidSchema,
  type PdbIdentifier,
  type PubChemCid,
} from "@eigengrid/scientific-schema";

export interface BenchmarkTargetProfile {
  readonly id: string;
  readonly pdbIds: readonly PdbIdentifier[];
  readonly pubchemCids: readonly PubChemCid[];
}

export function isProfilePdbId(
  profile: BenchmarkTargetProfile,
  value: string,
): value is PdbIdentifier {
  const parsed = PdbIdentifierSchema.safeParse(value.toUpperCase());
  return parsed.success && profile.pdbIds.includes(parsed.data);
}

export function isProfilePubChemCid(
  profile: BenchmarkTargetProfile,
  value: number,
): value is PubChemCid {
  const parsed = PubChemCidSchema.safeParse(value);
  return parsed.success && profile.pubchemCids.includes(parsed.data);
}
