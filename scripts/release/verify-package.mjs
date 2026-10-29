import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { list } from "tar";

export const BINARY_NAMES = [
  "eigengrid",
  "eigengrid-head",
  "eigengrid-worker",
  "eigengrid-amber-runner",
  "eigengrid-amber-library-digest",
  "eigengrid-submit-backend",
];
const CORPUS = "share/eigengrid/scientific-skills";
const fail = (message) => {
  throw new Error(message);
};

export async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

function validPath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    ![...path].some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    ) &&
    !/\.(?:log|pyc|sqlite|sqlite-shm|sqlite-wal)$/iu.test(path) &&
    path.split("/").every((part) => part && part !== "." && part !== ".." && !part.startsWith("."))
  );
}

function allowedPath(path) {
  return (
    path === "LICENSE" ||
    path === "distribution.json" ||
    BINARY_NAMES.some((name) => path === `bin/${name}`) ||
    path.startsWith(`${CORPUS}/`) ||
    path.startsWith("notices/") ||
    /^python\/eigengrid_chem-[A-Za-z0-9_.]+-py3-none-any\.whl$/u.test(path)
  );
}

export async function inventoryDirectory(root) {
  const paths = [];
  function walk(directory, prefix = "") {
    for (const name of readdirSync(directory).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (!validPath(path)) fail(`Unsafe distribution path: ${path}`);
      const stat = lstatSync(join(root, path));
      if (stat.isDirectory()) walk(join(root, path), path);
      else if (stat.isFile() && stat.nlink === 1) paths.push({ path, stat });
      else fail(`Distribution requires ordinary files without links: ${path}`);
    }
  }
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
    fail("Distribution root must be an ordinary directory");
  walk(root);
  const files = [];
  for (const { path, stat } of paths.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )) {
    files.push({
      path,
      sizeBytes: stat.size,
      mode: stat.mode & 0o777,
      sha256: await hashFile(join(root, path)),
    });
  }
  return files;
}

function validateInventory(files) {
  if (!Array.isArray(files) || !files.length || files.length > 100_000)
    fail("Missing or excessive file inventory");
  let previous = "";
  for (const file of files) {
    if (
      !file ||
      !validPath(file.path) ||
      !allowedPath(file.path) ||
      file.path <= previous ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes <= 0 ||
      !/^[a-f0-9]{64}$/u.test(file.sha256) ||
      ![0o644, 0o755].includes(file.mode)
    )
      fail(`Invalid file inventory: ${file?.path}`);
    previous = file.path;
  }
}

function sameInventory(left, right) {
  return (
    left.length === right.length &&
    left.every((file, index) => {
      const other = right[index];
      return (
        file.path === other.path &&
        file.sizeBytes === other.sizeBytes &&
        file.mode === other.mode &&
        file.sha256 === other.sha256
      );
    })
  );
}

export function validatePayload(distribution, files) {
  validateInventory(files);
  if (
    distribution.name !== "eigengrid" ||
    distribution.platform !== "linux-x64" ||
    distribution.qualification !== "software-candidate" ||
    !/^\d+\.\d+\.\d+-rc\.\d+$/u.test(distribution.version) ||
    !/^[a-f0-9]{40}$/u.test(distribution.sourceCommit) ||
    !Number.isSafeInteger(distribution.sourceDateEpoch) ||
    distribution.sourceDateEpoch <= 0 ||
    distribution.scientificSkills !== CORPUS ||
    JSON.stringify(distribution.binaries) !== JSON.stringify(BINARY_NAMES)
  )
    fail("Invalid software-candidate distribution metadata");
  validateInventory(distribution.files);
  const payload = files.filter((file) => file.path !== "distribution.json");
  if (!sameInventory(payload, distribution.files))
    fail("Distribution differs from its build inventory");
  for (const name of BINARY_NAMES) {
    const file = files.find((entry) => entry.path === `bin/${name}`);
    if (!file || file.mode !== 0o755 || file.sizeBytes < 64)
      fail(`Missing or invalid executable: ${name}`);
  }
  if (
    files.some((file) => file.path.startsWith("bin/") && !BINARY_NAMES.includes(file.path.slice(4)))
  )
    fail("Unexpected executable");
  if (
    !files.some((file) => file.path.startsWith(`${CORPUS}/`) && file.path.endsWith("/skill.yaml"))
  )
    fail("Missing scientific corpus");
  const wheels = files.filter((file) => file.path.startsWith("python/"));
  if (
    wheels.length !== 1 ||
    wheels[0].path !==
      `python/eigengrid_chem-${distribution.version.replace("-rc.", "rc")}-py3-none-any.whl`
  )
    fail("Expected exactly one version-matched Python wheel");
  if (!files.some((file) => file.path === "notices/components.cdx.json"))
    fail("Missing component inventory");
  if (!files.some((file) => file.path === "LICENSE")) fail("Missing license");
  return files;
}

