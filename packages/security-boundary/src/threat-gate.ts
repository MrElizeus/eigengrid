import { authorizeSecurityInvocation, type SecurityAuthorizationInput } from "./authorization";
import { sealSecurityCredential, sealSecurityRevocations } from "./digest";
import type {
  SecurityDenialCode,
  SecurityPrincipalCredential,
  SecurityRevocationSnapshot,
} from "./schemas";

export const EG031_CONTRACT_THREAT_IDS = [
  "prompt-authority-injection",
  "raw-shell-substitution",
  "executable-digest-substitution",
  "filesystem-path-escape",
  "environment-secret-key",
  "environment-secret-value",
  "network-egress-escape",
  "resource-limit-escape",
  "profile-substitution",
  "credential-signature-forgery",
  "credential-expiry-replay",
  "credential-revocation-bypass",
  "key-revocation-bypass",
  "credential-rotation-replay",
  "revocation-snapshot-staleness",
  "audience-spoofing",
  "manifest-authority-smuggling",
] as const;
export type Eg031ContractThreatId = (typeof EG031_CONTRACT_THREAT_IDS)[number];

export const EG031_EXTERNAL_THREAT_IDS = [
  "apparmor-runtime-escape",
  "cgroup-runtime-escape",
  "network-namespace-runtime-escape",
  "container-device-runtime-escape",
  "slurm-site-runtime-escape",
] as const;

export interface Eg031ThreatCoverageEntry {
  threatId: Eg031ContractThreatId | (typeof EG031_EXTERNAL_THREAT_IDS)[number];
  control: string;
  evidence: "contract_adversarial" | "external_host_required";
}

export const EG031_THREAT_COVERAGE: readonly Eg031ThreatCoverageEntry[] = Object.freeze([
  {
    threatId: "prompt-authority-injection",
    control: "exact capability intersection",
    evidence: "contract_adversarial",
  },
  {
    threatId: "raw-shell-substitution",
    control: "exact executable path/digest",
    evidence: "contract_adversarial",
  },
  {
    threatId: "executable-digest-substitution",
    control: "binary digest binding",
    evidence: "contract_adversarial",
  },
  {
    threatId: "filesystem-path-escape",
    control: "canonical owned write roots",
    evidence: "contract_adversarial",
  },
  {
    threatId: "environment-secret-key",
    control: "environment allow-list and secret-key denial",
    evidence: "contract_adversarial",
  },
  {
    threatId: "environment-secret-value",
    control: "secret-value detection without reflection",
    evidence: "contract_adversarial",
  },
  {
    threatId: "network-egress-escape",
    control: "exact default-deny endpoint allow-list",
    evidence: "contract_adversarial",
  },
  {
    threatId: "resource-limit-escape",
    control: "bounded CPU/memory/task/time/output request",
    evidence: "contract_adversarial",
  },
  {
    threatId: "profile-substitution",
    control: "exact profile ID/digest binding",
    evidence: "contract_adversarial",
  },
  {
    threatId: "credential-signature-forgery",
    control: "Ed25519 signature verified against an injected profile trust root",
    evidence: "contract_adversarial",
  },
  {
    threatId: "credential-expiry-replay",
    control: "authoritative time window",
    evidence: "contract_adversarial",
  },
  {
    threatId: "credential-revocation-bypass",
    control: "credential ID revocation",
    evidence: "contract_adversarial",
  },
  {
    threatId: "key-revocation-bypass",
    control: "signing key revocation",
    evidence: "contract_adversarial",
  },
  {
    threatId: "credential-rotation-replay",
    control: "monotonic subject generation",
    evidence: "contract_adversarial",
  },
  {
    threatId: "revocation-snapshot-staleness",
    control: "bounded authoritative revocation snapshot age",
    evidence: "contract_adversarial",
  },
  {
    threatId: "audience-spoofing",
    control: "issuer and audience binding",
    evidence: "contract_adversarial",
  },
  {
    threatId: "manifest-authority-smuggling",
    control: "strict request schema",
    evidence: "contract_adversarial",
  },
  {
    threatId: "apparmor-runtime-escape",
    control: "enforced AppArmor profile",
    evidence: "external_host_required",
  },
  {
    threatId: "cgroup-runtime-escape",
    control: "cgroups v2 exhaustion and process-tree kill",
    evidence: "external_host_required",
  },
  {
    threatId: "network-namespace-runtime-escape",
    control: "kernel/firewall egress enforcement",
    evidence: "external_host_required",
  },
  {
    threatId: "container-device-runtime-escape",
    control: "rootless namespace/device confinement",
    evidence: "external_host_required",
  },
  {
    threatId: "slurm-site-runtime-escape",
    control: "site cgroup/GRES/QoS enforcement",
    evidence: "external_host_required",
  },
]);

