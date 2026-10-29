import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const archiveName = "eigengrid-1.0.0-rc.2-linux-x64.tar.gz";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let root;
let input;
let originalPackage;
let sourceDateEpoch;

function command(script, ...args) {
  return spawnSync("node", [join(root, "scripts/release", script), ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  });
}

function rewriteChecksums(directory) {
  writeFileSync(
    join(directory, "SHA256SUMS"),
    `${hash(readFileSync(join(directory, archiveName)))}  ${archiveName}\n${hash(readFileSync(join(directory, "release.json")))}  release.json\n`,
  );
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "eigengrid-package-contract-"));
  mkdirSync(join(root, "scripts/release"), { recursive: true });
  for (const script of ["package.mjs", "verify-package.mjs"])
    copyFileSync(
      join(sourceRoot, "scripts/release", script),
      join(root, "scripts/release", script),
    );
  symlinkSync(join(sourceRoot, "node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ type: "module", version: "1.0.0-rc.2" }),
  );
  writeFileSync(join(root, ".gitignore"), "dist/\nnode_modules/\n");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Package Test",
    "-c",
    "user.email=package-test@invalid",
    "commit",
    "-qm",
    "Contract fixture",
  );
  const sourceCommit = git("rev-parse", "HEAD");
  sourceDateEpoch = Number(git("show", "-s", "--format=%ct", "HEAD"));
  input = join(root, "dist/native");
  const files = [];
  function put(path, bytes, mode = 0o644) {
    const destination = join(input, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
    chmodSync(destination, mode);
    files.push({ path, sizeBytes: Buffer.byteLength(bytes), mode, sha256: hash(bytes) });
  }
  // Contract-only bytes: these are not runnable executables, a scientific corpus or an installable wheel.
  const elf = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(elf);
  elf.writeUInt16LE(62, 18);
  const binaries = [
    "eigengrid",
    "eigengrid-head",
    "eigengrid-worker",
    "eigengrid-amber-runner",
    "eigengrid-amber-library-digest",
    "eigengrid-submit-backend",
  ];
  for (const name of binaries) put(`bin/${name}`, elf, 0o755);
  put("LICENSE", "MIT contract fixture\n");
  put("share/eigengrid/scientific-skills/contract/skill.yaml", "scope: contract-only\n");
  put(
    "python/eigengrid_chem-1.0.0rc2-py3-none-any.whl",
    Buffer.from("PK\x03\x04contract-only wheel bytes"),
  );
  put(
    "notices/components.cdx.json",
    JSON.stringify({
      bomFormat: "CycloneDX",
      metadata: { component: { version: "1.0.0-rc.2" } },
      components: [{ name: "contract-fixture", version: "1" }],
    }),
  );
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  put(
    "distribution.json",
    JSON.stringify({
      name: "eigengrid",
      version: "1.0.0-rc.2",
      sourceCommit,
      sourceDateEpoch,
      platform: "linux-x64",
      qualification: "software-candidate",
      scientificSkills: "share/eigengrid/scientific-skills",
      binaries,
      files: [...files],
    }),
  );
  originalPackage = join(root, "dist/original");
  const result = command("package.mjs", input, originalPackage);
  expect(result.status, result.stderr).toBe(0);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("native package contract", () => {
  test("archive bytes remain identical across different filesystem timestamp seconds", async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = join(root, "dist/second");
    const result = command("package.mjs", input, second);
    expect(result.status, result.stderr).toBe(0);
    const firstBytes = readFileSync(join(originalPackage, archiveName));
    expect(readFileSync(join(second, archiveName)).equals(firstBytes)).toBe(true);
    // Inspect the raw USTAR header independently of the package verifier.
    const tar = gunzipSync(firstBytes);
    expect(Number.parseInt(tar.subarray(108, 116).toString("ascii"), 8)).toBe(0);
    expect(Number.parseInt(tar.subarray(116, 124).toString("ascii"), 8)).toBe(0);
    expect(Number.parseInt(tar.subarray(136, 148).toString("ascii"), 8)).toBe(sourceDateEpoch);
    expect(tar.subarray(476, 500).every((byte) => byte === 0)).toBe(true);
    const existing = command("package.mjs", input, second);
    expect(existing.status).not.toBe(0);
    expect(readFileSync(join(second, archiveName)).equals(firstBytes)).toBe(true);
  });

  test("rejects access time in a valid TAR even when external checksums are recomputed", () => {
    const changed = join(root, "dist/changed-time");
    cpSync(originalPackage, changed, { recursive: true });
    const tar = gunzipSync(readFileSync(join(changed, archiveName)));
    tar.write("00000000001\0", 476, "ascii");
    tar.fill(32, 148, 156);
    const checksum = tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
    tar.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    writeFileSync(join(changed, archiveName), gzipSync(tar, { level: 9 }));
    rewriteChecksums(changed);
    const result = command("verify-package.mjs", join(changed, archiveName));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Archive contains access or change timestamps");
  });

  test("rejects truncated executable, corpus, wheel and component inventory before publication", () => {
    for (const path of [
      "bin/eigengrid",
      "share/eigengrid/scientific-skills/contract/skill.yaml",
      "python/eigengrid_chem-1.0.0rc2-py3-none-any.whl",
      "notices/components.cdx.json",
    ]) {
      const file = join(input, path);
      const bytes = readFileSync(file);
      const destination = join(root, "dist/corrupted");
      try {
        writeFileSync(file, bytes.subarray(0, bytes.length - 1));
        const result = command("package.mjs", input, destination);
        expect(result.status, path).not.toBe(0);
        expect(result.stderr, path).toContain("Distribution differs from its build inventory");
        expect(existsSync(destination)).toBe(false);
      } finally {
        writeFileSync(file, bytes);
      }
    }
  });
});
