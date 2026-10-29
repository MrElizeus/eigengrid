import { describe, expect, test } from "bun:test";
import {
  ScientificEntityConflictError,
  ScientificIntegrityError,
} from "@eigengrid/mission-runtime";
import { CanonicalMdResultCollector } from "./md-result-collector";

type CollectorInput = ConstructorParameters<typeof CanonicalMdResultCollector>[0];

function collectorWhoseStoreReadFails(error: Error): CanonicalMdResultCollector {
  const unreachable = async (): Promise<never> => {
    throw new Error("Unexpected store call");
  };
  return new CanonicalMdResultCollector({
    database: {} as CollectorInput["database"],
    objects: {} as CollectorInput["objects"],
    siteAuthority: {} as CollectorInput["siteAuthority"],
    collectionStore: {
      get: async () => {
        throw error;
      },
      readAuthority: unreachable,
      adopt: unreachable,
    },
  });
}

describe("canonical MD result collection error boundary", () => {
  test("reports durable integrity and identity conflicts without adopting a result", async () => {
    for (const error of [
      new ScientificIntegrityError("secret path /private/result"),
      new ScientificEntityConflictError("observation", "md-collection-1"),
    ]) {
      const result = await collectorWhoseStoreReadFails(error).collect("operation-1");
      expect(result.status).toBe("conflict");
      expect(result).toEqual({
        status: "conflict",
        detail:
          "MD result collection found conflicting durable execution authority; no terminal result was adopted",
      });
      expect(JSON.stringify(result)).not.toContain("/private/result");
    }
  });

  test("keeps an unavailable store read pending and hides its exception text", async () => {
    const result = await collectorWhoseStoreReadFails(
      new Error("database unavailable at /private/socket"),
    ).collect("operation-1");
    expect(result).toEqual({
      status: "waiting",
      detail:
        "MD result collection awaits durable execution authority; no terminal result was adopted",
    });
    expect(JSON.stringify(result)).not.toContain("/private/socket");
  });
});
