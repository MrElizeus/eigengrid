import { expect, test } from "bun:test";
import {
  ExecutionCoordinator,
  type ExecutionCoordinatorDeps,
  type RemoteExecutionBackend,
} from "../../apps/cli/src/services/execution-coordinator";

test("production closes legacy execution/mutation paths before DB/filesystem/backend access", async () => {
  const deps = new Proxy(
    { allowLegacyExecution: false },
    {
      get(target, key) {
        if (key === "allowLegacyExecution") return target.allowLegacyExecution;
        throw new Error(`Unauthorized dependency access: ${String(key)}`);
      },
    },
  ) as ExecutionCoordinatorDeps;
  const backend = new Proxy(
    {},
    {
      get() {
        throw new Error("Legacy backend invoked");
      },
    },
  ) as RemoteExecutionBackend;
  const coordinator = new ExecutionCoordinator(deps);
  expect(
    (await coordinator.executeLocal({ software: "amber", inputPath: "/must-not-read" })).ok,
  ).toBe(false);
  expect((await coordinator.dispatchExistingJob("job", "attempt")).ok).toBe(false);
  expect((await coordinator.reconcileLocal("job")).status).toBe("safely-unknown");
  expect((await coordinator.cancelLocal("job")).ok).toBe(false);
  expect((await coordinator.cancelPending("job")).ok).toBe(false);
  expect((await coordinator.collectLocal("job")).ok).toBe(false);
  expect((await coordinator.parseJob("job")).ok).toBe(false);
  for (const method of [
    "dispatchRemote",
    "reconcileRemote",
    "cancelRemote",
    "collectRemote",
  ] as const) {
    expect((await coordinator[method]("job", backend)).ok).toBe(false);
  }
});
