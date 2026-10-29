import {
  SpeciesContractSchema,
  SpeciesIdentitySchema,
  validateSpeciesIdentityBinding,
  verifyContractDigest,
  type SpeciesContract,
  type SpeciesIdentity,
  type SpeciesProtocolId,
} from "@eigengrid/colony-contracts";

export type SpeciesPlacement = "native" | "shared_read_only" | "external_profile";

export interface AcceptedSpeciesCatalogEntry {
  readonly id: SpeciesProtocolId;
  readonly placement: SpeciesPlacement;
  readonly rationale: string;
}

export const ACCEPTED_SPECIES_CATALOG = [
  {
    id: "eigengrid.scientific-plan/v1",
    placement: "native",
    rationale: "Mission-bound scientific planning with independent validation.",
  },
  {
    id: "eigengrid.scientific-validation/v1",
    placement: "native",
    rationale: "Independent validation of scientific candidates and evidence.",
  },
  {
    id: "eigengrid.amber-campaign/v1",
    placement: "native",
    rationale: "Finite candidate planning for AMBER campaigns.",
  },
  {
    id: "eigengrid.amber-diagnosis/v1",
    placement: "native",
    rationale: "Bounded diagnosis over pinned AMBER evidence.",
  },
  {
    id: "eigengrid.node-audit/v1",
    placement: "shared_read_only",
    rationale: "Read-only node evidence may use the native supervisor without effect authority.",
  },
  {
    id: "eigengrid.skill-lifecycle/v1",
    placement: "native",
    rationale: "Skill authoring and evaluation are one lifecycle species.",
  },
  {
    id: "eigengrid.slurm-incident/v1",
    placement: "external_profile",
    rationale: "Incident operations remain in the separately qualified Myrmex profile.",
  },
  {
    id: "eigengrid.release-qualification/v1",
    placement: "external_profile",
    rationale: "Release qualification remains in the separately qualified Myrmex profile.",
  },
] as const satisfies readonly AcceptedSpeciesCatalogEntry[];

export const MERGED_SPECIES_IDS = {
  "eigengrid.scientific-critic/v1": "eigengrid.scientific-validation/v1",
  "eigengrid.skill-author/v1": "eigengrid.skill-lifecycle/v1",
  "eigengrid.skill-eval/v1": "eigengrid.skill-lifecycle/v1",
} as const satisfies Readonly<Record<string, SpeciesProtocolId>>;

export type SpeciesRegistryErrorCode =
  | "UNACCEPTED_SPECIES"
  | "MERGED_SPECIES"
  | "EXTERNAL_PROFILE_REQUIRED"
  | "DUPLICATE_COORDINATE"
  | "PROMOTION_BLOCKED"
  | "UNKNOWN_SPECIES";

export class SpeciesRegistryError extends Error {
  constructor(
    readonly code: SpeciesRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SpeciesRegistryError";
  }
}

function coordinateKey(identity: Pick<SpeciesIdentity, "coordinate">): string {
  return `${identity.coordinate.id}@${identity.coordinate.version}`;
}

const catalogById = new Map<string, AcceptedSpeciesCatalogEntry>(
  ACCEPTED_SPECIES_CATALOG.map((entry) => [entry.id, entry]),
);

/**
 * In-memory registry for exact, sealed species contracts. Registration is
 * declarative only: it grants no tool, provider, approval, or effect authority.
 */
export class SpeciesRegistry {
  readonly #contracts = new Map<string, SpeciesContract>();

  constructor(contracts: readonly unknown[] = []) {
    for (const contract of contracts) this.register(contract);
  }

  register(input: unknown): { contract: SpeciesContract; duplicate: boolean } {
    const contract = SpeciesContractSchema.parse(input);
    if (!verifyContractDigest(contract)) throw new TypeError("Species contract digest mismatch");
    this.assertAcceptedId(contract.identity.id);

    const key = `${contract.identity.id}@${contract.identity.version}`;
    const existing = this.#contracts.get(key);
    if (existing) {
      if (existing.contractDigest !== contract.contractDigest) {
        throw new SpeciesRegistryError(
          "DUPLICATE_COORDINATE",
          `Species coordinate ${key} already binds ${existing.contractDigest}`,
        );
      }
      return { contract: existing, duplicate: true };
    }

    this.#contracts.set(key, contract);
    return { contract, duplicate: false };
  }

  resolve(input: unknown): SpeciesContract {
    const identity = SpeciesIdentitySchema.parse(input);
    this.assertAcceptedId(identity.coordinate.id);
    const contract = this.#contracts.get(coordinateKey(identity));
    if (!contract) {
      throw new SpeciesRegistryError(
        "UNKNOWN_SPECIES",
        `No exact species contract registered for ${coordinateKey(identity)}`,
      );
    }
    return validateSpeciesIdentityBinding(identity, contract).contract;
  }

  assertAdmissible(input: unknown, mode: "shadow" | "qualified"): SpeciesContract {
    const identity = SpeciesIdentitySchema.parse(input);
    const contract = this.resolve(identity);
    const entry = catalogById.get(identity.coordinate.id)!;
    if (entry.placement === "external_profile") {
      throw new SpeciesRegistryError(
        "EXTERNAL_PROFILE_REQUIRED",
        `${entry.id} requires the separately qualified external Myrmex profile`,
      );
    }

    const promotion = contract.promotionStatus;
    const neverAdmissible = new Set(["degraded", "quarantined", "retired"]);
    const qualified = new Set(["qualified", "preferred"]);
    if (neverAdmissible.has(promotion) || (mode === "qualified" && !qualified.has(promotion))) {
      throw new SpeciesRegistryError(
        "PROMOTION_BLOCKED",
        `${coordinateKey(identity)} at promotion status ${promotion} is not admissible in ${mode} mode`,
      );
    }
    return contract;
  }

  list(): readonly SpeciesContract[] {
    return [...this.#contracts.values()];
  }

  private assertAcceptedId(id: string): void {
    const successor = MERGED_SPECIES_IDS[id as keyof typeof MERGED_SPECIES_IDS];
    if (successor) {
      throw new SpeciesRegistryError(
        "MERGED_SPECIES",
        `${id} is merged into ${successor} and cannot be registered independently`,
      );
    }
    if (!catalogById.has(id)) {
      throw new SpeciesRegistryError(
        "UNACCEPTED_SPECIES",
        `Species ${id} is not in the accepted species catalog`,
      );
    }
  }
}
