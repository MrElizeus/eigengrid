import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { ToolContext } from "@eigengrid/tool-registry";
import {
  inspectProtocolTool,
  listProtocolsTool,
  validateMdProtocolTool,
} from "./scientific-catalog-tools";

import { makeInput } from "../../../../packages/protocol-core/src/md-fixtures";

const context = {} as ToolContext;

describe("scientific catalog tools", () => {
  it("reports the validated repository protocol inventory", async () => {
    const result = await listProtocolsTool.execute(context, { limit: 100 });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      totalCapabilities: 15,
      totalProtocolCapabilities: 15,
      totalProtocolAssets: 15,
      matched: 15,
      returned: 15,
    });
  });

  it("supports accented Spanish scientific searches and preserves exact-ID ranking", async () => {
    const spanish = await listProtocolsTool.execute(context, { query: "optimización geometría" });
    expect(spanish.ok).toBe(true);
    expect(spanish.data?.matched).toBeGreaterThan(0);
    const exact = await listProtocolsTool.execute(context, {
      query: "workflows.geometry-optimization",
    });
    expect(exact.data?.protocols[0]?.id).toBe("workflows.geometry-optimization");
  });

  it("explains empty filtered results without claiming that the installed catalog is empty", async () => {
    const result = await listProtocolsTool.execute(context, {
      query: "zzqxvnevermatcheszz",
      engine: "nonexistent-engine",
    });
    expect(result.data).toMatchObject({
      matched: 0,
      returned: 0,
      protocols: [],
      totalProtocolCapabilities: 15,
    });
    expect(result.data?.availableEngines).toContain("orca");
    expect(result.data?.availableDomains.length).toBeGreaterThan(0);
    expect(result.data?.searchHint).toContain("Omit filters");
  });

  it("filters protocols by engine and inspects exact canonical assets", async () => {
    const listed = await listProtocolsTool.execute(context, { engine: "orca", limit: 100 });
    expect(listed.ok).toBe(true);
    expect(listed.data?.protocols.length).toBeGreaterThan(0);
    expect(listed.data?.protocols.every((protocol) => protocol.engines.includes("orca"))).toBe(
      true,
    );

    const inspected = await inspectProtocolTool.execute(context, {
      id: "workflows.geometry-optimization",
      assetKinds: ["protocols"],
    });
    expect(inspected.ok).toBe(true);
    expect(inspected.data?.protocol.id).toBe("workflows.geometry-optimization");
    expect(inspected.data?.fragments[0]?.relativePath).toBe("protocols/core.yaml");
    expect(inspected.data?.fragments[0]?.content).toContain(
      "workflows.geometry-optimization.optimize-molecular-geometry",
    );
  });
});

describe("scientific protocol review tools", () => {
  it("loads required dependencies and reconstructs every paginated fragment with its exact digest", async () => {
    const chunks = new Map<string, { content: string; digest: string }>();
    let cursor: { fragment: number; character: number } | undefined;
    let corpusDigest: string | undefined;
    let pages = 0;
    do {
      const result = await inspectProtocolTool.execute(context, {
        id: "workflows.geometry-optimization",
        includeDependencies: true,
        assetKinds: ["summary", "protocols", "validation"],
        maxCharacters: 1000,
        cursor,
        corpusDigest,
      });
      expect(result.ok).toBe(true);
      const data = result.data!;
      expect(data.resolvedSkills.map((s) => s.id)).toContain("methods.molecular-dft");
      expect(data.fragments.reduce((n, f) => n + f.content.length, 0)).toBeLessThanOrEqual(1000);
      corpusDigest ??= data.corpusDigest;
      expect(data.corpusDigest).toBe(corpusDigest);
      for (const fragment of data.fragments) {
        const previous = chunks.get(fragment.fragmentId) ?? {
          content: "",
          digest: fragment.digest,
        };
        expect(previous.content.length).toBe(fragment.characterOffset);
        expect(previous.digest).toBe(fragment.digest);
        previous.content += fragment.content;
        chunks.set(fragment.fragmentId, previous);
      }
      cursor = data.nextCursor ?? undefined;
      expect(++pages).toBeLessThan(100);
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    for (const chunk of chunks.values())
      expect(createHash("sha256").update(chunk.content).digest("hex")).toBe(chunk.digest);
    const stale = await inspectProtocolTool.execute(context, {
      id: "workflows.geometry-optimization",
      corpusDigest: "stale",
    });
    expect(stale.ok).toBe(false);
    const invalid = await inspectProtocolTool.execute(context, {
      id: "workflows.geometry-optimization",
      cursor: { fragment: 99999, character: 0 },
    });
    expect(invalid.ok).toBe(false);
  });
  it("exposes decision and validation evidence without execution authority", async () => {
    const result = await inspectProtocolTool.execute(context, {
      id: "validation.minimum-validation",
    });
    expect(result.ok).toBe(true);
    expect(result.data?.fragments.some((item) => item.relativePath.startsWith("validation/"))).toBe(
      true,
    );
    expect(
      result.data?.fragments.some((item) => item.relativePath.startsWith("decision-rules/")),
    ).toBe(true);
  });
  it("rejects a changed digest and malformed protocol, and never authorizes execution", async () => {
    const protocol = makeInput().protocol;
    const valid = await validateMdProtocolTool.execute(context, { protocol });
    expect(valid.data).toMatchObject({ valid: true, executionAuthorized: false });
    const changed = await validateMdProtocolTool.execute(context, {
      protocol: { ...protocol, protocolDigest: "f".repeat(64) },
    });
    expect(changed.data).toMatchObject({ valid: false, executionAuthorized: false });
    const malformed = await validateMdProtocolTool.execute(context, { protocol: { stages: [] } });
    expect(malformed.data?.valid).toBe(false);
    expect(malformed.data?.issues.length).toBeGreaterThan(0);
  });
});
