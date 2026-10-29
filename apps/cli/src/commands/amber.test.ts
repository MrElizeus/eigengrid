import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import yargs from "yargs";
import { createAmberCommand, runAmberReview } from "./amber";
import type { openMissionApplication } from "../services/mission-composition";
type MissionSession = Awaited<ReturnType<typeof openMissionApplication>>;

const candidate = JSON.parse(
  readFileSync(
    new URL(
      "../../../../examples/amber/ace-ala-nme-explicit-cpu-v1.candidate.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const request = {
  candidate,
  options: {
    workspace: "prep",
    environmentDigest: "a".repeat(64),
    parameterLibraryDigest: "b".repeat(64),
  },
};

describe("Amber offline CLI", () => {
  test("renders reproducible preparation with candidate lineage and no authority grant", () => {
    const rendered = runAmberReview("prepare", request) as {
      input: { content: string };
      manifest: { candidate: { digest: string }; executionEligibility: string };
    };
    expect(rendered.input.content).toContain("sequence { ACE ALA NME }");
    expect(rendered.manifest.candidate.digest).toBe(candidate.candidateDigest);
    expect(rendered.manifest.executionEligibility).toBe(
      "requires_exact_scientific_and_site_authority",
    );
    expect(runAmberReview("prepare", request)).toEqual(rendered);
  });

  test("rejects unmodelled instructions, modified candidate and incomplete inspection", () => {
    expect(() => runAmberReview("prepare", { ...request, execute: true })).toThrow();
    expect(() =>
      runAmberReview("prepare", { ...request, options: { ...request.options, shell: "anything" } }),
    ).toThrow();
    const changed = structuredClone(request);
    changed.candidate.system.solvation.paddingAngstrom += 1;
    expect(() => runAmberReview("prepare", changed)).toThrow();
    expect(() => runAmberReview("inspect-preparation", request)).toThrow();
    expect(() => runAmberReview("inspect-analysis", {})).toThrow();
  });

  test("published schema describes exact request fields without opening runtime services", async () => {
    const outputs: unknown[] = [];
    const parser = yargs([])
      .command(createAmberCommand((value) => outputs.push(value)))
      .exitProcess(false);
    await parser.parseAsync(["amber", "schema", "prepare"]);
    const schema = outputs[0] as {
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
    expect(Object.keys(schema.properties)).toEqual(["candidate", "options"]);
    expect(schema.additionalProperties).toBe(false);
  });

  test("prepared-system import uses the configured mission authority and closes its session", async () => {
    const outputs: unknown[] = [];
    const calls: string[] = [];
    const session = {
      async importPreparedSystem(directory: string) {
        calls.push(directory);
        return { packageDigest: "c".repeat(64), systemManifestId: "fixture-system" };
      },
      async close() {
        calls.push("closed");
      },
    } as unknown as MissionSession;
    const parser = yargs([])
      .command(
        createAmberCommand(
          (value) => outputs.push(value),
          async () => session,
        ),
      )
      .exitProcess(false);
    await parser.parseAsync(["amber", "import-prepared-system", "/cluster/share/fixture-system"]);
    expect(calls).toEqual(["/cluster/share/fixture-system", "closed"]);
    expect(outputs).toEqual([
      { packageDigest: "c".repeat(64), systemManifestId: "fixture-system" },
    ]);
  });
});
