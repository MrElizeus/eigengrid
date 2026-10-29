import { execFileSync } from "node:child_process";
import {
  constants,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "tar";
import { BINARY_NAMES, hashFile, inspectDistribution, verifyPackage } from "./verify-package.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const input = resolve(process.argv[2] ?? join(root, "dist/native"));
const output = resolve(process.argv[3] ?? join(root, "dist/packages"));
if (process.argv.length > 4)
  throw new Error("Usage: node scripts/release/package.mjs [distribution] [output-directory]");
if (existsSync(output)) throw new Error(`Package destination already exists: ${output}`);
const { distribution, files } = await inspectDistribution(input);
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const sourceDateEpoch = Number(
  execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
);
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
if (
  distribution.sourceCommit !== sourceCommit ||
  distribution.sourceDateEpoch !== sourceDateEpoch ||
  distribution.version !== version
)
  throw new Error(
    "Build provenance differs from the current source commit or version; rebuild the distribution",
  );
if (
  execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: root,
    encoding: "utf8",
  }).trim()
)
  throw new Error("Commit source changes before producing a release package");
mkdirSync(dirname(output), { recursive: true });
const temporary = mkdtempSync(join(dirname(output), ".eigengrid-package-"));
try {
  const name = `eigengrid-${version}-linux-x64`;
  const staged = join(temporary, "payload", name);
  const products = join(temporary, "products");
  mkdirSync(staged, { recursive: true });
  mkdirSync(products);
  for (const file of files) {
    const target = join(staged, file.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(input, file.path), target, constants.COPYFILE_FICLONE);
  }
  const byPath = new Map(files.map((file) => [file.path, file]));
  const corpusFiles = files.filter((file) =>
    file.path.startsWith(`${distribution.scientificSkills}/`),
  );
  const release = {
    schemaVersion: "eigengrid.software-package/v1",
    name: "eigengrid",
    version,
    platform: distribution.platform,
    sourceCommit,
    sourceDateEpoch,
    qualification: "software-candidate",
    inventory: {
      binaries: BINARY_NAMES.map((binary) => byPath.get(`bin/${binary}`)),
      scientificCorpus: { path: distribution.scientificSkills, fileCount: corpusFiles.length },
      pythonWheel: files.find((file) => file.path.startsWith("python/")),
      components: byPath.get("notices/components.cdx.json"),
    },
    files,
  };
  const releaseBytes = JSON.stringify(release, null, 2) + "\n";
  writeFileSync(join(staged, "release.json"), releaseBytes, { flag: "wx" });
  chmodSync(join(staged, "release.json"), 0o644);
  writeFileSync(join(products, "release.json"), releaseBytes, { flag: "wx" });
  const archive = join(products, `${name}.tar.gz`);
  await create(
    {
      file: archive,
      cwd: staged,
      prefix: name,
      // tar's portable mode omits UID/GID; this archive records explicit numeric zeroes.
      portable: false,
      noPax: true,
      gzip: { level: 9, portable: true },
      mtime: new Date(sourceDateEpoch * 1000),
      onWriteEntry(entry) {
        entry.stat.uid = 0;
        entry.stat.gid = 0;
        entry.stat.atime = undefined;
        entry.stat.ctime = undefined;
        entry.myuser = "";
      },
    },
    [...files.map((file) => file.path), "release.json"].sort(),
  );
  writeFileSync(
    join(products, "SHA256SUMS"),
    `${await hashFile(archive)}  ${basename(archive)}\n${await hashFile(join(products, "release.json"))}  release.json\n`,
    { flag: "wx" },
  );
  await verifyPackage(archive, { source: input });
  const after = await inspectDistribution(input);
  if (JSON.stringify(after.files) !== JSON.stringify(files))
    throw new Error("Distribution changed during packaging");
  if (
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() !==
      sourceCommit ||
    execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
      cwd: root,
      encoding: "utf8",
    }).trim()
  )
    throw new Error("Source changed during packaging");
  if (existsSync(output))
    throw new Error(`Package destination appeared during packaging: ${output}`);
  renameSync(products, output);
  console.log(`Verified software-candidate package: ${join(output, basename(archive))}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
