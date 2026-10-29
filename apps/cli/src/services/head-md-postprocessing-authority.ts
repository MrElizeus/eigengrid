/** Service-only root-provisioned policy/provider. Never accepts mission/model overrides. */
import { isAbsolute, resolve, join } from "node:path";
import { z } from "zod";
import { MdCompilerPolicySchema, computeMdCompilerPolicyDigest } from "@eigengrid/protocol-core";
import {
  MdEnvironmentCapabilitySnapshotSchema,
  assertMdEnvironmentCapabilitySnapshotDigest,
  digestCanonical,
} from "@eigengrid/scientific-schema";
import {
  MdReplicaIdentitySchema,
  MdReplicaReceiptSchema,
  MdReplicaVerifier,
} from "@eigengrid/mission-runtime";
import { readProtectedHeadJson } from "./head-md-site-authority";

const pathSchema = z
  .string()
  .max(1024)
  .refine(
    (v) =>
      isAbsolute(v) &&
      resolve(v) === v &&
      v !== "/" &&
      !Array.from(v).some((c) => {
        const code = c.charCodeAt(0);
        return code < 32 || code === 127;
      }),
  );
export const HeadMdPostprocessingConfigSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.head-md-postprocessing/v1"),
    configPath: pathSchema,
    headUid: z.number().int().positive(),
    policy: MdCompilerPolicySchema,
    environment: MdEnvironmentCapabilitySnapshotSchema,
    pythonExecutable: pathSchema,
    replica: z
      .object({
        identity: MdReplicaIdentitySchema,
        publicKey: z.string().min(1).max(16384),
        receiptDirectory: pathSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type HeadMdPostprocessingConfig = z.infer<typeof HeadMdPostprocessingConfigSchema>;

/** Public-key-only verifier. A mutable/unreadable config fails closed; restart
 * the Head to adopt a new reviewed profile. No write/SSH/network capability.
 */
export function createHeadMdPostprocessingAuthority(path: string, policyDigest: string) {
  const read = () => {
    const config = readProtectedHeadJson(path, HeadMdPostprocessingConfigSchema);
    if (
      config.configPath !== path ||
      config.headUid !== process.getuid?.() ||
      config.policy.policyDigest !== policyDigest ||
      computeMdCompilerPolicyDigest(config.policy) !== policyDigest
    )
      throw new Error("MD postprocessing configuration does not match this Head/policy");
    assertMdEnvironmentCapabilitySnapshotDigest(config.environment);
    return config;
  };
  const initial = read(),
    fingerprint = digestCanonical(initial);
  const current = () => {
    const value = read();
    if (digestCanonical(value) !== fingerprint)
      throw new Error("Protected MD postprocessing policy changed; restart required");
    return value;
  };
  return {
    resolve() {
      const config = current(),
        replica = config.replica;
      const replicaVerifier =
        replica === null
          ? undefined
          : new MdReplicaVerifier({
              identity: replica.identity,
              replicaPublicKey: replica.publicKey,
              readReceipt: async (_operationId, manifestDigest) => {
                current();
                try {
                  const receipt = readProtectedHeadJson(
                    join(replica.receiptDirectory, `${manifestDigest}.json`),
                    MdReplicaReceiptSchema,
                    64 * 1024,
                  );
                  current();
                  return receipt;
                } catch (error) {
                  if (
                    error &&
                    typeof error === "object" &&
                    "code" in error &&
                    error.code === "ENOENT"
                  )
                    return null;
                  throw error;
                }
              },
            });
      return {
        policy: config.policy,
        environment: config.environment,
        pythonExecutable: config.pythonExecutable,
        replicaVerifier,
        assertCurrent: current,
      };
    },
  };
}
