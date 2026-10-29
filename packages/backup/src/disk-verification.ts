import { createHash } from "crypto";
import { constants, createReadStream } from "fs";
import { chmod, lstat, mkdir, open, readdir } from "fs/promises";
import { join, relative, sep } from "path";
import * as tar from "tar";
import { ARCHIVE_PREFLIGHT_LIMITS, canonicalPath } from "./archive-preflight";
import type { RestoreEntry } from "./restore-materialization";
import {
  BACKUP_CONTROL_FILE_MAX_BYTES,
  groupScientificCasReferences,
  parseScientificCasIndex,
  readScientificCasReferences,
  scientificCasArchivePath,
} from "./scientific-cas";

const CHECKSUM_LINE_LIMIT = 64 + 2 + 4 * 4096;
type Inventory = Map<string, { path: string; size: number }>;

function posixPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

async function inventory(
  root: string,
  current = root,
  files: Inventory = new Map(),
): Promise<Inventory> {
  await chmod(current, 0o700);
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const stat = await lstat(path);
    const key = posixPath(root, path);
    if (stat.isDirectory()) await inventory(root, path, files);
    else if (stat.isFile()) {
      await chmod(path, 0o600);
      files.set(key, { path, size: stat.size });
    } else throw new Error(`Unsupported staged entry: ${key}`);
  }
  return files;
}

async function readControlFile(
  file: { path: string; size: number },
  name = "manifest.json",
): Promise<Buffer> {
  if (file.size > BACKUP_CONTROL_FILE_MAX_BYTES) throw new Error(`${name} exceeds 1 MiB limit`);
  const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > BACKUP_CONTROL_FILE_MAX_BYTES)
      throw new Error(`${name} exceeds 1 MiB limit`);
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw new Error("Unexpected manifest.json EOF");
      offset += bytesRead;
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

function verifyScientificCasCounts(
  manifest: Buffer | undefined,
  referenceCount: number,
  objectCount: number,
): string[] {
  if (!manifest) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest.toString("utf-8"));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const counts = (parsed as Record<string, unknown>).counts;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    return referenceCount === 0 ? [] : ["Backup manifest is missing scientific CAS counts"];
  }
  const record = counts as Record<string, unknown>;
  const hasReferences = Object.prototype.hasOwnProperty.call(record, "scientificCasReferences");
  const hasObjects = Object.prototype.hasOwnProperty.call(record, "scientificCasObjects");
  if (!hasReferences && !hasObjects && referenceCount === 0 && objectCount === 0) return [];
  if (!hasReferences && !hasObjects) return ["Backup manifest is missing scientific CAS counts"];
  if (!hasReferences || !hasObjects)
    return ["Backup manifest has incomplete scientific CAS counts"];
  const manifestReferences = record.scientificCasReferences;
  const manifestObjects = record.scientificCasObjects;
  if (
    typeof manifestReferences !== "number" ||
    !Number.isSafeInteger(manifestReferences) ||
    manifestReferences < 0 ||
    typeof manifestObjects !== "number" ||
    !Number.isSafeInteger(manifestObjects) ||
    manifestObjects < 0
  ) {
    return ["Backup manifest has invalid scientific CAS counts"];
  }
  const errors: string[] = [];
  if (manifestReferences !== referenceCount) {
    errors.push(
      `Scientific CAS reference count mismatch: expected ${referenceCount}, got ${manifestReferences}`,
    );
  }
  if (manifestObjects !== objectCount) {
    errors.push(
      `Scientific CAS object count mismatch: expected ${objectCount}, got ${manifestObjects}`,
    );
  }
  return errors;
}

