import { describe, expect, test } from "bun:test";
import { digestCanonical } from "@eigengrid/scientific-schema";
import { JsonlEmbeddingProvider } from "./embedding-process";
import { unitVector } from "./vector-index";

const identity = {
  model: "synthetic-stdio-test",
  revision: "1",
  dimensions: 2,
  configurationDigest: digestCanonical({ test: true }),
};
const source = `process.stdin.setEncoding("utf8"); let buffer=""; process.stdin.on("data", (chunk) => { buffer+=chunk; let n; while((n=buffer.indexOf("\\n"))>=0){ const req=JSON.parse(buffer.slice(0,n)); buffer=buffer.slice(n+1); console.log(JSON.stringify({id:req.id,vectors:req.texts.map(()=>[3,4])})); }});`;

describe("local embedding process boundary", () => {
  test("serializes concurrent requests, checks cardinality and normalizes vectors", async () => {
    const provider = new JsonlEmbeddingProvider([process.execPath, "-e", source], identity);
    try {
      const [a, b] = await Promise.all([
        provider.embed(["a"], "query"),
        provider.embed(["b", "c"], "passage"),
      ]);
      expect(a).toEqual([[0.6, 0.8]]);
      expect(b).toEqual([
        [0.6, 0.8],
        [0.6, 0.8],
      ]);
    } finally {
      provider.close();
    }
    await expect(provider.embed(["closed"], "query")).rejects.toThrow("closed");
  });
  test("terminates hung workers with a bounded timeout", async () => {
    const provider = new JsonlEmbeddingProvider(
      [process.execPath, "-e", "process.stdin.resume()"],
      identity,
      100,
    );
    try {
      await expect(provider.embed(["query"], "query")).rejects.toThrow("timed out");
    } finally {
      provider.close();
    }
  });
  test.each([
    "not-json",
    '{"id":999,"vectors":[[3,4]]}',
    '{"id":1,"vectors":[]}',
    '{"id":1,"vectors":[[0,0]]}',
    '{"id":1,"vectors":[[1,0,0]]}',
  ])("rejects an invalid worker response: %s", async (response) => {
    const program = `process.stdin.once("data",()=>console.log(${JSON.stringify(response)}));`;
    const provider = new JsonlEmbeddingProvider([process.execPath, "-e", program], identity);
    try {
      await expect(provider.embed(["query"], "query")).rejects.toThrow();
    } finally {
      provider.close();
    }
  });
  test("rejects unbounded input and invalid floating point vectors", async () => {
    const provider = new JsonlEmbeddingProvider([process.execPath, "-e", source], identity);
    try {
      await expect(provider.embed(["x".repeat(8001)], "query")).rejects.toThrow("limits");
    } finally {
      provider.close();
    }
    expect(() => unitVector([Number.NaN, 1], 2)).toThrow();
    expect(() => unitVector([Number.MAX_VALUE, Number.MAX_VALUE], 2)).toThrow();
  });
});
