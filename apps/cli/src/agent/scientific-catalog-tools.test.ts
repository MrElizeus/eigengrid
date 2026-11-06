import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryScientificSkillsRoot } from "@eigengrid/scientific-skills";
import publication from "../../../../publication.json";
import type { ToolContext } from "@eigengrid/tool-registry";
import {
  inspectProtocolTool,
  listProtocolsTool,
  validateMdProtocolTool,
} from "./scientific-catalog-tools";

import { makeInput } from "../../../../packages/protocol-core/src/md-fixtures";

const context = {} as ToolContext;
const catalogSize = publication.catalogSkillIds.length;

describe("scientific catalog tools", () => {
  it("invalidates same-directory catalog edits and rejects a previously pinned inspection cursor", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "eigengrid-catalog-cache-"));
    const original = process.env.EIGENGRID_SCIENTIFIC_SKILLS_ROOT;
    cpSync(
      join(repositoryScientificSkillsRoot(), "workflows/gimic-ring-currents"),
      join(temporary, "gimic"),
      { recursive: true },
    );
    process.env.EIGENGRID_SCIENTIFIC_SKILLS_ROOT = temporary;
    try {
      const first = await listProtocolsTool.execute(context, {});
      expect(first.ok).toBe(true);
      appendFileSync(
        join(temporary, "gimic/SKILL.md"),
        "\n\n## Cache regression fixture\nSynthetic catalog revision for cache testing.\n",
      );
      const second = await listProtocolsTool.execute(context, {});
      expect(second.ok).toBe(true);
      expect(second.data!.corpusDigest).not.toBe(first.data!.corpusDigest);
      const inspection = await inspectProtocolTool.execute(context, {
        id: "workflows.gimic-ring-currents",
        corpusDigest: first.data!.corpusDigest,
      });
      expect(inspection.ok).toBe(false);
      expect(inspection.error?.message).toContain("changed");
    } finally {
      if (original === undefined) delete process.env.EIGENGRID_SCIENTIFIC_SKILLS_ROOT;
      else process.env.EIGENGRID_SCIENTIFIC_SKILLS_ROOT = original;
      rmSync(temporary, { recursive: true, force: true });
    }
  });
  it("reports the validated repository protocol inventory", async () => {
    const result = await listProtocolsTool.execute(context, { limit: 100 });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      totalCapabilities: catalogSize,
      totalProtocolCapabilities: catalogSize,
      totalProtocolAssets: catalogSize,
      matched: catalogSize,
      returned: catalogSize,
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

  it("retrieves DFT decisions in Spanish and exposes their pinned evidence", async () => {
    const cases = [
      [
        "Falta una energía del dímero con centros fantasma. ¿Puedo reportar la interacción?",
        "workflows.counterpoise-interaction",
      ],
      [
        "¿Cómo combino las poblaciones de varios confórmeros a 1 M?",
        "workflows.solution-conformer-free-energy",
      ],
      [
        "¿Cómo identifico qué mínimos conecta el estado de transición?",
        "workflows.transition-state-irc",
      ],
      [
        "¿Cómo reviso la segunda reducción frente al electrodo de referencia?",
        "workflows.solution-redox",
      ],
      [
        "¿Puedo asignar la banda de absorción a partir del espectro calculado?",
        "workflows.tddft-absorption",
      ],
      [
        "Tengo una frecuencia imaginaria. ¿Ya puedo reportar la barrera?",
        "diagnostics.imaginary-frequencies",
      ],
    ] as const;
    for (const [query, expected] of cases) {
      const listed = await listProtocolsTool.execute(context, { query, limit: 3 });
      expect(listed.data?.protocols.map((protocol) => protocol.id)).toContain(expected);
    }
    const listed = await listProtocolsTool.execute(context, {
      engine: "cp2k",
      query: "REL_CUTOFF",
      limit: 1,
    });
    const protocol = listed.data?.protocols[0];
    expect(protocol?.id).toBe("methods.cp2k-gpw-convergence");
    const inspected = await inspectProtocolTool.execute(context, {
      id: protocol!.id,
      version: protocol!.version,
      corpusDigest: listed.data!.corpusDigest,
      includeDependencies: true,
      assetKinds: ["protocols", "references"],
    });
    expect(inspected.data?.resolvedSkills.map((s) => s.id)).toContain(
      "methods.periodic-boundaries",
    );
    expect(inspected.data?.protocol.capabilityLevels.executable).toEqual({});
    expect(inspected.data?.fragments.some((f) => f.content.includes("REL_CUTOFF"))).toBe(true);
    expect(inspected.data?.fragments.some((f) => f.content.includes("10.1063/5.0007045"))).toBe(
      true,
    );
    const missing = await inspectProtocolTool.execute(context, {
      id: "workflows.counterpoise-interaction",
      version: "1.0.0",
      assetKinds: ["protocols"],
    });
    expect(missing.data?.fragments.some((f) => f.content.includes("missing ghost term"))).toBe(
      true,
    );
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
      totalProtocolCapabilities: catalogSize,
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