async function verifyScientificCas(files: Inventory, manifest?: Buffer): Promise<string[]> {
  const head = files.get("head.sqlite");
  const indexFile = files.get("cas/index.json");
  const casPayloadPaths = Array.from(files.keys())
    .filter((path) => path.startsWith("cas/") && path !== "cas/index.json")
    .sort();
  if (!head) {
    return indexFile || casPayloadPaths.length > 0
      ? ["Scientific CAS payload is present without head.sqlite"]
      : [];
  }

  let references;
  try {
    references = await readScientificCasReferences(head.path);
  } catch (error) {
    return [
      `Cannot inspect scientific CAS references in head.sqlite: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
  const expected = groupScientificCasReferences(references);
  const countErrors = verifyScientificCasCounts(manifest, references.length, expected.length);
  if (!indexFile) {
    return [
      ...countErrors,
      ...(expected.length > 0
        ? ["Scientific CAS references exist but cas/index.json is missing"]
        : casPayloadPaths.length > 0
          ? ["Scientific CAS objects exist but cas/index.json is missing"]
          : []),
    ];
  }

  let index;
  try {
    index = parseScientificCasIndex(
      JSON.parse((await readControlFile(indexFile, "cas/index.json")).toString("utf-8")),
    );
  } catch (error) {
    return [
      `Invalid scientific CAS index: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  if (index.objects.length !== expected.length) {
    return [
      ...countErrors,
      `Scientific CAS index object count mismatch: expected ${expected.length}, got ${index.objects.length}`,
    ];
  }

  const errors: string[] = [...countErrors];
  const expectedPaths = new Set<string>();
  for (let offset = 0; offset < expected.length; offset += 1) {
    const reference = expected[offset]!;
    const object = index.objects[offset]!;
    const archivePath = scientificCasArchivePath(reference.digest);
    expectedPaths.add(archivePath);
    if (
      object.digest !== reference.digest ||
      object.uri !== reference.uri ||
      object.archivePath !== archivePath ||
      JSON.stringify(object.evidenceIds) !== JSON.stringify(reference.evidenceIds)
    ) {
      errors.push(`Scientific CAS index does not exactly bind ${reference.digest}`);
      continue;
    }
    const file = files.get(archivePath);
    if (!file) {
      errors.push(`Scientific CAS object is missing: ${archivePath}`);
      continue;
    }
    if (file.size !== object.sizeBytes) {
      errors.push(`Scientific CAS object size mismatch: ${archivePath}`);
      continue;
    }
    if (
      reference.expectedSizeBytes !== undefined &&
      object.sizeBytes !== reference.expectedSizeBytes
    ) {
      errors.push(`Scientific CAS object size disagrees with evidence claims: ${archivePath}`);
      continue;
    }
    if ((await digest(file.path)) !== reference.digest) {
      errors.push(`Scientific CAS object bytes do not match their address: ${archivePath}`);
    }
  }
  for (const path of casPayloadPaths) {
    if (!expectedPaths.has(path)) errors.push(`Unreferenced scientific CAS object: ${path}`);
  }
  return errors;
}

async function digest(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Checksum target is not a regular file");
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function verifyChecksums(
  file: { path: string },
  files: Inventory,
): Promise<{ errors: string[]; expected: Map<string, string>; observed: string }> {
  const raw = new Set<string>();
  const canonical = new Set<string>();
  const expected = new Map<string, string>();
  const checksumHash = createHash("sha256");
  const maxRows = Math.min(Math.max(0, files.size - 1), ARCHIVE_PREFLIGHT_LIMITS.maxEntries);
  const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("checksums.sha256 is not a regular file");
    let carry = Buffer.alloc(0);
    let rows = 0;
    const process = async (line: Buffer): Promise<string | undefined> => {
      if (line.length > CHECKSUM_LINE_LIMIT) return "Malformed checksum record";
      let row: string;
      try {
        row = new TextDecoder("utf-8", { fatal: true }).decode(line);
      } catch {
        return "Malformed checksum record";
      }
      const match = /^([a-f0-9]{64})  (.+)$/.exec(row);
      if (!match) return "Malformed checksum record";
      const [, expectedHash, path] = match;
      let key: string;
      try {
        key = canonicalPath(path, false);
      } catch {
        return `Invalid checksum path: ${path}`;
      }
      const staged = files.get(path);
      if (!staged || path === "checksums.sha256") return `Checksum entry missing file: ${path}`;
      if (raw.has(path) || canonical.has(key)) return `Duplicate checksum path: ${path}`;
      if (++rows > maxRows) return "Checksum manifest has too many rows";
      raw.add(path);
      canonical.add(key);
      expected.set(path, expectedHash);
      const actual = await digest(staged.path);
      return actual === expectedHash
        ? undefined
        : `Checksum mismatch for ${path}: expected ${expectedHash}, got ${actual}`;
    };
    for await (const chunk of createReadStream(file.path, {
      fd: handle.fd,
      autoClose: false,
      highWaterMark: CHECKSUM_LINE_LIMIT,
    })) {
      checksumHash.update(chunk);
      carry = Buffer.concat([carry, chunk]);
      if (carry.length > CHECKSUM_LINE_LIMIT && !carry.includes(10))
        return {
          errors: ["Malformed checksum record"],
          expected,
          observed: checksumHash.digest("hex"),
        };
      let newline;
      while ((newline = carry.indexOf(10)) >= 0) {
        const error = await process(carry.subarray(0, newline));
        if (error) return { errors: [error], expected, observed: checksumHash.digest("hex") };
        carry = carry.subarray(newline + 1);
      }
    }
    if (carry.length) {
      const error = await process(carry);
      if (error) return { errors: [error], expected, observed: checksumHash.digest("hex") };
    }
  } finally {
    await handle.close().catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EBADF") throw error;
    });
  }
  for (const path of files.keys())
    if (path !== "checksums.sha256" && !raw.has(path))
      return {
        errors: [`Missing checksum for ${path}`],
        expected,
        observed: checksumHash.digest("hex"),
      };
  return { errors: [], expected, observed: checksumHash.digest("hex") };
}

export async function verifyStagedArchive(
  archive: string,
  root: string,
  options: { collectPaths?: boolean; restoreEntries?: boolean } = {},
): Promise<{
  files: number;
  manifest?: Buffer;
  checksumErrors: string[];
  paths?: string[];
  restoreEntries?: RestoreEntry[];
}> {
  const staging = join(root, "staging");
  await mkdir(staging, { mode: 0o700 });
  await chmod(staging, 0o700);
  await tar.extract({
    file: archive,
    cwd: staging,
    strict: true,
    preserveOwner: false,
    noMtime: true,
    maxDepth: 64,
    preservePaths: false,
  });
  const files = await inventory(staging);
  const manifest = files.get("manifest.json");
  const manifestBytes = manifest && (await readControlFile(manifest));
  const checksum = files.get("checksums.sha256");
  const checked = checksum
    ? await verifyChecksums(checksum, files)
    : { errors: ["Missing checksums.sha256"], expected: new Map<string, string>(), observed: "" };
  const scientificCasErrors =
    checked.errors.length === 0 ? await verifyScientificCas(files, manifestBytes) : [];
  return {
    files: files.size,
    manifest: manifestBytes,
    checksumErrors: [...checked.errors, ...scientificCasErrors],
    ...(options.collectPaths ? { paths: Array.from(files.keys()).sort() } : {}),
    ...(options.restoreEntries && !checked.errors.length && !scientificCasErrors.length
      ? {
          restoreEntries: Array.from(files, ([path, file]) => ({
            path,
            stagedPath: file.path,
            size: file.size,
            expectedDigest:
              path === "checksums.sha256" ? checked.observed : checked.expected.get(path)!,
          })).sort((a, b) => a.path.localeCompare(b.path)),
        }
      : {}),
  };
}
