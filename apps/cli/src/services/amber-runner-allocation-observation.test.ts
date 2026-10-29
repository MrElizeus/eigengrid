import { test, expect } from "bun:test";
import { amberRunnerClusterIdentity, amberRunnerAllocationObservation } from "./amber-slurm-runner";
test("runner allocation observation is bounded, redacts arbitrary env text and grants no execution authority", () => {
  const host = {
    uid: 2301,
    gid: 2301,
    node: "beast",
    cluster: "fixture-cluster",
    jobId: "65",
    cpus: 2,
    memoryMiB: 16384,
    gpusOnNode: 1,
    cudaVisibleDevices: "0",
    ordinaryBatch: true,
  };
  expect(amberRunnerAllocationObservation(host)).toMatchObject({
    workerUid: 2301,
    cpuCores: 2,
    gpusOnNode: 1,
    cudaVisibleDevices: "0",
  });
  const invalid = amberRunnerAllocationObservation({
    ...host,
    node: "secret\n/path",
    cluster: "arbitrary value",
    jobId: "bad",
    cpus: NaN,
    memoryMiB: Infinity,
    cudaVisibleDevices: "secret\nvalue",
  });
  expect(invalid).toMatchObject({
    workerNode: null,
    slurmCluster: null,
    slurmJobId: null,
    cpuCores: null,
    memoryMiB: null,
    cudaVisibleDevices: null,
  });
  expect(JSON.stringify(invalid)).not.toContain("secret");
  expect(invalid).not.toHaveProperty("scientificVerdict");
});

test("cluster fallback uses only the protected launcher value and never masks a conflicting native identity", () => {
  expect(amberRunnerClusterIdentity(undefined, "fixture-cluster")).toBe("fixture-cluster");
  expect(amberRunnerClusterIdentity("wrong-cluster", "fixture-cluster")).toBe("wrong-cluster");
  expect(amberRunnerClusterIdentity("", "fixture-cluster")).toBe("");
  expect(amberRunnerClusterIdentity(undefined, undefined)).toBe("");
});
