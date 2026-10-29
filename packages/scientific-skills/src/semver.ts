export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly (string | number)[];
  raw: string;
}

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

export function parseSemver(version: string): ParsedSemver {
  const match = SEMVER.exec(version);
  if (!match) throw new Error(`Invalid semantic version: ${version}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]
      ? match[4].split(".").map((part) => (/^\d+$/u.test(part) ? Number(part) : part))
      : [],
    raw: version,
  };
}

export function compareSemver(left: string | ParsedSemver, right: string | ParsedSemver): number {
  const a = typeof left === "string" ? parseSemver(left) : left;
  const b = typeof right === "string" ? parseSemver(right) : right;
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
  if (b.prerelease.length === 0 && a.prerelease.length > 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (av === bv) continue;
    if (typeof av === "number" && typeof bv === "string") return -1;
    if (typeof av === "string" && typeof bv === "number") return 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

function full(version: string): string {
  const pieces = version.split(".");
  if (pieces.length === 1) return `${version}.0.0`;
  if (pieces.length === 2) return `${version}.0`;
  return version;
}

function comparatorMatches(version: string, comparator: string): boolean {
  const trimmed = comparator.trim();
  if (!trimmed || trimmed === "*" || /^x$/iu.test(trimmed)) return true;
  const wildcard = /^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/iu.exec(trimmed);
  if (wildcard && (wildcard[2] === undefined || /^(?:x|\*)$/iu.test(wildcard[2]))) {
    return parseSemver(version).major === Number(wildcard[1]);
  }
  if (wildcard && (wildcard[3] === undefined || /^(?:x|\*)$/iu.test(wildcard[3]))) {
    const parsed = parseSemver(version);
    return parsed.major === Number(wildcard[1]) && parsed.minor === Number(wildcard[2]);
  }
  const match = /^(<=|>=|<|>|=|\^|~)?\s*(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)$/u.exec(trimmed);
  if (!match) throw new Error(`Unsupported semantic-version comparator: ${comparator}`);
  const operator = match[1] ?? "=";
  const target = full(match[2]);
  const relation = compareSemver(version, target);
  if (operator === "=") return relation === 0;
  if (operator === ">") return relation > 0;
  if (operator === ">=") return relation >= 0;
  if (operator === "<") return relation < 0;
  if (operator === "<=") return relation <= 0;
  const base = parseSemver(target);
  if (relation < 0) return false;
  if (operator === "~") {
    return parseSemver(version).major === base.major && parseSemver(version).minor === base.minor;
  }
  const current = parseSemver(version);
  if (base.major > 0) return current.major === base.major;
  if (base.minor > 0) return current.major === 0 && current.minor === base.minor;
  return current.major === 0 && current.minor === 0 && current.patch === base.patch;
}

/** Deterministic semver range matching for exact, comparator-set, wildcard, caret, tilde, and OR ranges. */
export function satisfiesSemver(version: string, range: string): boolean {
  parseSemver(version);
  return range
    .split("||")
    .map((branch) => branch.trim())
    .some((branch) => {
      if (!branch || branch === "*") return true;
      const hyphen = /^(\d+(?:\.\d+){2})\s+-\s+(\d+(?:\.\d+){2})$/u.exec(branch);
      if (hyphen) {
        return compareSemver(version, hyphen[1]) >= 0 && compareSemver(version, hyphen[2]) <= 0;
      }
      const comparators = branch.match(
        /(?:<=|>=|<|>|=|\^|~)?\s*\d+(?:\.\d+|\.(?:x|\*)){0,2}(?:-[0-9A-Za-z.-]+)?|\*/giu,
      );
      if (!comparators || comparators.join("").replace(/\s/gu, "") !== branch.replace(/\s/gu, "")) {
        throw new Error(`Unsupported semantic-version range: ${range}`);
      }
      return comparators.every((comparator) => comparatorMatches(version, comparator));
    });
}
