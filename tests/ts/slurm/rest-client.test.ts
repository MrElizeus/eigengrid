import { describe, expect, test } from "bun:test";
import { SlurmRestClient } from "@eigengrid/slurm";

describe("SlurmRestClient", () => {
  test("constructor stores baseUrl and default timeoutMs", () => {
    const client = new SlurmRestClient({ baseUrl: "https://slurm.example.com" });

    expect(client.config).toEqual({ baseUrl: "https://slurm.example.com", timeoutMs: 10_000 });
  });

  test("constructor accepts custom timeout", () => {
    const client = new SlurmRestClient({ baseUrl: "https://slurm.example.com", timeoutMs: 2500 });

    expect(client.config.timeoutMs).toBe(2500);
  });

  test("constructor rejects missing baseUrl", () => {
    expect(() => new SlurmRestClient({} as never)).toThrow("SlurmRestClient requires baseUrl");
  });

  test("methods throw not implemented errors", async () => {
    const client = new SlurmRestClient({ baseUrl: "https://slurm.example.com" });

    await expect(client.submitJob("/tmp/job.sh")).rejects.toThrow("not implemented yet");
    await expect(client.getJobStatus("12345")).rejects.toThrow("not implemented yet");
    await expect(client.cancelJob("12345")).rejects.toThrow("not implemented yet");
    await expect(client.getNodes()).rejects.toThrow("not implemented yet");
    await expect(client.getPartitions()).rejects.toThrow("not implemented yet");
    await expect(client.getAccounting("12345")).rejects.toThrow("not implemented yet");

    await expect(client.submitJob("/tmp/job.sh")).rejects.toThrow("SlurmCliClient");
  });
});
