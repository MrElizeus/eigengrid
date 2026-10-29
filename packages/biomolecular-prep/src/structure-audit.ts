export type StructureTextFormat = "pdb" | "mmcif";

export interface StructureAuditOptions {
  readonly referenceLigandResidueNames?: readonly string[];
  readonly additionalIonResidueNames?: readonly string[];
}

export interface ResidueLocator {
  readonly chainId: string;
  readonly residueName: string;
  readonly sequenceNumber: string;
  readonly insertionCode?: string;
}

export interface ChainAudit {
  readonly chainId: string;
  readonly atomCount: number;
  readonly residueCount: number;
  readonly entityIds: readonly string[];
}

export interface EntityAudit {
  readonly entityId: string;
  readonly type: "polymer" | "non_polymer" | "water" | "unknown";
  readonly description?: string;
  readonly chainIds: readonly string[];
  readonly provenance: "declared" | "derived";
}

export interface AlternateLocationAudit extends ResidueLocator {
  readonly atomName: string;
  readonly alternateId: string;
  readonly occupancy?: number;
}

export interface ComponentOccurrence extends ResidueLocator {
  readonly atomCount: number;
  readonly classification: "heteroatom" | "water" | "ion" | "ligand_candidate";
}

export interface GapAudit {
  readonly chainId: string;
  readonly source: "declared_missing_residue" | "inferred_sequence_discontinuity";
  readonly residueName?: string;
  readonly sequenceNumber?: string;
  readonly afterSequenceNumber?: string;
  readonly beforeSequenceNumber?: string;
}

export interface MutationAudit extends ResidueLocator {
  readonly databaseResidueName?: string;
  readonly databaseSequenceNumber?: string;
  readonly details?: string;
  readonly source: "SEQADV" | "struct_ref_seq_dif" | "entity_poly";
  readonly interpretation: "annotated_sequence_difference_not_independently_verified";
}

export interface FusionAudit {
  readonly entityId: string;
  readonly description: string;
  readonly matchedKeyword: string;
  readonly confidence: "heuristic";
}

export interface StructureAuditWarning {
  readonly code:
    | "heuristic_parser_scope"
    | "partial_mmcif_tokenization"
    | "entity_metadata_absent"
    | "missing_residue_evidence_absent"
    | "mutation_evidence_absent"
    | "fusion_detection_is_heuristic"
    | "reference_ligand_not_declared"
    | "declared_reference_ligand_not_found";
  readonly message: string;
}

export interface StructureAudit {
  readonly format: StructureTextFormat;
  readonly chains: readonly ChainAudit[];
  readonly entities: readonly EntityAudit[];
  readonly alternateLocations: readonly AlternateLocationAudit[];
  readonly heteroatoms: readonly ComponentOccurrence[];
  readonly gaps: readonly GapAudit[];
  readonly mutations: readonly MutationAudit[];
  readonly fusions: readonly FusionAudit[];
  readonly waters: readonly ComponentOccurrence[];
  readonly ions: readonly ComponentOccurrence[];
  readonly ligandCandidates: readonly ComponentOccurrence[];
  readonly ligandReferences: readonly ComponentOccurrence[];
  readonly warnings: readonly StructureAuditWarning[];
  readonly parser: {
    readonly id: "eigengrid-biomolecular-structure-auditor";
    readonly version: "1.0.0";
    readonly coverage: "targeted_not_full_specification";
  };
}

interface ParsedAtom extends ResidueLocator {
  readonly recordType: "ATOM" | "HETATM";
  readonly atomName: string;
  readonly alternateId?: string;
  readonly occupancy?: number;
  readonly entityId?: string;
}

interface ParsedEntity {
  readonly entityId: string;
  readonly type?: EntityAudit["type"];
  readonly description?: string;
  readonly chainIds: readonly string[];
}

interface ParsedStructure {
  readonly atoms: readonly ParsedAtom[];
  readonly entities: readonly ParsedEntity[];
  readonly gaps: readonly GapAudit[];
  readonly mutations: readonly MutationAudit[];
  readonly partialMmcifTokenization: boolean;
}

const WATER_NAMES = new Set(["HOH", "WAT", "TIP3", "TIP3P", "SOL"]);
const DEFAULT_ION_NAMES = new Set([
  "NA",
  "K",
  "CL",
  "CA",
  "MG",
  "ZN",
  "MN",
  "FE",
  "CU",
  "CO",
  "CS",
  "LI",
  "RB",
  "BR",
  "IOD",
]);
const FUSION_PATTERNS: readonly [RegExp, string][] = [
  [/\bfusion\b/i, "fusion"],
  [/\bBRIL\b/i, "BRIL"],
  [/cytochrome\s+b562/i, "cytochrome b562"],
  [/T4\s+lysozyme/i, "T4 lysozyme"],
  [/rubredoxin/i, "rubredoxin"],
];

