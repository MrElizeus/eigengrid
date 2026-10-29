import { posix } from "node:path";
import {
  sealSecurityDecision,
  verifySecurityCredential,
  verifySecurityCredentialSignature,
  verifySecurityProfile,
  verifySecurityRevocations,
} from "./digest";
import {
  SecurityInvocationRequestSchema,
  type SecurityAuthorizationDecision,
  type SecurityDenialCode,
  type SecurityInvocationRequest,
  type SecurityPrincipalCredential,
  type SecurityProfile,
  type SecurityRevocationSnapshot,
} from "./schemas";

const SECRET_KEY =
  /(?:^|_)(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|SECRET|PASSWORD|PASSWD|AUTHORIZATION|CREDENTIALS?|PRIVATE_KEY|DATABASE_URL|DATABASE_DSN)(?:$|_)/u;
const SECRET_VALUE =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:sk|api)[-_][A-Za-z0-9_-]{12,}|(?:postgres(?:ql)?|mysql):\/\/[^\s:@/]+:[^\s@/]+@|(?:password|passwd|secret|token)\s*[:=]\s*\S+)/iu;

export interface SecurityAuthorizationInput {
  profile: unknown;
  credential: unknown;
  revocations: unknown;
  request: unknown;
  now: string;
  trustedPublicKeys: Readonly<Record<string, string>>;
}

