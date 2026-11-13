import { expect, test } from "bun:test";
import { productionStatus } from "./production-status";
import type { statSync } from "node:fs";

const present = (() => ({ isFile: () => true })) as unknown as typeof statSync;
const service =
  (stdout: string, status: number | null = 0, error?: unknown) =>
  () => ({ stdout, status, error });

test("present configs and an active service never substitute for protected readiness", () => {
  const result = productionStatus({
    stat: present,
    service: service("ActiveState=active\nExecStart=secret-credential"),
  });
  expect(result.serviceActive).toBe(true);
  expect(result.missing).toEqual([]);
  expect(result.readiness).toBeNull();
  expect(JSON.stringify(result)).not.toContain("secret-credential");
});

test("standby is distinct from inactive or unobservable service state", () => {
  expect(
    productionStatus({
      stat: present,
      service: service("ActiveState=active\nExecStart=--dispatch-disabled"),
    }).standby,
  ).toBe(true);
  expect(
    productionStatus({ stat: present, service: service("ActiveState=inactive") }).serviceActive,
  ).toBe(false);
  for (const serviceCheck of [service("", 1), service("", null, new Error("ENOENT systemctl"))]) {
    const result = productionStatus({ stat: present, service: serviceCheck });
    expect(result.serviceObservable).toBe(false);
    expect(result.readiness).toBeNull();
  }
});

test("denied inspection is never described as a missing configuration", () => {
  const stat = ((path: string) => {
    throw Object.assign(new Error("private"), {
      code: path.includes("mission-client") ? "ENOENT" : "EACCES",
    });
  }) as unknown as typeof statSync;
  const result = productionStatus({ stat, service: service("") });
  expect(result.missing).toHaveLength(1);
  expect(result.uninspectable).toHaveLength(3);
  expect(result.configurations[1]?.status).toBe("inaccessible");
  expect(JSON.stringify(result)).not.toContain("private");
});

test("production doctor JSON exits unsuccessfully without verified readiness", () => {
  const result = Bun.spawnSync(
    [process.execPath, "apps/cli/bin/eigengrid.ts", "doctor", "--production", "--json"],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout.toString()).readiness).not.toBe(true);
});
