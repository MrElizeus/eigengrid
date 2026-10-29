import { z } from "zod";

export const SecurityIdentifierSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+|=-]*$/u, "Expected a stable technical identifier");

export const SecurityDigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u, "Expected a lower-case sha256 digest");
export type SecurityDigest = z.infer<typeof SecurityDigestSchema>;

export const SecurityTimestampSchema = z.string().datetime({ offset: true });

function hasControlSeparator(value: string): boolean {
  return value.includes("\0") || value.includes("\r") || value.includes("\n");
}

export const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .startsWith("/")
  .refine((value) => !hasControlSeparator(value), "Paths cannot contain control separators");

export const EnvironmentKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z_][A-Z0-9_]*$/u, "Expected a POSIX environment key");

export const EgressEndpointSchema = z
  .object({
    protocol: z.enum(["tcp", "udp"]),
    host: z
      .string()
      .min(1)
      .max(253)
      .regex(
        /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u,
        "Expected an exact lower-case DNS name without wildcards",
      ),
    port: z.number().int().min(1).max(65_535),
  })
  .strict();
export type EgressEndpoint = z.infer<typeof EgressEndpointSchema>;

export const SecurityResourceLimitsSchema = z
  .object({
    cpuQuotaPercent: z.number().int().min(1).max(10_000),
    memoryMaxBytes: z.number().int().positive(),
    tasksMax: z.number().int().positive(),
    wallTimeMaxMs: z.number().int().positive(),
    outputMaxBytes: z.number().int().positive(),
  })
  .strict();
export type SecurityResourceLimits = z.infer<typeof SecurityResourceLimitsSchema>;

export const SecurityExecutableRuleSchema = z
  .object({
    capability: SecurityIdentifierSchema,
    path: AbsolutePathSchema,
    digest: SecurityDigestSchema,
    maxArguments: z.number().int().nonnegative().max(512),
    maxArgumentBytes: z.number().int().positive().max(1_048_576),
  })
  .strict();
export type SecurityExecutableRule = z.infer<typeof SecurityExecutableRuleSchema>;