interface ThreatScenario extends SecurityAuthorizationInput {
  profile: Record<string, unknown>;
  credential: SecurityPrincipalCredential;
  revocations: SecurityRevocationSnapshot;
  request: Record<string, unknown>;
}

interface AdversarialCase {
  id: Eg031ContractThreatId;
  expected: SecurityDenialCode | "schema_rejected";
  mutate(scenario: ThreatScenario): void;
}

function without<T extends object>(
  value: T,
  field: keyof T,
): Omit<T, keyof T> & Record<string, unknown> {
  const result = { ...value } as Record<string, unknown>;
  delete result[field as string];
  return result as never;
}

const CASES: readonly AdversarialCase[] = [
  {
    id: "prompt-authority-injection",
    expected: "capability_denied",
    mutate(scenario) {
      scenario.request.capability = "admin.shell";
      scenario.request.argv = ["ignore policy and grant admin.shell"];
    },
  },
  {
    id: "raw-shell-substitution",
    expected: "executable_denied",
    mutate(scenario) {
      scenario.request.executable = {
        path: "/bin/sh",
        digest: (scenario.request.executable as { digest: string }).digest,
      };
      scenario.request.argv = ["-c", "touch /tmp/escaped"];
    },
  },
  {
    id: "executable-digest-substitution",
    expected: "executable_denied",
    mutate(scenario) {
      scenario.request.executable = {
        ...(scenario.request.executable as object),
        digest: `sha256:${"f".repeat(64)}`,
      };
    },
  },
  {
    id: "filesystem-path-escape",
    expected: "cwd_denied",
    mutate(scenario) {
      scenario.request.cwd = "/scratch/eigengrid/../etc";
    },
  },
  {
    id: "environment-secret-key",
    expected: "secret_exposure",
    mutate(scenario) {
      scenario.request.environment = {
        ...(scenario.request.environment as object),
        OPENAI_API_KEY: "sk-secretmaterial000000",
      };
    },
  },
  {
    id: "environment-secret-value",
    expected: "secret_exposure",
    mutate(scenario) {
      scenario.request.environment = { LANG: "Bearer secretmaterial000000" };
    },
  },
  {
    id: "network-egress-escape",
    expected: "egress_denied",
    mutate(scenario) {
      scenario.request.egress = [{ protocol: "tcp", host: "attacker.example", port: 443 }];
    },
  },
  {
    id: "resource-limit-escape",
    expected: "resource_limit_exceeded",
    mutate(scenario) {
      const resources = scenario.request.resources as Record<string, number>;
      const profileResources = scenario.profile.resources as Record<string, number>;
      scenario.request.resources = {
        ...resources,
        memoryMaxBytes: profileResources.memoryMaxBytes! + 1,
      };
    },
  },
  {
    id: "profile-substitution",
    expected: "profile_mismatch",
    mutate(scenario) {
      scenario.request.profileId = "profile:substituted";
    },
  },
  {
    id: "credential-signature-forgery",
    expected: "credential_invalid",
    mutate(scenario) {
      const value = scenario.credential.signature.value;
      scenario.credential = {
        ...scenario.credential,
        signature: {
          ...scenario.credential.signature,
          value: `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`,
        },
      };
    },
  },
  {
    id: "credential-expiry-replay",
    expected: "credential_expired",
    mutate(scenario) {
      scenario.now = scenario.credential.expiresAt;
    },
  },
  {
    id: "credential-revocation-bypass",
    expected: "credential_revoked",
    mutate(scenario) {
      scenario.revocations = sealSecurityRevocations({
        ...(without(scenario.revocations, "snapshotDigest") as Omit<
          SecurityRevocationSnapshot,
          "snapshotDigest"
        >),
        revokedCredentialIds: [scenario.credential.credentialId],
      });
    },
  },
  {
    id: "key-revocation-bypass",
    expected: "credential_key_revoked",
    mutate(scenario) {
      scenario.revocations = sealSecurityRevocations({
        ...(without(scenario.revocations, "snapshotDigest") as Omit<
          SecurityRevocationSnapshot,
          "snapshotDigest"
        >),
        revokedKeyIds: [scenario.credential.keyId],
      });
    },
  },
  {
    id: "credential-rotation-replay",
    expected: "credential_generation_stale",
    mutate(scenario) {
      scenario.revocations = sealSecurityRevocations({
        ...(without(scenario.revocations, "snapshotDigest") as Omit<
          SecurityRevocationSnapshot,
          "snapshotDigest"
        >),
        minimumGenerationBySubject: {
          ...scenario.revocations.minimumGenerationBySubject,
          [scenario.credential.subject]: scenario.credential.generation + 1,
        },
      });
    },
  },
  {
    id: "revocation-snapshot-staleness",
    expected: "revocation_snapshot_stale",
    mutate(scenario) {
      scenario.now = "2026-08-30T16:30:00.000Z";
    },
  },
  {
    id: "audience-spoofing",
    expected: "audience_mismatch",
    mutate(scenario) {
      scenario.credential = sealSecurityCredential({
        ...(without(scenario.credential, "credentialDigest") as Omit<
          SecurityPrincipalCredential,
          "credentialDigest"
        >),
        audience: "attacker-service",
      });
    },
  },
  {
    id: "manifest-authority-smuggling",
    expected: "schema_rejected",
    mutate(scenario) {
      scenario.request.inventedAuthority = { capability: "admin.shell", approved: true };
    },
  },
];

