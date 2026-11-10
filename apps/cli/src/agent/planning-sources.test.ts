import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry, type ToolContext } from "@eigengrid/tool-registry";
import { inspectSource, PlanningSources, publicAddress, publicSourceUrl } from "./planning-sources";

const directories: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "eigengrid-sources-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const ctx = {} as ToolContext;
function fixture(bytes = Buffer.from("example source"), root = directory()) {
  const sources = new PlanningSources(root, async (url) => ({
    url,
    contentType: "text/plain",
    bytes,
  }));
  const tools = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
  sources.register(tools);
  let id = 0;
  const call = (name: string, input: unknown) =>
    tools.settleAuthorized({ id: String(++id), name, input }, ctx);
  return { sources, call };
}

describe("planning source acquisition", () => {
  test("rejects local, private, mapped and transition addresses and credential URLs", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.1.1",
      "100.100.100.200",
      "169.254.169.254",
      "172.16.1.1",
      "192.168.1.1",
      "0.0.0.0",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fe80::1",
      "2002:7f00:1::",
      "2001::1",
      "2001:db8::1",
    ])
      expect(publicAddress(ip)).toBe(false);
    for (const ip of ["8.8.8.8", "2606:4700:4700::1111"]) expect(publicAddress(ip)).toBe(true);
    for (const url of [
      "http://example.org",
      "file:///tmp/input",
      "https://localhost",
      "https://127.1",
      "https://[::1]",
      "https://name:secret@example.org",
      "https://example.org:8080",
      "https://example.org?api_key=secret",
    ])
      expect(() => publicSourceUrl(url)).toThrow();
  });
  test("retains private bytes and provenance, reads exact content and rejects later modification", async () => {
    const f = fixture();
    expect(
      (await f.call("acquire-planning-asset", { url: "https://example.org/source.txt" })).ok,
    ).toBe(true);
    const asset = f.sources.assets[0];
    expect(statSync(asset.path).mode & 0o777).toBe(0o600);
    expect(statSync(asset.path + ".json").mode & 0o777).toBe(0o600);
    const read = await f.call("read-planning-asset", { id: asset.id });
    expect(read.output).toMatchObject({
      content: "example source",
      nextOffset: null,
      sha256: asset.sha256,
    });
    writeFileSync(asset.path, "changed source");
    expect((await f.call("read-planning-asset", { id: asset.id })).ok).toBe(false);
    expect((await f.call("read-planning-asset", { id: "/etc/passwd" })).ok).toBe(false);
  });
  test("does not follow asset directory symlinks or retain oversized input", async () => {
    const root = directory(),
      target = directory();
    symlinkSync(target, join(root, ".eigengrid"));
    const linked = fixture(Buffer.from("text"), root);
    expect(
      (await linked.call("acquire-planning-asset", { url: "https://example.org/input" })).ok,
    ).toBe(false);
    const large = fixture(Buffer.alloc(20 * 1024 * 1024 + 1));
    expect(
      (await large.call("acquire-planning-asset", { url: "https://example.org/large" })).ok,
    ).toBe(false);
    expect(large.sources.assets).toHaveLength(0);
  });
  test("PDF acquisition does not pretend to read the article and PDB hetero atoms are not declared ligands", async () => {
    const f = fixture(Buffer.from("%PDF-1.7\nexample"));
    await f.call("acquire-planning-asset", { url: "https://example.org/article.pdf" });
    expect(f.sources.assets[0].observations.textExtracted).toBe(false);
    expect((await f.call("read-planning-asset", { id: f.sources.assets[0].id })).ok).toBe(false);
    const pdb = inspectSource(
      Buffer.from("HETATM    1  O   HOH A   1      1.000   2.000   3.000\n"),
    );
    expect(pdb.observations.heteroResidueNames).toEqual(["HOH"]);
    expect(pdb.observations.note).toContain("verify the requested ligand");
  });
});
