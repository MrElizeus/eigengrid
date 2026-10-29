import { describe, expect, test } from "bun:test";
import { ZodError } from "zod";
import { authorizeSecurityInvocation, filterSecurityEnvironment } from "./authorization";
import {
  canonicalSecurityJson,
  computeSecurityProfileDigest,
  digestSecurityValue,
  signSecurityCredential,
  verifySecurityDecision,
  verifySecurityProfile,
} from "./digest";
import {
  SecurityInvocationRequestSchema,
  SecurityPrincipalCredentialSchema,
  SecurityProfileSchema,
} from "./schemas";
import { SECURITY_TEST_PRIVATE_KEY, validSecurityScenario } from "./test-fixtures";

describe("strict security boundary contracts", () => {
  test("canonicalizes, seals, and verifies an exact profile independently of key order", () => {
    const scenario = validSecurityScenario();
    const profile = verifySecurityProfile(scenario.profile);
    expect(computeSecurityProfileDigest(profile)).toBe(profile.profileDigest);
    expect(digestSecurityValue({ z: 1, a: [2, 3] })).toBe(digestSecurityValue({ a: [2, 3], z: 1 }));
    expect(canonicalSecurityJson({ "e\u0301": "e\u0301" })).toBe(
      canonicalSecurityJson({ "\u00e9": "\u00e9" }),
    );
  });

  test("rejects unknown authority fields, raw shell flags, malformed paths, and digest drift", () => {
    const scenario = validSecurityScenario();
    expect(
      SecurityProfileSchema.safeParse({ ...(scenario.profile as object), root: true }).success,
    ).toBe(false);
    expect(
      SecurityPrincipalCredentialSchema.safeParse({
        ...(scenario.credential as object),
        delegatedAdmin: true,
      }).success,
    ).toBe(false);
    expect(
      SecurityInvocationRequestSchema.safeParse({
        ...(scenario.request as object),
        shell: true,
      }).success,
    ).toBe(false);
    expect(
      SecurityInvocationRequestSchema.safeParse({
        ...(scenario.request as object),
        cwd: "relative/path",
      }).success,
    ).toBe(false);
    expect(() =>
      verifySecurityProfile({
        ...(scenario.profile as object),
        profileDigest: `sha256:${"0".repeat(64)}`,
      }),
    ).toThrow("digest mismatch");
  });

  test("does not canonicalize unsafe JavaScript values into signed policy", () => {
    expect(() => digestSecurityValue({ missing: undefined })).toThrow("undefined");
    expect(() => digestSecurityValue({ infinite: Number.POSITIVE_INFINITY })).toThrow("non-finite");
    expect(() => digestSecurityValue(new Date())).toThrow("non-plain");
    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = "present";
    expect(() => digestSecurityValue(sparse)).toThrow("sparse");
  });
});

describe("capability, credential, secret, and egress authorization", () => {
  test("allows only the exact credential/profile/capability/executable/resource tuple", () => {
    const scenario = validSecurityScenario();
    const decision = authorizeSecurityInvocation(scenario);
    expect(decision).toMatchObject({ verdict: "allow", denialCodes: [] });
    expect(verifySecurityDecision(decision)).toEqual(decision);
  });

  test("returns value-free denial codes instead of reflecting rejected secrets", () => {
    const scenario = validSecurityScenario();
    scenario.request = {
      ...(scenario.request as object),
      environment: {
        PATH: "/usr/bin",
        OPENAI_API_KEY: "sk-do-not-reflect-123456789",
      },
    };
    const decision = authorizeSecurityInvocation(scenario);
    expect(decision.verdict).toBe("deny");
    expect(decision.denialCodes).toEqual(
      expect.arrayContaining(["environment_denied", "secret_exposure"]),
    );
    expect(JSON.stringify(decision)).not.toContain("do-not-reflect");
  });

  test("builds a child environment only from explicit safe values", () => {
    const scenario = validSecurityScenario();
    const filtered = filterSecurityEnvironment(scenario.profile, {
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      HOME: "/home/operator",
      OPENAI_API_KEY: "sk-secretmaterial-123456",
      LC_ALL: "Bearer secretmaterial123456",
    });
    expect(filtered.environment).toEqual({ LANG: "C.UTF-8", PATH: "/usr/bin" });
    expect(filtered.deniedKeys).toEqual(["HOME", "LC_ALL", "OPENAI_API_KEY"]);
    expect(JSON.stringify(filtered)).not.toContain("secretmaterial");
  });

  test("fails closed before authorization on a schema-smuggled field", () => {
    const scenario = validSecurityScenario();
    scenario.request = { ...(scenario.request as object), approvedByModel: true };
    expect(() => authorizeSecurityInvocation(scenario)).toThrow(ZodError);
  });

  test("detects a correctly re-signed credential bound to the wrong issuer", () => {
    const scenario = validSecurityScenario();
    const {
      credentialDigest: _digest,
      signature: _signature,
      ...material
    } = scenario.credential as ReturnType<typeof signSecurityCredential>;
    scenario.credential = signSecurityCredential(
      { ...material, issuer: "attacker" },
      SECURITY_TEST_PRIVATE_KEY,
    );
    const decision = authorizeSecurityInvocation(scenario);
    expect(decision.verdict).toBe("deny");
    expect(decision.denialCodes).toContain("issuer_mismatch");
    expect(decision.denialCodes).not.toContain("credential_invalid");
  });

  test("fails closed when the injected trust root is missing", () => {
    const scenario = validSecurityScenario();
    scenario.trustedPublicKeys = {};
    const decision = authorizeSecurityInvocation(scenario);
    expect(decision.verdict).toBe("deny");
    expect(decision.denialCodes).toContain("credential_invalid");
  });
});