function normalizeChainId(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" || trimmed === "." || trimmed === "?"
    ? "_"
    : trimmed;
}

function optionalValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" || trimmed === "." || trimmed === "?"
    ? undefined
    : trimmed;
}

function residueKey(residue: ResidueLocator): string {
  return [
    residue.chainId,
    residue.residueName,
    residue.sequenceNumber,
    residue.insertionCode ?? "",
  ].join("\u0000");
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parsePdbEntities(lines: readonly string[]): ParsedEntity[] {
  const compoundText = lines
    .filter((line) => line.startsWith("COMPND"))
    .map((line) => line.slice(10).trim())
    .join(" ");
  if (compoundText === "") return [];

  const entities = new Map<string, { description?: string; chainIds: string[] }>();
  let currentId: string | undefined;
  for (const field of compoundText.split(";")) {
    const separator = field.indexOf(":");
    if (separator < 0) continue;
    const key = field.slice(0, separator).trim().toUpperCase();
    const value = field.slice(separator + 1).trim();
    if (key === "MOL_ID") {
      currentId = value;
      if (!entities.has(value)) entities.set(value, { chainIds: [] });
      continue;
    }
    if (currentId === undefined) continue;
    const entity = entities.get(currentId)!;
    if (key === "MOLECULE") entity.description = value;
    if (key === "CHAIN") {
      entity.chainIds.push(...value.split(",").map((item) => normalizeChainId(item)));
    }
  }
  return [...entities.entries()].map(([entityId, value]) => ({
    entityId,
    type: "polymer",
    ...(value.description === undefined ? {} : { description: value.description }),
    chainIds: [...new Set(value.chainIds)].sort(),
  }));
}

function parsePdb(text: string): ParsedStructure {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const atoms: ParsedAtom[] = [];
  const gaps: GapAudit[] = [];
  const mutations: MutationAudit[] = [];

  for (const line of lines) {
    const record = line.slice(0, 6).trim();
    if (record === "ATOM" || record === "HETATM") {
      const padded = line.padEnd(80, " ");
      const alternateId = optionalValue(padded.slice(16, 17));
      const insertionCode = optionalValue(padded.slice(26, 27));
      atoms.push({
        recordType: record,
        atomName: padded.slice(12, 16).trim(),
        residueName: padded.slice(17, 20).trim() || "UNK",
        chainId: normalizeChainId(padded.slice(21, 22)),
        sequenceNumber: padded.slice(22, 26).trim() || "?",
        ...(insertionCode === undefined ? {} : { insertionCode }),
        ...(alternateId === undefined ? {} : { alternateId }),
        ...(parseNumber(padded.slice(54, 60).trim()) === undefined
          ? {}
          : { occupancy: parseNumber(padded.slice(54, 60).trim()) }),
      });
      continue;
    }

    if (line.startsWith("REMARK 465")) {
      const payload = line.slice(10).trim();
      const match = payload.match(
        /^(?:[A-Za-z0-9]{4}\s+)?([A-Za-z0-9]{3})\s+(\S)\s+(-?\d+)([A-Za-z]?)$/,
      );
      if (match !== null) {
        gaps.push({
          chainId: normalizeChainId(match[2]),
          residueName: match[1]!.toUpperCase(),
          sequenceNumber: match[3]!,
          source: "declared_missing_residue",
        });
      }
      continue;
    }

    if (record === "SEQADV") {
      const padded = line.padEnd(80, " ");
      const residueName = padded.slice(12, 15).trim() || "UNK";
      const chainId = normalizeChainId(padded.slice(16, 17));
      const sequenceNumber = padded.slice(18, 22).trim() || "?";
      const insertionCode = optionalValue(padded.slice(22, 23));
      const databaseResidueName = optionalValue(padded.slice(39, 42));
      const databaseSequenceNumber = optionalValue(padded.slice(43, 48));
      const details = optionalValue(padded.slice(49));
      mutations.push({
        chainId,
        residueName,
        sequenceNumber,
        ...(insertionCode === undefined ? {} : { insertionCode }),
        ...(databaseResidueName === undefined ? {} : { databaseResidueName }),
        ...(databaseSequenceNumber === undefined ? {} : { databaseSequenceNumber }),
        ...(details === undefined ? {} : { details }),
        source: "SEQADV",
        interpretation: "annotated_sequence_difference_not_independently_verified",
      });
    }
  }

  return {
    atoms,
    entities: parsePdbEntities(lines),
    gaps,
    mutations,
    partialMmcifTokenization: false,
  };
}

interface CifLoop {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

function tokenizeCifLine(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "#" && current === "") break;
    if (/\s/.test(character)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

function parseCifLoops(text: string): { loops: CifLoop[]; partial: boolean } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const loops: CifLoop[] = [];
  let partial = false;
  let index = 0;
  while (index < lines.length) {
    const trimmed = lines[index]!.trim();
    if (trimmed.startsWith(";")) partial = true;
    if (trimmed !== "loop_") {
      index += 1;
      continue;
    }

    index += 1;
    const headers: string[] = [];
    while (index < lines.length && lines[index]!.trim().startsWith("_")) {
      const [header] = tokenizeCifLine(lines[index]!.trim());
      if (header !== undefined) headers.push(header);
      index += 1;
    }
    const tokens: string[] = [];
    while (index < lines.length) {
      const row = lines[index]!.trim();
      if (row === "#") {
        index += 1;
        break;
      }
      if (row === "loop_" || row.startsWith("data_") || row.startsWith("_") || row === "stop_")
        break;
      if (row.startsWith(";")) {
        partial = true;
        index += 1;
        while (index < lines.length && !lines[index]!.startsWith(";")) index += 1;
        if (index < lines.length) index += 1;
        continue;
      }
      tokens.push(...tokenizeCifLine(row));
      index += 1;
    }
    if (headers.length === 0) continue;
    if (tokens.length % headers.length !== 0) partial = true;
    const rows: string[][] = [];
    for (let offset = 0; offset + headers.length <= tokens.length; offset += headers.length) {
      rows.push(tokens.slice(offset, offset + headers.length));
    }
    loops.push({ headers, rows });
  }
  return { loops, partial };
}

function loopValue(
  loop: CifLoop,
  row: readonly string[],
  ...headers: string[]
): string | undefined {
  for (const header of headers) {
    const index = loop.headers.indexOf(header);
    if (index >= 0) return optionalValue(row[index]);
  }
  return undefined;
}

function loopsForCategory(loops: readonly CifLoop[], category: string): CifLoop[] {
  return loops.filter((loop) => loop.headers.some((header) => header.startsWith(`${category}.`)));
}

function cifEntityType(value: string | undefined): EntityAudit["type"] {
  if (value === "polymer") return "polymer";
  if (value === "water") return "water";
  if (value === "non-polymer" || value === "non_polymer") return "non_polymer";
  return "unknown";
}

function parseMmcif(text: string): ParsedStructure {
  const parsed = parseCifLoops(text);
  const atoms: ParsedAtom[] = [];
  for (const loop of loopsForCategory(parsed.loops, "_atom_site")) {
    for (const row of loop.rows) {
      const record = loopValue(loop, row, "_atom_site.group_PDB");
      if (record !== "ATOM" && record !== "HETATM") continue;
      const insertionCode = loopValue(loop, row, "_atom_site.pdbx_PDB_ins_code");
      const alternateId = loopValue(loop, row, "_atom_site.label_alt_id", "_atom_site.auth_alt_id");
      atoms.push({
        recordType: record,
        atomName:
          loopValue(loop, row, "_atom_site.auth_atom_id", "_atom_site.label_atom_id") ?? "?",
        residueName:
          loopValue(loop, row, "_atom_site.auth_comp_id", "_atom_site.label_comp_id") ?? "UNK",
        chainId: normalizeChainId(
          loopValue(loop, row, "_atom_site.auth_asym_id", "_atom_site.label_asym_id"),
        ),
        sequenceNumber:
          loopValue(loop, row, "_atom_site.auth_seq_id", "_atom_site.label_seq_id") ?? "?",
        ...(insertionCode === undefined ? {} : { insertionCode }),
        ...(alternateId === undefined ? {} : { alternateId }),
        ...(loopValue(loop, row, "_atom_site.occupancy") === undefined
          ? {}
          : { occupancy: parseNumber(loopValue(loop, row, "_atom_site.occupancy")) }),
        ...(loopValue(loop, row, "_atom_site.label_entity_id") === undefined
          ? {}
          : { entityId: loopValue(loop, row, "_atom_site.label_entity_id") }),
      });
    }
  }

  const chainToEntity = new Map<string, string>();
  for (const loop of loopsForCategory(parsed.loops, "_struct_asym")) {
    for (const row of loop.rows) {
      const chainId = loopValue(loop, row, "_struct_asym.id");
      const entityId = loopValue(loop, row, "_struct_asym.entity_id");
      if (chainId !== undefined && entityId !== undefined) chainToEntity.set(chainId, entityId);
    }
  }

  const entityChains = new Map<string, Set<string>>();
  for (const [chainId, entityId] of chainToEntity) {
    const chains = entityChains.get(entityId) ?? new Set<string>();
    chains.add(chainId);
    entityChains.set(entityId, chains);
  }
  for (const atom of atoms) {
    if (atom.entityId === undefined) continue;
    const chains = entityChains.get(atom.entityId) ?? new Set<string>();
    chains.add(atom.chainId);
    entityChains.set(atom.entityId, chains);
  }

  const entities: ParsedEntity[] = [];
  for (const loop of loopsForCategory(parsed.loops, "_entity")) {
    if (!loop.headers.includes("_entity.id")) continue;
    for (const row of loop.rows) {
      const entityId = loopValue(loop, row, "_entity.id");
      if (entityId === undefined) continue;
      const description = loopValue(loop, row, "_entity.pdbx_description");
      entities.push({
        entityId,
        type: cifEntityType(loopValue(loop, row, "_entity.type")),
        ...(description === undefined ? {} : { description }),
        chainIds: [...(entityChains.get(entityId) ?? [])].sort(),
      });
    }
  }

  const gaps: GapAudit[] = [];
  for (const loop of loopsForCategory(parsed.loops, "_pdbx_unobs_or_zero_occ_residues")) {
    for (const row of loop.rows) {
      const chainId = loopValue(
        loop,
        row,
        "_pdbx_unobs_or_zero_occ_residues.auth_asym_id",
        "_pdbx_unobs_or_zero_occ_residues.label_asym_id",
      );
      const sequenceNumber = loopValue(
        loop,
        row,
        "_pdbx_unobs_or_zero_occ_residues.auth_seq_id",
        "_pdbx_unobs_or_zero_occ_residues.label_seq_id",
      );
      if (chainId === undefined || sequenceNumber === undefined) continue;
      gaps.push({
        chainId: normalizeChainId(chainId),
        residueName:
          loopValue(
            loop,
            row,
            "_pdbx_unobs_or_zero_occ_residues.auth_comp_id",
            "_pdbx_unobs_or_zero_occ_residues.label_comp_id",
          ) ?? "UNK",
        sequenceNumber,
        source: "declared_missing_residue",
      });
    }
  }

  const mutations: MutationAudit[] = [];
  for (const loop of loopsForCategory(parsed.loops, "_struct_ref_seq_dif")) {
    for (const row of loop.rows) {
      const sequenceNumber = loopValue(
        loop,
        row,
        "_struct_ref_seq_dif.pdbx_auth_seq_num",
        "_struct_ref_seq_dif.seq_num",
      );
      if (sequenceNumber === undefined) continue;
      mutations.push({
        chainId: normalizeChainId(
          loopValue(
            loop,
            row,
            "_struct_ref_seq_dif.pdbx_pdb_strand_id",
            "_struct_ref_seq_dif.pdbx_auth_asym_id",
          ),
        ),
        residueName: loopValue(loop, row, "_struct_ref_seq_dif.mon_id") ?? "UNK",
        sequenceNumber,
        ...(loopValue(loop, row, "_struct_ref_seq_dif.db_mon_id") === undefined
          ? {}
          : { databaseResidueName: loopValue(loop, row, "_struct_ref_seq_dif.db_mon_id") }),
        ...(loopValue(loop, row, "_struct_ref_seq_dif.pdbx_seq_db_seq_num") === undefined
          ? {}
          : {
              databaseSequenceNumber: loopValue(
                loop,
                row,
                "_struct_ref_seq_dif.pdbx_seq_db_seq_num",
              ),
            }),
        ...(loopValue(loop, row, "_struct_ref_seq_dif.details") === undefined
          ? {}
          : { details: loopValue(loop, row, "_struct_ref_seq_dif.details") }),
        source: "struct_ref_seq_dif",
        interpretation: "annotated_sequence_difference_not_independently_verified",
      });
    }
  }

  return {
    atoms,
    entities,
    gaps,
    mutations,
    partialMmcifTokenization: parsed.partial,
  };
}

function inferSequenceGaps(atoms: readonly ParsedAtom[]): GapAudit[] {
  const residuesByChain = new Map<string, Map<number, string>>();
  for (const atom of atoms) {
    if (atom.recordType !== "ATOM" || atom.insertionCode !== undefined) continue;
    const sequenceNumber = Number(atom.sequenceNumber);
    if (!Number.isInteger(sequenceNumber)) continue;
    const residues = residuesByChain.get(atom.chainId) ?? new Map<number, string>();
    residues.set(sequenceNumber, atom.residueName);
    residuesByChain.set(atom.chainId, residues);
  }
  const gaps: GapAudit[] = [];
  for (const [chainId, residues] of residuesByChain) {
    const numbers = [...residues.keys()].sort((left, right) => left - right);
    for (let index = 1; index < numbers.length; index += 1) {
      const previous = numbers[index - 1]!;
      const current = numbers[index]!;
      if (current - previous > 1) {
        gaps.push({
          chainId,
          afterSequenceNumber: String(previous),
          beforeSequenceNumber: String(current),
          source: "inferred_sequence_discontinuity",
        });
      }
    }
  }
  return gaps;
}

function finalizeAudit(
  format: StructureTextFormat,
  parsed: ParsedStructure,
  options: StructureAuditOptions,
): StructureAudit {
  const additionalIons = options.additionalIonResidueNames ?? [];
  const ionNames = new Set([
    ...DEFAULT_ION_NAMES,
    ...additionalIons.map((name) => name.toUpperCase()),
  ]);
  const referenceNames = new Set(
    (options.referenceLigandResidueNames ?? []).map((name) => name.toUpperCase()),
  );

  const chainAtoms = new Map<string, ParsedAtom[]>();
  for (const atom of parsed.atoms) {
    const atoms = chainAtoms.get(atom.chainId) ?? [];
    atoms.push(atom);
    chainAtoms.set(atom.chainId, atoms);
  }
  const declaredEntityIdsByChain = new Map<string, Set<string>>();
  for (const entity of parsed.entities) {
    for (const chainId of entity.chainIds) {
      const ids = declaredEntityIdsByChain.get(chainId) ?? new Set<string>();
      ids.add(entity.entityId);
      declaredEntityIdsByChain.set(chainId, ids);
    }
  }
  const chains: ChainAudit[] = [...chainAtoms.entries()]
    .map(([chainId, atoms]) => ({
      chainId,
      atomCount: atoms.length,
      residueCount: new Set(atoms.map(residueKey)).size,
      entityIds: [
        ...new Set([
          ...(declaredEntityIdsByChain.get(chainId) ?? []),
          ...atoms.map((atom) => atom.entityId).filter((id): id is string => id !== undefined),
        ]),
      ].sort(),
    }))
    .sort((left, right) => left.chainId.localeCompare(right.chainId));

  const occurrenceAtoms = new Map<string, ParsedAtom[]>();
  for (const atom of parsed.atoms.filter((candidate) => candidate.recordType === "HETATM")) {
    const key = residueKey(atom);
    const atoms = occurrenceAtoms.get(key) ?? [];
    atoms.push(atom);
    occurrenceAtoms.set(key, atoms);
  }
  const heteroatoms: ComponentOccurrence[] = [];
  const waters: ComponentOccurrence[] = [];
  const ions: ComponentOccurrence[] = [];
  const ligandCandidates: ComponentOccurrence[] = [];
  for (const atoms of occurrenceAtoms.values()) {
    const first = atoms[0]!;
    const common = {
      chainId: first.chainId,
      residueName: first.residueName,
      sequenceNumber: first.sequenceNumber,
      ...(first.insertionCode === undefined ? {} : { insertionCode: first.insertionCode }),
      atomCount: atoms.length,
    };
    if (WATER_NAMES.has(first.residueName.toUpperCase())) {
      waters.push({ ...common, classification: "water" });
    } else if (ionNames.has(first.residueName.toUpperCase())) {
      ions.push({ ...common, classification: "ion" });
    } else {
      heteroatoms.push({ ...common, classification: "heteroatom" });
      ligandCandidates.push({ ...common, classification: "ligand_candidate" });
    }
  }
  const byLocation = (left: ComponentOccurrence, right: ComponentOccurrence): number =>
    `${left.chainId}:${left.sequenceNumber}:${left.residueName}`.localeCompare(
      `${right.chainId}:${right.sequenceNumber}:${right.residueName}`,
    );
  heteroatoms.sort(byLocation);
  waters.sort(byLocation);
  ions.sort(byLocation);
  ligandCandidates.sort(byLocation);
  const ligandReferences = ligandCandidates.filter((candidate) =>
    referenceNames.has(candidate.residueName.toUpperCase()),
  );

  const alternateLocations = parsed.atoms
    .filter((atom): atom is ParsedAtom & { alternateId: string } => atom.alternateId !== undefined)
    .map((atom) => ({
      chainId: atom.chainId,
      residueName: atom.residueName,
      sequenceNumber: atom.sequenceNumber,
      ...(atom.insertionCode === undefined ? {} : { insertionCode: atom.insertionCode }),
      atomName: atom.atomName,
      alternateId: atom.alternateId,
      ...(atom.occupancy === undefined ? {} : { occupancy: atom.occupancy }),
    }));

  const entities: EntityAudit[] = parsed.entities.map((entity) => ({
    entityId: entity.entityId,
    type: entity.type ?? "unknown",
    ...(entity.description === undefined ? {} : { description: entity.description }),
    chainIds: [...entity.chainIds].sort(),
    provenance: "declared",
  }));
  if (entities.length === 0) {
    for (const chain of chains) {
      entities.push({
        entityId: `derived:${chain.chainId}`,
        type: parsed.atoms.some(
          (atom) => atom.chainId === chain.chainId && atom.recordType === "ATOM",
        )
          ? "polymer"
          : "unknown",
        chainIds: [chain.chainId],
        provenance: "derived",
      });
    }
  }

  const fusions: FusionAudit[] = [];
  for (const entity of entities) {
    if (entity.description === undefined) continue;
    for (const [pattern, keyword] of FUSION_PATTERNS) {
      if (pattern.test(entity.description)) {
        fusions.push({
          entityId: entity.entityId,
          description: entity.description,
          matchedKeyword: keyword,
          confidence: "heuristic",
        });
        break;
      }
    }
  }

  const gaps = [...parsed.gaps, ...inferSequenceGaps(parsed.atoms)];
  const warnings: StructureAuditWarning[] = [
    {
      code: "heuristic_parser_scope",
      message:
        "The auditor covers selected PDB/mmCIF records and must not be treated as a full format validator.",
    },
    {
      code: "fusion_detection_is_heuristic",
      message: "Fusion detection is keyword-based and requires scientific review.",
    },
  ];
  if (parsed.partialMmcifTokenization) {
    warnings.push({
      code: "partial_mmcif_tokenization",
      message:
        "At least one multiline or incomplete mmCIF token group was outside the targeted parser subset.",
    });
  }
  if (parsed.entities.length === 0) {
    warnings.push({
      code: "entity_metadata_absent",
      message:
        "No supported entity declaration was found; entities were derived from observed chains.",
    });
  }
  if (gaps.length === 0) {
    warnings.push({
      code: "missing_residue_evidence_absent",
      message:
        "No supported missing-residue record or numeric sequence discontinuity was observed.",
    });
  }
  if (parsed.mutations.length === 0) {
    warnings.push({
      code: "mutation_evidence_absent",
      message:
        "No supported mutation annotation was observed; this is not evidence of a wild-type construct.",
    });
  }
  if (referenceNames.size === 0) {
    warnings.push({
      code: "reference_ligand_not_declared",
      message:
        "No reviewed reference ligand residue name was supplied; candidates remain unclassified.",
    });
  } else if (ligandReferences.length === 0) {
    warnings.push({
      code: "declared_reference_ligand_not_found",
      message:
        "None of the declared reference ligand residue names was found among parsed HETATM groups.",
    });
  }

  return {
    format,
    chains,
    entities,
    alternateLocations,
    heteroatoms,
    gaps,
    mutations: parsed.mutations,
    fusions,
    waters,
    ions,
    ligandCandidates,
    ligandReferences,
    warnings,
    parser: {
      id: "eigengrid-biomolecular-structure-auditor",
      version: "1.0.0",
      coverage: "targeted_not_full_specification",
    },
  };
}

export function auditStructureText(
  text: string,
  format: StructureTextFormat,
  options: StructureAuditOptions = {},
): StructureAudit {
  if (text.trim() === "") throw new TypeError("Structure text must not be empty");
  return finalizeAudit(format, format === "pdb" ? parsePdb(text) : parseMmcif(text), options);
}
