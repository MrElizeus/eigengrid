import { expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installedScientificRetrieval } from "./installed";
import { fixtureRoot } from "./test-support";

test("same-path configuration and model changes invalidate the installed service cache", () => {
  const fixture = fixtureRoot();
  const previous = process.env.EIGENGRID_RETRIEVAL_CONFIG;
  const configPath = join(fixture.directory, "config.json");
  const manifestPath = join(fixture.directory, "model.json");
  const manifest = JSON.parse(
    readFileSync(
      new URL("../../../examples/retrieval/multilingual-e5-small.json", import.meta.url),
      "utf8",
    ),
  );
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(
    configPath,
    JSON.stringify({
      mode: "scientific",
      embeddings: { python: "python", manifest: "model.json" },
    }),
    { mode: 0o600 },
  );
  process.env.EIGENGRID_RETRIEVAL_CONFIG = configPath;
  try {
    const first = installedScientificRetrieval(fixture.root);
    expect(installedScientificRetrieval(fixture.root)).toBe(first);
    manifest.revision = "new-pinned-revision";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const changed = installedScientificRetrieval(fixture.root);
    expect(changed).not.toBe(first);
    expect(changed.status().embedding?.revision).toBe("new-pinned-revision");
    chmodSync(configPath, 0o666);
    expect(() => installedScientificRetrieval(fixture.root)).toThrow("not writable");
  } finally {
    if (previous === undefined) delete process.env.EIGENGRID_RETRIEVAL_CONFIG;
    else process.env.EIGENGRID_RETRIEVAL_CONFIG = previous;
    fixture.dispose();
  }
});