function containsPath(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function canonicalAbsolutePath(value: string): boolean {
  return posix.isAbsolute(value) && posix.normalize(value) === value && !value.endsWith("/.");
}

function sameEndpoint(
  left: SecurityInvocationRequest["egress"][number],
  right: SecurityProfile["network"]["allowedEgress"][number],
): boolean {
  return left.protocol === right.protocol && left.host === right.host && left.port === right.port;
}

function exceedsResources(
  requested: SecurityInvocationRequest["resources"],
  available: SecurityProfile["resources"],
): boolean {
  return (Object.keys(available) as Array<keyof typeof available>).some(
    (key) => requested[key] > available[key],
  );
}

function push(codes: SecurityDenialCode[], code: SecurityDenialCode): void {
  if (!codes.includes(code)) codes.push(code);
}

function decision(
  request: SecurityInvocationRequest,
  codes: SecurityDenialCode[],
  at: string,
): SecurityAuthorizationDecision {
  return sealSecurityDecision({
    schema: "eigengrid.security-authorization-decision.v1",
    requestId: request.requestId,
    profileId: request.profileId,
    credentialId: request.credentialId,
    verdict: codes.length === 0 ? "allow" : "deny",
    denialCodes: codes,
    decidedAt: at,
  });
}

/**
 * Pure fail-closed capability boundary. Returned denial codes are deliberately
 * value-free so a rejected secret is never reflected into logs or receipts.
 */
export function authorizeSecurityInvocation(
  input: SecurityAuthorizationInput,
): SecurityAuthorizationDecision {
  const request = SecurityInvocationRequestSchema.parse(input.request);
  const codes: SecurityDenialCode[] = [];
  let profile: SecurityProfile | undefined;
  let credential: SecurityPrincipalCredential | undefined;
  let revocations: SecurityRevocationSnapshot | undefined;

  try {
    profile = verifySecurityProfile(input.profile);
  } catch {
    push(codes, "profile_invalid");
  }
  try {
    credential = verifySecurityCredential(input.credential);
  } catch {
    push(codes, "credential_invalid");
  }
  try {
    revocations = verifySecurityRevocations(input.revocations);
  } catch {
    push(codes, "credential_invalid");
  }
  if (!profile || !credential || !revocations) return decision(request, codes, input.now);

  const trustedPublicKey = Object.hasOwn(input.trustedPublicKeys, credential.keyId)
    ? input.trustedPublicKeys[credential.keyId]
    : undefined;
  if (
    !profile.authority.trustedKeyIds.includes(credential.keyId) ||
    typeof trustedPublicKey !== "string" ||
    !verifySecurityCredentialSignature(credential, trustedPublicKey)
  ) {
    push(codes, "credential_invalid");
  }

  if (request.profileId !== profile.profileId || request.profileDigest !== profile.profileDigest) {
    push(codes, "profile_mismatch");
  }
  if (
    credential.profileId !== profile.profileId ||
    credential.profileDigest !== profile.profileDigest ||
    request.credentialId !== credential.credentialId
  ) {
    push(codes, "credential_invalid");
  }
  if (credential.issuer !== profile.authority.issuer || revocations.issuer !== credential.issuer) {
    push(codes, "issuer_mismatch");
  }
  if (
    credential.audience !== profile.authority.audience ||
    revocations.audience !== credential.audience
  ) {
    push(codes, "audience_mismatch");
  }
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) throw new TypeError("Security authorization now must be a timestamp");
  const revocationAge = now - Date.parse(revocations.updatedAt);
  if (revocationAge < 0 || revocationAge > profile.authority.revocationMaxAgeMs) {
    push(codes, "revocation_snapshot_stale");
  }
  if (now < Date.parse(credential.notBefore)) push(codes, "credential_not_yet_valid");
  if (now >= Date.parse(credential.expiresAt)) push(codes, "credential_expired");
  if (revocations.revokedCredentialIds.includes(credential.credentialId)) {
    push(codes, "credential_revoked");
  }
  if (revocations.revokedKeyIds.includes(credential.keyId)) {
    push(codes, "credential_key_revoked");
  }
  const minimumGeneration = revocations.minimumGenerationBySubject[credential.subject] ?? 1;
  if (credential.generation < minimumGeneration) push(codes, "credential_generation_stale");

  if (
    !profile.capabilities.includes(request.capability) ||
    !credential.capabilities.includes(request.capability)
  ) {
    push(codes, "capability_denied");
  }
  const executable = profile.executables.find(
    ({ capability }) => capability === request.capability,
  );
  if (
    !executable ||
    executable.path !== request.executable.path ||
    executable.digest !== request.executable.digest
  ) {
    push(codes, "executable_denied");
  } else {
    const argumentBytes = request.argv.reduce(
      (total, value) => total + Buffer.byteLength(value),
      0,
    );
    if (
      request.argv.length > executable.maxArguments ||
      argumentBytes > executable.maxArgumentBytes
    ) {
      push(codes, "argument_limit_exceeded");
    }
  }

  if (
    !canonicalAbsolutePath(request.cwd) ||
    !profile.filesystem.readWriteRoots.some((root) => containsPath(root, request.cwd)) ||
    profile.filesystem.deniedRoots.some((root) => containsPath(root, request.cwd))
  ) {
    push(codes, "cwd_denied");
  }

  const allowedEnvironment = new Set(profile.environment.allowedKeys);
  const deniedEnvironment = new Set(profile.environment.deniedKeys);
  for (const [key, value] of Object.entries(request.environment)) {
    if (!allowedEnvironment.has(key) || deniedEnvironment.has(key)) {
      push(codes, "environment_denied");
    }
    if (
      SECRET_KEY.test(key) ||
      SECRET_VALUE.test(value) ||
      Buffer.byteLength(value) > profile.environment.maxValueBytes
    ) {
      push(codes, "secret_exposure");
    }
  }

  if (
    request.egress.some(
      (endpoint) =>
        !profile.network.allowedEgress.some((allowed) => sameEndpoint(endpoint, allowed)),
    )
  ) {
    push(codes, "egress_denied");
  }
  if (exceedsResources(request.resources, profile.resources)) {
    push(codes, "resource_limit_exceeded");
  }
  return decision(request, codes, input.now);
}

export interface FilteredSecurityEnvironment {
  environment: NodeJS.ProcessEnv;
  deniedKeys: string[];
}

/** Build a child environment from an explicit allow-list; never inherit by spread. */
export function filterSecurityEnvironment(
  profileValue: unknown,
  source: NodeJS.ProcessEnv,
): FilteredSecurityEnvironment {
  const profile = verifySecurityProfile(profileValue);
  const environment: NodeJS.ProcessEnv = {};
  const deniedKeys: string[] = [];
  const allowed = new Set(profile.environment.allowedKeys);
  const denied = new Set(profile.environment.deniedKeys);
  for (const [key, value] of Object.entries(source)) {
    if (
      value === undefined ||
      !allowed.has(key) ||
      denied.has(key) ||
      SECRET_KEY.test(key) ||
      SECRET_VALUE.test(value) ||
      Buffer.byteLength(value) > profile.environment.maxValueBytes
    ) {
      deniedKeys.push(key);
      continue;
    }
    environment[key] = value;
  }
  return { environment, deniedKeys: deniedKeys.sort() };
}