export async function inspectDistribution(root) {
  const files = await inventoryDirectory(root);
  const distribution = JSON.parse(readFileSync(join(root, "distribution.json"), "utf8"));
  validatePayload(distribution, files);
  const sbom = JSON.parse(readFileSync(join(root, "notices/components.cdx.json"), "utf8"));
  if (
    sbom.bomFormat !== "CycloneDX" ||
    !Array.isArray(sbom.components) ||
    !sbom.components.length ||
    sbom.metadata?.component?.version !== distribution.version
  )
    fail("Invalid or stale component inventory");
  for (const name of BINARY_NAMES) {
    const descriptor = Buffer.alloc(20);
    const fd = openSync(join(root, "bin", name), "r");
    try {
      if (
        readSync(fd, descriptor) !== descriptor.length ||
        descriptor.subarray(0, 4).toString("hex") !== "7f454c46" ||
        descriptor[4] !== 2 ||
        descriptor[5] !== 1 ||
        descriptor.readUInt16LE(18) !== 62
      )
        fail(`Not a Linux x64 executable: ${name}`);
    } finally {
      closeSync(fd);
    }
  }
  return { distribution, files };
}

export async function verifyPackage(archive, { source } = {}) {
  const archiveName = basename(archive);
  const checksumPath = join(resolve(archive, ".."), "SHA256SUMS");
  const checksumLines = readFileSync(checksumPath, "utf8").trimEnd().split("\n");
  if (checksumLines.length !== 2)
    fail("Expected checksums for exactly the archive and release metadata");
  const expectedChecksum = checksumLines.find((line) => line.endsWith(`  ${archiveName}`));
  if (
    !expectedChecksum ||
    !/^[a-f0-9]{64}  [A-Za-z0-9._-]+$/u.test(expectedChecksum) ||
    checksumLines.filter((line) => line.endsWith(`  ${archiveName}`)).length !== 1 ||
    (await hashFile(archive)) !== expectedChecksum.slice(0, 64)
  )
    fail("Archive checksum mismatch");
  const gzipHeader = Buffer.alloc(10);
  const fd = openSync(archive, "r");
  try {
    if (
      readSync(fd, gzipHeader) !== 10 ||
      gzipHeader[0] !== 0x1f ||
      gzipHeader[1] !== 0x8b ||
      gzipHeader[2] !== 8 ||
      gzipHeader[3] !== 0 ||
      gzipHeader.readUInt32LE(4) !== 0
    )
      fail("Non-deterministic or invalid gzip header");
  } finally {
    closeSync(fd);
  }
  const seen = new Set();
  const files = [];
  const metadata = new Map();
  let top;
  let release;
  let previousPath = "";
  const completions = [];
  await list({
    file: archive,
    strict: true,
    onReadEntry(entry) {
      const path = entry.path.replace(/\/$/u, "");
      if (
        !validPath(path) ||
        seen.has(path) ||
        !["File", "Directory"].includes(entry.type) ||
        entry.linkpath
      )
        fail(`Unsafe or duplicate archive member: ${entry.path}`);
      if (path <= previousPath) fail("Archive member order is not deterministic");
      previousPath = path;
      seen.add(path);
      const parts = path.split("/");
      top ??= parts[0];
      if (parts[0] !== top) fail("Archive has multiple roots");
      if (entry.uid !== 0 || entry.gid !== 0 || entry.uname || entry.gname)
        fail("Archive ownership is not normalized");
      if (entry.atime !== undefined || entry.ctime !== undefined)
        fail("Archive contains access or change timestamps");
      metadata.set(path, { mtime: entry.mtime?.getTime(), mode: entry.mode });
      if (entry.type === "Directory") {
        if (entry.mode !== 0o755) fail("Invalid archive directory mode");
        entry.resume();
        return;
      }
      const relative = parts.slice(1).join("/");
      if (!relative || (!allowedPath(relative) && relative !== "release.json"))
        fail(`Unexpected archive file: ${relative}`);
      if (relative === "release.json" && entry.mode !== 0o644)
        fail("Invalid release metadata permissions");
      const hash = createHash("sha256");
      const chunks = [];
      let sizeBytes = 0;
      const capture = ["release.json", "distribution.json", "notices/components.cdx.json"].includes(
        relative,
      );
      completions.push(
        new Promise((resolveEntry, reject) => {
          entry.on("data", (bytes) => {
            sizeBytes += bytes.length;
            hash.update(bytes);
            if (capture) {
              if (sizeBytes > 32 * 1024 * 1024) {
                reject(new Error("Oversized release metadata"));
                return;
              }
              chunks.push(bytes);
            }
          });
          entry.on("error", reject);
          entry.on("end", () => {
            try {
              if (sizeBytes !== entry.size) fail(`Truncated archive member: ${relative}`);
              if (capture) {
                const bytes = Buffer.concat(chunks);
                metadata.set(relative, bytes);
                if (relative === "release.json") release = JSON.parse(bytes.toString("utf8"));
              }
              if (relative !== "release.json")
                files.push({
                  path: relative,
                  sizeBytes,
                  mode: entry.mode,
                  sha256: hash.digest("hex"),
                });
              resolveEntry();
            } catch (error) {
              reject(error);
            }
          });
        }),
      );
    },
  });
  await Promise.all(completions);
  if (
    !release ||
    release.schemaVersion !== "eigengrid.software-package/v1" ||
    release.qualification !== "software-candidate" ||
    top !== `eigengrid-${release.version}-linux-x64` ||
    archiveName !== `${top}.tar.gz`
  )
    fail("Invalid release identity");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const distribution = JSON.parse(metadata.get("distribution.json")?.toString("utf8") ?? "null");
  if (!distribution) fail("Missing distribution metadata");
  validatePayload(distribution, files);
  const sbom = JSON.parse(metadata.get("notices/components.cdx.json")?.toString("utf8") ?? "null");
  if (
    sbom?.bomFormat !== "CycloneDX" ||
    !Array.isArray(sbom.components) ||
    !sbom.components.length ||
    sbom.metadata?.component?.version !== distribution.version
  )
    fail("Invalid or stale archived component inventory");
  validateInventory(release.files);
  if (
    release.sourceCommit !== distribution.sourceCommit ||
    release.sourceDateEpoch !== distribution.sourceDateEpoch ||
    release.version !== distribution.version ||
    release.platform !== distribution.platform ||
    !sameInventory(release.files, files)
  )
    fail("Release inventory or provenance mismatch");
  const expectedBinaries = BINARY_NAMES.map((name) =>
    files.find((file) => file.path === `bin/${name}`),
  );
  if (
    !release.inventory ||
    !Array.isArray(release.inventory.binaries) ||
    !sameInventory(release.inventory.binaries, expectedBinaries) ||
    release.inventory.scientificCorpus?.path !== CORPUS ||
    release.inventory.scientificCorpus?.fileCount !==
      files.filter((file) => file.path.startsWith(`${CORPUS}/`)).length ||
    !sameInventory(
      [release.inventory.pythonWheel],
      files.filter((file) => file.path.startsWith("python/")),
    ) ||
    !sameInventory(
      [release.inventory.components],
      files.filter((file) => file.path === "notices/components.cdx.json"),
    )
  )
    fail("Release component inventory mismatch");
  for (const [path, value] of metadata) {
    if (!Buffer.isBuffer(value) && value.mtime !== release.sourceDateEpoch * 1000)
      fail(`Archive timestamp differs from source commit: ${path}`);
  }
  const externalRelease = readFileSync(join(resolve(archive, ".."), "release.json"));
  if (!externalRelease.equals(metadata.get("release.json")))
    fail("External release metadata mismatch");
  const releaseChecksum = checksumLines.find((line) => line.endsWith("  release.json"));
  if (
    releaseChecksum !==
    `${createHash("sha256").update(externalRelease).digest("hex")}  release.json`
  )
    fail("Release metadata checksum mismatch");
  if (source) {
    const actual = await inspectDistribution(resolve(source));
    if (!sameInventory(actual.files, files)) fail("Source distribution differs from archive");
  }
  return release;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (!args[0] || (args.length !== 1 && (args.length !== 3 || args[1] !== "--source")))
      fail(
        "Usage: node scripts/release/verify-package.mjs <archive.tar.gz> [--source <distribution>]",
      );
    const release = await verifyPackage(resolve(args[0]), { source: args[2] });
    console.log(
      `Verified ${release.version}, source ${release.sourceCommit}, ${release.files.length} files (software-candidate)`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
