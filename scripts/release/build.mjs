import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  chmodSync,
} from "node:fs";
import { resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../../", import.meta.url));
execFileSync(
  process.env.EIGENGRID_RELEASE_PYTHON ?? "python",
  ["scripts/release/scan.py", "--public", "."],
  {
    cwd: root,
    stdio: "inherit",
  },
);
const destination = resolve(process.argv[2] ?? join(root, "dist/native"));
if (existsSync(destination)) throw new Error(`Build destination already exists: ${destination}`);
if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("The native distribution currently supports Linux x64 only");
const version = JSON.parse(readFileSync(join(root, "apps/cli/package.json"), "utf8")).version;
if (execFileSync("bun", ["--version"], { encoding: "utf8" }).trim() !== "1.3.14")
  throw new Error("Native releases require the pinned Bun 1.3.14 compiler");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const sourceCommit = git("rev-parse", "HEAD");
if (
  !/^[a-f0-9]{40}$/.test(sourceCommit) ||
  git("status", "--porcelain", "--untracked-files=normal")
)
  throw new Error("Build the distribution from a clean, committed Git checkout");
const sourceDateEpoch = Number(git("log", "-1", "--format=%ct"));
if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch <= 0)
  throw new Error("A source commit timestamp is required for reproducible wheels");
process.env.SOURCE_DATE_EPOCH = String(sourceDateEpoch);
process.env.TZ = "UTC";
process.env.LC_ALL = "C";
const sbomPath = join(root, "notices/components.cdx.json");
const sbom = JSON.parse(readFileSync(sbomPath, "utf8"));
const lockDigest = createHash("sha256")
  .update(readFileSync(join(root, "bun.lock")))
  .digest("hex");
if (
  sbom.metadata?.component?.version !== version ||
  !sbom.metadata?.properties?.some(
    (item) => item.name === "eigengrid:bun-lock-sha256" && item.value === lockDigest,
  )
)
  throw new Error("Dependency inventory does not match this version and lockfile");
const binaries = [
  "eigengrid",
  "eigengrid-head",
  "eigengrid-worker",
  "eigengrid-amber-runner",
  "eigengrid-amber-library-digest",
  "eigengrid-submit-backend",
];
mkdirSync(join(destination, "bin"), { recursive: true });
for (const binary of binaries) {
  execFileSync(
    "bun",
    [
      "build",
      "--compile",
      "--target=bun-linux-x64",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--no-compile-autoload-tsconfig",
      "--no-compile-autoload-package-json",
      `--outfile=${join(destination, "bin", binary)}`,
      `apps/cli/bin/${binary}.ts`,
    ],
    { cwd: root, stdio: "inherit" },
  );
}
cpSync(join(root, "scientific-skills"), join(destination, "share/eigengrid/scientific-skills"), {
  recursive: true,
});
cpSync(join(root, "LICENSE"), join(destination, "LICENSE"));
cpSync(join(root, "notices"), join(destination, "notices"), { recursive: true });
const releasePython = process.env.EIGENGRID_RELEASE_PYTHON ?? "python";
execFileSync(
  releasePython,
  ["-m", "build", "--wheel", "--no-isolation", "--outdir", join(destination, "python"), "python"],
  { cwd: root, stdio: "inherit" },
);
const wheels = readdirSync(join(destination, "python")).filter((name) => name.endsWith(".whl"));
if (wheels.length !== 1) throw new Error("The Python build must produce exactly one wheel");
execFileSync(
  releasePython,
  [join(root, "scripts/release/normalize-wheel.py"), join(destination, "python", wheels[0])],
  { cwd: root, stdio: "inherit" },
);
const files = [];
function inventory(directory) {
  chmodSync(directory, 0o755);
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const observed = lstatSync(path);
    if (observed.isDirectory()) inventory(path);
    else if (observed.isFile() && !observed.isSymbolicLink()) {
      const entry = relative(destination, path).replaceAll("\\", "/");
      const mode = entry.startsWith("bin/") ? 0o755 : 0o644;
      chmodSync(path, mode);
      files.push({
        path: entry,
        sizeBytes: observed.size,
        mode,
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      });
    } else throw new Error(`Non-regular distribution entry: ${path}`);
  }
}
inventory(destination);
writeFileSync(
  join(destination, "distribution.json"),
  JSON.stringify(
    {
      name: "eigengrid",
      version,
      sourceCommit,
      sourceDateEpoch,
      platform: "linux-x64",
      binaries,
      scientificSkills: "share/eigengrid/scientific-skills",
      inference: "optional-external-provider",
      engines: "separately-installed",
      qualification: "software-candidate",
      files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    },
    null,
    2,
  ) + "\n",
);
chmodSync(join(destination, "distribution.json"), 0o644);
console.log(`Native distribution built in ${destination}`);
