import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealContract, type Digest } from "@eigengrid/colony-contracts";
import { A_DIGEST, B_DIGEST, ZERO_DIGEST } from "../../colony-contracts/src/test-fixtures";
import { JsonlCheckpointStore } from "./checkpoint-store";
import { ZERO_COLONY_USAGE } from "./budget";
import { SpeciesRegistry } from "./species-registry";
import { ColonyStateError, ColonySupervisor } from "./supervisor";
import {
  T0,
  campaignDefinition,
  correction,
  speciesContract,
  verification,
  workOrder,
  workResult,
  workUnit,
} from "./runtime-test-fixtures";

const C_DIGEST = `sha256:${"c".repeat(64)}` as Digest;
const temporaryDirectories: string[] = [];

function fixture(units?: ReturnType<typeof workUnit>[]) {
  const directory = mkdtempSync(join(tmpdir(), "eigengrid-colony-supervisor-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "campaign.jsonl");
  const contract = speciesContract();
  const registry = new SpeciesRegistry([contract]);
  const definition = campaignDefinition(contract, units ?? [workUnit(workOrder(contract))]);
  const store = new JsonlCheckpointStore(path);
  const supervisor = ColonySupervisor.create({ definition, registry, store, at: T0 });
  return { contract, definition, directory, path, registry, store, supervisor };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function at(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1_000).toISOString();
}

describe("finite colony supervisor", () => {
  test("requires independent verification before completing a campaign", () => {
    const { definition, supervisor } = fixture();
    const order = definition.workUnits[0]!.workOrder;
    const lease = supervisor.claim("unit-1", "worker-1", at(1)).lease;
    const candidate = workResult(order, A_DIGEST);
    expect(supervisor.submitResult("unit-1", lease.fencingToken, candidate, at(2))).toBe(
      "accepted",
    );
    expect(supervisor.snapshot()).toMatchObject({
      status: "verifying",
      units: { "unit-1": { status: "awaiting_verification" } },
    });

    const checked = verification(order, candidate, "pass");
    expect(supervisor.submitVerification("unit-1", checked.request, checked.result, at(3))).toBe(
      "pass",
    );
    expect(supervisor.snapshot()).toMatchObject({
      status: "completed",
      units: { "unit-1": { status: "completed" } },
    });
  });

  test("opens dependency joins only after upstream verification", () => {
    const contract = speciesContract();
    const firstOrder = workOrder(contract, "1");
    const secondOrder = workOrder(contract, "2");
    const { supervisor } = fixture([
      workUnit(firstOrder, "unit-1"),
      workUnit(secondOrder, "unit-2", ["unit-1"]),
    ]);
    expect(() => supervisor.claim("unit-2", "worker-2", at(1))).toThrow(/not ready|join barrier/);
    const lease = supervisor.claim("unit-1", "worker-1", at(1)).lease;
    const candidate = workResult(firstOrder, A_DIGEST);
    supervisor.submitResult("unit-1", lease.fencingToken, candidate, at(2));
    const checked = verification(firstOrder, candidate, "pass");
    supervisor.submitVerification("unit-1", checked.request, checked.result, at(3));
    expect(supervisor.snapshot().units["unit-2"]!.status).toBe("ready");
  });

  test("recovers a torn checkpoint, expires leases, and fences late results", () => {
    const { definition, path, registry, store, supervisor } = fixture();
    const lease = supervisor.claim("unit-1", "worker-old", at(1)).lease;
    appendFileSync(path, '{"torn":', "utf8");

    const recovered = ColonySupervisor.recover({
      campaignId: definition.campaignId,
      registry,
      store,
      at: at(12),
    });
    expect(recovered.snapshot()).toMatchObject({
      recoveryCount: 1,
      units: { "unit-1": { status: "ready", lastFencingToken: 1 } },
    });
    expect(
      recovered.submitResult(
        "unit-1",
        lease.fencingToken,
        workResult(definition.workUnits[0]!.workOrder, A_DIGEST),
        at(13),
      ),
    ).toBe("stale");
    expect(recovered.claim("unit-1", "worker-new", at(14)).lease.fencingToken).toBe(2);
    expect(store.load(definition.campaignId).tornTail).toBe(false);
  });

  test("heartbeats extend only the current fenced lease", () => {
    const { definition, supervisor } = fixture();
    const lease = supervisor.claim("unit-1", "worker-1", at(1)).lease;
    const renewed = supervisor.heartbeat("unit-1", "worker-1", lease.fencingToken, at(5));
    expect(renewed.expiresAt).toBe(at(15));
    expect(() => supervisor.heartbeat("unit-1", "worker-other", lease.fencingToken, at(6))).toThrow(
      /stale lease/i,
    );
    expect(
      supervisor.submitResult(
        "unit-1",
        lease.fencingToken,
        workResult(definition.workUnits[0]!.workOrder, A_DIGEST),
        at(12),
      ),
    ).toBe("accepted");
  });

  test("preflights cumulative budgets without poisoning the durable checkpoint", () => {
    const { definition, store, supervisor } = fixture();
    const oneFrontierCall = { ...ZERO_COLONY_USAGE, frontierCalls: 1 };
    supervisor.recordFrontierUsage("unit-1", oneFrontierCall, at(1));
    const beforeRejectedAppend = store.load(definition.campaignId).cursor;
    expect(() => supervisor.recordFrontierUsage("unit-1", oneFrontierCall, at(2))).toThrow(
      /budget exceeded/,
    );
    expect(store.load(definition.campaignId).cursor).toEqual(beforeRejectedAppend);
    expect(supervisor.snapshot().usage.frontierCalls).toBe(1);
  });

  test("classifies same-fence duplicates and blocks conflicting results", () => {
    const { definition, supervisor } = fixture();
    const order = definition.workUnits[0]!.workOrder;
    const lease = supervisor.claim("unit-1", "worker-1", at(1)).lease;
    const candidate = workResult(order, A_DIGEST);
    supervisor.submitResult("unit-1", lease.fencingToken, candidate, at(2));
    expect(supervisor.submitResult("unit-1", lease.fencingToken, candidate, at(3))).toBe(
      "duplicate",
    );
    const conflict = sealContract({
      ...candidate,
      summary: "A conflicting response for the same fenced attempt",
      resultDigest: ZERO_DIGEST,
    });
    expect(supervisor.submitResult("unit-1", lease.fencingToken, conflict, at(4))).toBe("conflict");
    expect(supervisor.snapshot()).toMatchObject({
      status: "blocked",
      units: { "unit-1": { status: "blocked" } },
    });
  });

  test("escalates a correction that makes no measurable candidate progress", () => {
    const { definition, supervisor } = fixture();
    const order = definition.workUnits[0]!.workOrder;
    const lease1 = supervisor.claim("unit-1", "worker-1", at(1)).lease;
    const first = workResult(order, A_DIGEST, "1");
    supervisor.submitResult("unit-1", lease1.fencingToken, first, at(2));
    const failed = verification(order, first, "fail", "1");
    supervisor.submitVerification("unit-1", failed.request, failed.result, at(3));
    supervisor.issueCorrection("unit-1", correction(order, first, failed.result, 1), at(4));

    const lease2 = supervisor.claim("unit-1", "worker-2", at(5)).lease;
    const unchanged = workResult(order, A_DIGEST, "2");
    expect(supervisor.submitResult("unit-1", lease2.fencingToken, unchanged, at(6))).toBe(
      "escalated",
    );
    expect(supervisor.snapshot()).toMatchObject({
      status: "blocked",
      units: {
        "unit-1": {
          status: "blocked",
          corrections: [{ attempt: 1 }],
          escalation: { destination: "owner" },
        },
      },
    });
  });

  test("permits at most two corrections then escalates a third failed verification", () => {
    const { definition, supervisor } = fixture();
    const order = definition.workUnits[0]!.workOrder;

    const lease1 = supervisor.claim("unit-1", "worker-1", at(1)).lease;
    const first = workResult(order, A_DIGEST, "1");
    supervisor.submitResult("unit-1", lease1.fencingToken, first, at(2));
    const failed1 = verification(order, first, "fail", "1");
    supervisor.submitVerification("unit-1", failed1.request, failed1.result, at(3));
    supervisor.issueCorrection("unit-1", correction(order, first, failed1.result, 1), at(4));

    const lease2 = supervisor.claim("unit-1", "worker-2", at(5)).lease;
    const second = workResult(order, B_DIGEST, "2");
    supervisor.submitResult("unit-1", lease2.fencingToken, second, at(6));
    const failed2 = verification(order, second, "fail", "2");
    supervisor.submitVerification("unit-1", failed2.request, failed2.result, at(7));
    supervisor.issueCorrection("unit-1", correction(order, second, failed2.result, 2), at(8));

    const lease3 = supervisor.claim("unit-1", "worker-3", at(9)).lease;
    const third = workResult(order, C_DIGEST, "3");
    supervisor.submitResult("unit-1", lease3.fencingToken, third, at(10));
    const failed3 = verification(order, third, "fail", "3");
    supervisor.submitVerification("unit-1", failed3.request, failed3.result, at(11));

    const snapshot = supervisor.snapshot();
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.units["unit-1"]!.corrections).toHaveLength(2);
    expect(snapshot.units["unit-1"]!.escalation?.reason).toMatch(/correction limit/);
    expect(() => supervisor.claim("unit-1", "worker-4", at(12))).toThrow(ColonyStateError);
  });
});
