import { readdirSync, readFileSync, writeFileSync, mkdirSync, lstatSync, cpSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(process.argv[2] ?? ".");
const pythonReport = process.argv[3];
if (!pythonReport)
  throw new Error("Usage: node scripts/release/notices.mjs <source-root> <pip-install-report>");
const target = join(root, "notices");
mkdirSync(target, { recursive: true });
const components = new Map();
const runtimeNotice = JSON.parse(readFileSync(join(target, "bun@1.3.14/SOURCE.json"), "utf8"));
components.set("runtime:bun", {
  type: "framework",
  name: "bun",
  version: runtimeNotice.version,
  purl: `pkg:generic/bun@${runtimeNotice.version}`,
  licenses: [
    { license: { name: "Bun MIT and upstream linked-library terms; see included notice" } },
  ],
  externalReferences: [{ type: "license", url: runtimeNotice.source }],
  properties: [{ name: "eigengrid:license-files", value: "bun@1.3.14/LICENSE.md" }],
});
function readPackage(path) {
  const metadata = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  if (!metadata.name || !metadata.version || metadata.name.startsWith("@eigengrid/")) return;
  const key = `${metadata.name}@${metadata.version}`;
  if (components.has(key)) return;
  const directory = key.replaceAll("/", "_");
  const licenses = readdirSync(path).filter(
    (name) =>
      /^(license|licence|notice|copying)(\.|$)/i.test(name) && lstatSync(join(path, name)).isFile(),
  );
  mkdirSync(join(target, directory), { recursive: true });
  for (const name of licenses) cpSync(join(path, name), join(target, directory, name));
  const declared = typeof metadata.license === "string" ? metadata.license : metadata.license?.type;
  if (declared === "UNLICENSED" || (!declared && licenses.length === 0))
    throw new Error(`Missing redistributable license: ${key}`);
  components.set(key, {
    type: "library",
    name: metadata.name,
    version: metadata.version,
    purl: `pkg:npm/${metadata.name.replace("@", "%40")}@${metadata.version}`,
    licenses: [{ license: { name: declared ?? "See included license text" } }],
    properties: [
      {
        name: "eigengrid:license-files",
        value: licenses.map((name) => `${directory}/${name}`).join(","),
      },
    ],
  });
}
const modules = join(root, "node_modules/.bun");
for (const entry of readdirSync(modules).sort()) {
  if (entry === "node_modules" || !lstatSync(join(modules, entry)).isDirectory()) continue;
  const nested = join(modules, entry, "node_modules");
  for (const name of readdirSync(nested)) {
    if (name.startsWith(".")) continue;
    const path = join(nested, name);
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) continue;
    if (name.startsWith("@")) {
      for (const child of readdirSync(path))
        if (!lstatSync(join(path, child)).isSymbolicLink()) readPackage(join(path, child));
    } else readPackage(path);
  }
}
for (const dependency of JSON.parse(readFileSync(pythonReport, "utf8")).install) {
  const m = dependency.metadata;
  const license =
    m.license_expression ??
    m.license ??
    m.classifier?.filter((x) => x.startsWith("License ::")).join("; ");
  if (!license) throw new Error(`Missing Python license: ${m.name}`);
  components.set(`python:${m.name}`, {
    type: "library",
    name: m.name,
    version: m.version,
    purl: `pkg:pypi/${m.name.toLowerCase().replaceAll("_", "-")}@${m.version}`,
    hashes: [{ alg: "SHA-256", content: dependency.download_info.archive_info.hashes.sha256 }],
    licenses: [{ license: { name: license } }],
  });
}
const lockDigest = createHash("sha256")
  .update(readFileSync(join(root, "bun.lock")))
  .digest("hex");
writeFileSync(
  join(target, "components.cdx.json"),
  JSON.stringify(
    {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      version: 1,
      metadata: {
        component: {
          type: "application",
          name: "eigengrid",
          version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
        },
        properties: [{ name: "eigengrid:bun-lock-sha256", value: lockDigest }],
      },
      components: [...components.values()].sort((a, b) => a.purl.localeCompare(b.purl)),
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Recorded ${components.size} installed components and available JavaScript license texts`,
);
