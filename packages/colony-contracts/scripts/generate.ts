import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateArtifacts } from "../src/json-schema-artifacts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

for (const artifact of await generateArtifacts()) {
  const target = join(packageRoot, artifact.relativePath);
  await mkdir(dirname(target), { recursive: true });
  await Bun.write(target, artifact.content);
}