export const SecurityProfileSchema = z
  .object({
    schema: z.literal("eigengrid.security-profile.v1"),
    profileId: SecurityIdentifierSchema,
    surface: z.enum(["head", "codex", "worker", "job", "research", "myrmex", "slurm"]),
    version: z.number().int().positive(),
    authority: z
      .object({
        issuer: SecurityIdentifierSchema,
        audience: SecurityIdentifierSchema,
        trustedKeyIds: z.array(SecurityIdentifierSchema).min(1),
        revocationMaxAgeMs: z.number().int().positive(),
      })
      .strict(),
    capabilities: z.array(SecurityIdentifierSchema),
    executables: z.array(SecurityExecutableRuleSchema),
    filesystem: z
      .object({
        readOnlyRoots: z.array(AbsolutePathSchema),
        readWriteRoots: z.array(AbsolutePathSchema),
        deniedRoots: z.array(AbsolutePathSchema),
        privateTmp: z.literal(true),
      })
      .strict(),
    environment: z
      .object({
        allowedKeys: z.array(EnvironmentKeySchema),
        deniedKeys: z.array(EnvironmentKeySchema),
        maxValueBytes: z.number().int().positive().max(65_536),
        secretDelivery: z.enum(["systemd_credential", "reference_only", "none"]),
      })
      .strict(),
    network: z
      .object({
        defaultPolicy: z.literal("deny"),
        allowedEgress: z.array(EgressEndpointSchema),
      })
      .strict(),
    resources: SecurityResourceLimitsSchema,
    systemd: z
      .object({
        user: SecurityIdentifierSchema,
        group: SecurityIdentifierSchema,
        appArmorProfile: SecurityIdentifierSchema,
        readWritePaths: z.array(AbsolutePathSchema),
        allowedAddressFamilies: z.array(z.enum(["AF_UNIX", "AF_INET", "AF_INET6"])),
        credentialNames: z.array(SecurityIdentifierSchema),
      })
      .strict(),
    profileDigest: SecurityDigestSchema,
  })
  .strict()
  .superRefine((profile, context) => {
    const unique = (values: readonly string[]) => new Set(values).size === values.length;
    for (const [path, values] of [
      ["capabilities", profile.capabilities],
      ["filesystem.readOnlyRoots", profile.filesystem.readOnlyRoots],
      ["filesystem.readWriteRoots", profile.filesystem.readWriteRoots],
      ["filesystem.deniedRoots", profile.filesystem.deniedRoots],
      ["environment.allowedKeys", profile.environment.allowedKeys],
      ["environment.deniedKeys", profile.environment.deniedKeys],
      ["authority.trustedKeyIds", profile.authority.trustedKeyIds],
      ["systemd.readWritePaths", profile.systemd.readWritePaths],
      ["systemd.allowedAddressFamilies", profile.systemd.allowedAddressFamilies],
      ["systemd.credentialNames", profile.systemd.credentialNames],
    ] as const) {
      if (!unique(values)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: path.split("."),
          message: "Values must be unique",
        });
      }
    }
    if (profile.systemd.user === "root" || profile.systemd.group === "root") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["systemd", "user"],
        message: "Security profiles require a dedicated non-root identity",
      });
    }
    const capabilitySet = new Set(profile.capabilities);
    const executableCapabilities = profile.executables.map(({ capability }) => capability);
    if (!unique(executableCapabilities)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executables"],
        message: "At most one executable rule may own a capability",
      });
    }
    for (const [index, rule] of profile.executables.entries()) {
      if (!capabilitySet.has(rule.capability)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["executables", index, "capability"],
          message: "Executable capability is not declared by the profile",
        });
      }
      if (/(?:^|\/)(?:ba|da|z|k|c|t|fi)?sh$/u.test(rule.path)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["executables", index, "path"],
          message: "A shell cannot be a profile executable",
        });
      }
    }
    const allowedEnvironment = new Set(profile.environment.allowedKeys);
    for (const denied of profile.environment.deniedKeys) {
      if (allowedEnvironment.has(denied)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["environment", "deniedKeys"],
          message: `Environment key ${denied} cannot be both allowed and denied`,
        });
      }
    }
    const writeRoots = new Set(profile.filesystem.readWriteRoots);
    if (
      profile.systemd.readWritePaths.some((path) => !writeRoots.has(path)) ||
      profile.systemd.readWritePaths.length !== writeRoots.size
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["systemd", "readWritePaths"],
        message: "systemd read/write paths must exactly match the filesystem contract",
      });
    }
    const egressKeys = profile.network.allowedEgress.map(
      ({ protocol, host, port }) => `${protocol}:${host}:${port}`,
    );
    if (!unique(egressKeys)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["network", "allowedEgress"],
        message: "Egress endpoints must be unique",
      });
    }
  });
export type SecurityProfile = z.infer<typeof SecurityProfileSchema>;

export const SecurityPrincipalCredentialSchema = z
  .object({
    schema: z.literal("eigengrid.security-principal-credential.v1"),
    credentialId: SecurityIdentifierSchema,
    subject: SecurityIdentifierSchema,
    issuer: SecurityIdentifierSchema,
    audience: SecurityIdentifierSchema,
    keyId: SecurityIdentifierSchema,
    generation: z.number().int().positive(),
    profileId: SecurityIdentifierSchema,
    profileDigest: SecurityDigestSchema,
    capabilities: z.array(SecurityIdentifierSchema),
    issuedAt: SecurityTimestampSchema,
    notBefore: SecurityTimestampSchema,
    expiresAt: SecurityTimestampSchema,
    credentialDigest: SecurityDigestSchema,
    signature: z
      .object({
        algorithm: z.literal("ed25519"),
        value: z
          .string()
          .min(80)
          .max(128)
          .regex(/^[A-Za-z0-9+/]+={0,2}$/u, "Expected a base64 Ed25519 signature"),
      })
      .strict(),
  })
  .strict()
  .superRefine((credential, context) => {
    if (new Set(credential.capabilities).size !== credential.capabilities.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities"],
        message: "Credential capabilities must be unique",
      });
    }
    if (
      Date.parse(credential.issuedAt) > Date.parse(credential.notBefore) ||
      Date.parse(credential.notBefore) >= Date.parse(credential.expiresAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "Credential validity timestamps are inconsistent",
      });
    }
  });
