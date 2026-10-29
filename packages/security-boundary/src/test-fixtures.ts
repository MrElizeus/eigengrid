import { generateKeyPairSync } from "node:crypto";
import { sealSecurityRevocations, signSecurityCredential } from "./digest";
import { createWorkerJobSecurityProfile } from "./profiles";
import type { SecurityAuthorizationInput } from "./authorization";

export const SECURITY_TEST_NOW = "2026-08-30T16:00:00.000Z";
export const SECURITY_TEST_EXECUTABLE_DIGEST = `sha256:${"a".repeat(64)}` as const;
const SECURITY_TEST_KEYS = generateKeyPairSync("ed25519");
export const SECURITY_TEST_PRIVATE_KEY = SECURITY_TEST_KEYS.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
export const SECURITY_TEST_PUBLIC_KEY = SECURITY_TEST_KEYS.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();

export function validSecurityScenario(): SecurityAuthorizationInput {
  const profile = createWorkerJobSecurityProfile({
    executablePath: "/usr/local/lib/eigengrid/test-engine",
    executableDigest: SECURITY_TEST_EXECUTABLE_DIGEST,
  });
  const credential = signSecurityCredential(
    {
      schema: "eigengrid.security-principal-credential.v1",
      credentialId: "credential:worker-01:7",
      subject: "worker:01",
      issuer: profile.authority.issuer,
      audience: profile.authority.audience,
      keyId: "key:head:7",
      generation: 7,
      profileId: profile.profileId,
      profileDigest: profile.profileDigest,
      capabilities: ["job.execute"],
      issuedAt: "2026-08-30T15:00:00.000Z",
      notBefore: "2026-08-30T15:00:01.000Z",
      expiresAt: "2026-08-30T17:00:00.000Z",
    },
    SECURITY_TEST_PRIVATE_KEY,
  );
  const revocations = sealSecurityRevocations({
    schema: "eigengrid.security-revocation-snapshot.v1",
    issuer: profile.authority.issuer,
    audience: profile.authority.audience,
    minimumGenerationBySubject: { [credential.subject]: credential.generation },
    revokedCredentialIds: [],
    revokedKeyIds: [],
    updatedAt: "2026-08-30T15:59:00.000Z",
  });
  return {
    profile,
    credential,
    revocations,
    request: {
      schema: "eigengrid.security-invocation-request.v1",
      requestId: "request:execute:1",
      credentialId: credential.credentialId,
      profileId: profile.profileId,
      profileDigest: profile.profileDigest,
      capability: "job.execute",
      executable: {
        path: profile.executables[0]!.path,
        digest: profile.executables[0]!.digest,
      },
      argv: ["input.in", "output.out"],
      cwd: "/scratch/eigengrid/attempt-1",
      environment: { LANG: "C.UTF-8", PATH: "/usr/bin" },
      egress: [],
      resources: {
        cpuQuotaPercent: 100,
        memoryMaxBytes: 1_024 * 1_024 * 1_024,
        tasksMax: 32,
        wallTimeMaxMs: 60_000,
        outputMaxBytes: 1_024 * 1_024,
      },
      requestedAt: SECURITY_TEST_NOW,
    },
    now: SECURITY_TEST_NOW,
    trustedPublicKeys: { [credential.keyId]: SECURITY_TEST_PUBLIC_KEY },
  };
}
