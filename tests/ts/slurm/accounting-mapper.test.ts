import { describe, expect, test } from "bun:test";
import { parseSacctOutput, parseSinfoNodes, parseSinfoPartitions } from "@eigengrid/slurm";

describe("parseSacctOutput", () => {
  test("parses a single job row", () => {
    expect(parseSacctOutput("123456|COMPLETED|0:0|01:23:45|123456K|8Gn|1|8")).toEqual([
      {
        jobId: "123456",
        state: "COMPLETED",
        exitCode: 0,
        elapsed: "01:23:45",
        maxRss: "123456K",
        reqMem: "8Gn",
        nNodes: 1,
        nCpus: 8,
      },
    ]);
  });

  test("parses multiple rows", () => {
    expect(
      parseSacctOutput(
        [
          "123456|COMPLETED|0:0|01:23:45|123456K|8Gn|1|8",
          "123457|FAILED|1:0|00:10:00|2048M|4Gn|2|16",
        ].join("\n"),
      ),
    ).toHaveLength(2);
  });

  test("returns an empty array for empty output", () => {
    expect(parseSacctOutput("\n\n")).toEqual([]);
  });

  test("filters job steps and keeps the main job only", () => {
    expect(
      parseSacctOutput(
        [
          "JobID|State|ExitCode|Elapsed|MaxRSS|NNodes|ReqMem|AllocCPUS",
          "123456.batch|COMPLETED|0:0|01:00:00|1000K|1|1Gn|1",
          "123456.0|COMPLETED|0:0|01:00:00|1000K|1|1Gn|1",
          "123456|COMPLETED|0:0|01:23:45|123456K|8Gn|1|8",
        ].join("\n"),
      ),
    ).toEqual([
      {
        jobId: "123456",
        state: "COMPLETED",
        exitCode: 0,
        elapsed: "01:23:45",
        maxRss: "123456K",
        reqMem: "8Gn",
        nNodes: 1,
        nCpus: 8,
      },
    ]);
  });

  test("parses exit code status from status:signal format", () => {
    expect(parseSacctOutput("123456|FAILED|0:9|00:01:00|1M|1Gn|1|1")[0]?.exitCode).toBe(0);
    expect(parseSacctOutput("123456|FAILED|1:0|00:01:00|1M|1Gn|1|1")[0]?.exitCode).toBe(1);
  });
});

describe("parseSinfoNodes", () => {
  test("parses a single node row", () => {
    expect(parseSinfoNodes("node01|idle|16|64000|62000|0.10")).toEqual([
      {
        name: "node01",
        state: "idle",
        cpus: 16,
        memoryMb: 64000,
        freeMemoryMb: 62000,
        partitions: [],
      },
    ]);
  });

  test("parses multiple nodes", () => {
    expect(
      parseSinfoNodes(
        ["node01|idle|16|64000|62000|0.10", "node02|alloc|32|128000|100000|3.21"].join("\n"),
      ),
    ).toHaveLength(2);
  });
});

describe("parseSinfoPartitions", () => {
  test("parses a single partition row", () => {
    expect(parseSinfoPartitions("debug|up|01:00:00|1-00:00:00|4|node01")).toEqual([
      {
        name: "debug",
        state: "up",
        defaultTime: "01:00:00",
        maxTime: "1-00:00:00",
        nodes: ["node01"],
      },
    ]);
  });

  test("parses multiple partitions", () => {
    expect(
      parseSinfoPartitions(
        [
          "debug|up|01:00:00|1-00:00:00|4|node01",
          "long|up|04:00:00|7-00:00:00|8|node02,node03",
        ].join("\n"),
      ),
    ).toHaveLength(2);
  });
});