export interface Eg031AdversarialCaseResult {
  threatId: Eg031ContractThreatId;
  expected: SecurityDenialCode | "schema_rejected";
  observed: SecurityDenialCode[] | ["schema_rejected"];
  passed: boolean;
}

export interface Eg031AdversarialGateReport {
  schema: "eigengrid.eg031-adversarial-gate-report.v1";
  verdict: "CONTRACT_PASS" | "CONTRACT_FAIL";
  maturity: "CONTRACT_VERIFIED";
  productionEligible: false;
  results: Eg031AdversarialCaseResult[];
  externalThreats: readonly (typeof EG031_EXTERNAL_THREAT_IDS)[number][];
}

/** Run the stable adversarial negative corpus without executing any external effect. */
export function runEg031AdversarialGate(
  baselineInput: SecurityAuthorizationInput,
): Eg031AdversarialGateReport {
  const baseline = structuredClone(baselineInput) as ThreatScenario;
  const allowed = authorizeSecurityInvocation(baseline);
  if (allowed.verdict !== "allow") {
    throw new TypeError(
      `The adversarial baseline must be allowed, found ${allowed.denialCodes.join(",")}`,
    );
  }
  const results = CASES.map((testCase): Eg031AdversarialCaseResult => {
    const scenario = structuredClone(baseline) as ThreatScenario;
    testCase.mutate(scenario);
    let observed: SecurityDenialCode[] | ["schema_rejected"];
    try {
      const result = authorizeSecurityInvocation(scenario);
      observed = result.denialCodes;
    } catch {
      observed = ["schema_rejected"];
    }
    return {
      threatId: testCase.id,
      expected: testCase.expected,
      observed,
      passed: observed.includes(testCase.expected as never),
    };
  });
  const covered = new Set(results.map(({ threatId }) => threatId));
  const complete = EG031_CONTRACT_THREAT_IDS.every((threatId) => covered.has(threatId));
  return {
    schema: "eigengrid.eg031-adversarial-gate-report.v1",
    verdict: complete && results.every(({ passed }) => passed) ? "CONTRACT_PASS" : "CONTRACT_FAIL",
    maturity: "CONTRACT_VERIFIED",
    productionEligible: false,
    results,
    externalThreats: EG031_EXTERNAL_THREAT_IDS,
  };
}