export type SecurityPrincipalCredential = z.infer<typeof SecurityPrincipalCredentialSchema>;

export const SecurityRevocationSnapshotSchema = z
  .object({
    schema: z.literal("eigengrid.security-revocation-snapshot.v1"),
    issuer: SecurityIdentifierSchema,
    audience: SecurityIdentifierSchema,
    minimumGenerationBySubject: z.record(SecurityIdentifierSchema, z.number().int().positive()),
    revokedCredentialIds: z.array(SecurityIdentifierSchema),
    revokedKeyIds: z.array(SecurityIdentifierSchema),
    updatedAt: SecurityTimestampSchema,
    snapshotDigest: SecurityDigestSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    for (const field of ["revokedCredentialIds", "revokedKeyIds"] as const) {
      if (new Set(snapshot[field]).size !== snapshot[field].length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: "Revocations must be unique",
        });
      }
    }
  });
export type SecurityRevocationSnapshot = z.infer<typeof SecurityRevocationSnapshotSchema>;

export const SecurityInvocationRequestSchema = z
  .object({
    schema: z.literal("eigengrid.security-invocation-request.v1"),
    requestId: SecurityIdentifierSchema,
    credentialId: SecurityIdentifierSchema,
    profileId: SecurityIdentifierSchema,
    profileDigest: SecurityDigestSchema,
    capability: SecurityIdentifierSchema,
    executable: z
      .object({
        path: AbsolutePathSchema,
        digest: SecurityDigestSchema,
      })
      .strict(),
    argv: z
      .array(
        z
          .string()
          .max(65_536)
          .refine((value) => !hasControlSeparator(value), "Arguments cannot contain separators"),
      )
      .max(512),
    cwd: AbsolutePathSchema,
    environment: z.record(EnvironmentKeySchema, z.string().max(65_536)),
    egress: z.array(EgressEndpointSchema),
    resources: SecurityResourceLimitsSchema,
    requestedAt: SecurityTimestampSchema,
  })
  .strict();
export type SecurityInvocationRequest = z.infer<typeof SecurityInvocationRequestSchema>;

export const SECURITY_DENIAL_CODES = [
  "profile_invalid",
  "profile_mismatch",
  "credential_invalid",
  "credential_not_yet_valid",
  "credential_expired",
  "credential_revoked",
  "credential_key_revoked",
  "credential_generation_stale",
  "revocation_snapshot_stale",
  "issuer_mismatch",
  "audience_mismatch",
  "capability_denied",
  "executable_denied",
  "argument_limit_exceeded",
  "cwd_denied",
  "environment_denied",
  "secret_exposure",
  "egress_denied",
  "resource_limit_exceeded",
] as const;
export const SecurityDenialCodeSchema = z.enum(SECURITY_DENIAL_CODES);
export type SecurityDenialCode = z.infer<typeof SecurityDenialCodeSchema>;

export const SecurityAuthorizationDecisionSchema = z
  .object({
    schema: z.literal("eigengrid.security-authorization-decision.v1"),
    requestId: SecurityIdentifierSchema,
    profileId: SecurityIdentifierSchema,
    credentialId: SecurityIdentifierSchema,
    verdict: z.enum(["allow", "deny"]),
    denialCodes: z.array(SecurityDenialCodeSchema),
    decidedAt: SecurityTimestampSchema,
    decisionDigest: SecurityDigestSchema,
  })
  .strict()
  .superRefine((decision, context) => {
    if ((decision.verdict === "allow") !== (decision.denialCodes.length === 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["denialCodes"],
        message: "Allow has no denial codes; deny has at least one",
      });
    }
    if (new Set(decision.denialCodes).size !== decision.denialCodes.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["denialCodes"],
        message: "Denial codes must be unique",
      });
    }
  });
export type SecurityAuthorizationDecision = z.infer<typeof SecurityAuthorizationDecisionSchema>;
