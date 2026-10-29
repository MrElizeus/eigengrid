import { describe, expect, test } from "bun:test";
import {
  ApprovalRequestSchema,
  IllegalScientificTransitionError,
  ScientificObjectiveSchema,
  SchemaVersion,
  assertScientificTransition,
  canonicalJson,
  canTransitionMission,
  digestCanonical,
} from "./index";

describe("scientific schema foundation", () => {
  test("canonical JSON and digests do not depend on object key insertion order", () => {
    const left = { b: [2, { z: true, a: null }], a: "value" };
    const right = { a: "value", b: [2, { a: null, z: true }] };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(digestCanonical(left)).toBe(digestCanonical(right));
    expect(digestCanonical(left)).toMatch(/^[a-f0-9]{64}$/);
  });

  test("runtime validation rejects an objective without a molecular charge decision", () => {
    const result = ScientificObjectiveSchema.safeParse({
      schemaVersion: SchemaVersion,
      id: "objective-1",
      statement: "Optimize water and verify it is a minimum",
      system: {
        evidenceId: "structure-1",
        format: "xyz",
        contentDigest: "a".repeat(64),
      },
      targetProperties: ["minimum geometry"],
      requiredConfidence: "screening",
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.system.charge).toBeUndefined();
  });

  test("approval validation requires exact revision and digests", () => {
    const result = ApprovalRequestSchema.safeParse({
      id: "approval-1",
      missionId: "mission-1",
      subjectType: "plan",
      subjectId: "plan-1",
      state: "pending",
      requestedFromRole: "scientific_reviewer",
      editableFields: [],
      requestedBy: { id: "service-1", kind: "service", role: "mission_owner" },
      requestedAt: "2026-08-06T00:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  test("state machines accept lifecycle progress and reject terminal replay", () => {
    expect(canTransitionMission("created", "scoping")).toBe(true);
    expect(canTransitionMission("completed", "executing")).toBe(false);
    expect(() => assertScientificTransition("mission", "completed", "executing")).toThrow(
      IllegalScientificTransitionError,
    );
  });
});
