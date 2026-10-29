import { mkdir, readFile, rename, unlink, open } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { canonicalJson, digestCanonical } from "@eigengrid/scientific-schema";
import { redactObject } from "./redact";

/** Checksummed, redacted evidence bundle exchanged with operators/Myrmex. */
export const IncidentBundleSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.incident-bundle.v1"),
    incidentId: z.string().min(1).max(256),
    generatedAt: z.string().datetime({ offset: true }),
    sourceRevision: z.string().min(1).max(256),
    missionId: z.string().min(1).max(256).optional(),
    sections: z.record(z.unknown()),
    payloadDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    bundleDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  })
  .strict();
export type IncidentBundle = z.infer<typeof IncidentBundleSchema>;

export interface IncidentBundleInput {
  incidentId: string;
  generatedAt?: string;
  sourceRevision: string;
  missionId?: string;
  sections: Record<string, unknown>;
}

function payloadDigest(sections: Record<string, unknown>): `sha256:${string}` {
  return `sha256:${digestCanonical(sections)}`;
}

function bundleDigest(bundle: Omit<IncidentBundle, "bundleDigest">): `sha256:${string}` {
  return `sha256:${digestCanonical(bundle)}`;
}

/**
 * Build a deterministic bundle. Redaction happens before either digest is
 * calculated, so an operator can verify exactly what was exchanged without
 * receiving credentials or model-provider secrets.
 */
export function createIncidentBundle(input: IncidentBundleInput): IncidentBundle {
  const sections = redactObject(input.sections);
  const material = {
    schemaVersion: "eigengrid.incident-bundle.v1" as const,
    incidentId: input.incidentId,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    sourceRevision: input.sourceRevision,
    ...(input.missionId === undefined ? {} : { missionId: input.missionId }),
    sections,
  };
  const withPayload = { ...material, payloadDigest: payloadDigest(sections) };
  return IncidentBundleSchema.parse({
    ...withPayload,
    bundleDigest: bundleDigest(withPayload),
  });
}

export function verifyIncidentBundle(
  raw: unknown,
): { ok: true; bundle: IncidentBundle } | { ok: false; errors: string[] } {
  const parsed = IncidentBundleSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }
  const expectedPayload = payloadDigest(parsed.data.sections);
  if (expectedPayload !== parsed.data.payloadDigest) {
    return {
      ok: false,
      errors: [`payloadDigest: expected ${expectedPayload}, got ${parsed.data.payloadDigest}`],
    };
  }
  const { bundleDigest: _bundleDigest, ...withoutBundleDigest } = parsed.data;
  const expectedBundle = bundleDigest(withoutBundleDigest);
  if (expectedBundle !== parsed.data.bundleDigest) {
    return {
      ok: false,
      errors: [`bundleDigest: expected ${expectedBundle}, got ${parsed.data.bundleDigest}`],
    };
  }
  return { ok: true, bundle: parsed.data };
}

/** Serialize in canonical key order for transport, hashing and archival. */
export function serializeIncidentBundle(bundle: IncidentBundle): string {
  const verified = verifyIncidentBundle(bundle);
  if (!verified.ok) throw new Error(`invalid incident bundle: ${verified.errors.join("; ")}`);
  return `${canonicalJson(verified.bundle)}\n`;
}

/** Write a private (0600) bundle atomically enough for operator hand-off. */
export async function writeIncidentBundle(path: string, bundle: IncidentBundle): Promise<void> {
  const serialized = serializeIncidentBundle(bundle);
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    await handle.writeFile(serialized, { encoding: "utf8" });
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function readIncidentBundle(path: string): Promise<IncidentBundle> {
  const parsed = verifyIncidentBundle(JSON.parse(await readFile(path, "utf8")));
  if (!parsed.ok) throw new Error(`invalid incident bundle ${path}: ${parsed.errors.join("; ")}`);
  return parsed.bundle;
}
