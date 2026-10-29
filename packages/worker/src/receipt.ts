import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalPublicJson, publicDigest, PublicDigestSchema } from "@eigengrid/protocol";
import { z } from "zod";
import { appendJsonLineSync, atomicWriteFileSync } from "./persistence";
import type { WorkerJobManifest, WorkerJobState } from "./types";

/** Durable receipt emitted by a worker after a terminal observation. */
export const WorkerReceiptSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.worker-receipt.v1"),
    jobId: z.string().min(1),
    attemptId: z.string().min(1),
    manifestDigest: PublicDigestSchema,
    state: z.enum(["completed", "failed", "cancelled", "orphaned"] satisfies [
      WorkerJobState,
      ...WorkerJobState[],
    ]),
    commandDigest: PublicDigestSchema,
    pid: z.number().int().positive().optional(),
    exitCode: z.number().int().optional(),
    startedAt: z.number().int().positive().optional(),
    finishedAt: z.number().int().positive(),
    artifactDigests: z.record(z.string().min(1), PublicDigestSchema),
    receiptDigest: PublicDigestSchema,
  })
  .strict();

export type WorkerReceipt = z.infer<typeof WorkerReceiptSchema>;

function digestMaterial(value: Omit<WorkerReceipt, "receiptDigest">): `sha256:${string}` {
  return publicDigest(value) as `sha256:${string}`;
}

export function manifestDigest(manifest: WorkerJobManifest): `sha256:${string}` {
  return publicDigest(manifest) as `sha256:${string}`;
}

export function commandDigest(command: string): `sha256:${string}` {
  return publicDigest(command) as `sha256:${string}`;
}

export function createWorkerReceipt(
  input: Omit<WorkerReceipt, "schemaVersion" | "receiptDigest">,
): WorkerReceipt {
  const material = {
    schemaVersion: "eigengrid.worker-receipt.v1" as const,
    ...input,
  };
  return WorkerReceiptSchema.parse({ ...material, receiptDigest: digestMaterial(material) });
}

export function verifyWorkerReceipt(
  receipt: unknown,
): { ok: true; receipt: WorkerReceipt } | { ok: false; errors: string[] } {
  const parsed = WorkerReceiptSchema.safeParse(receipt);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }
  const { receiptDigest, ...material } = parsed.data;
  const expected = digestMaterial(material);
  if (receiptDigest !== expected) {
    return { ok: false, errors: [`receiptDigest does not match canonical receipt (${expected})`] };
  }
  return { ok: true, receipt: parsed.data };
}

export function writeWorkerReceipt(bundleDir: string, receipt: WorkerReceipt): void {
  const verified = verifyWorkerReceipt(receipt);
  if (!verified.ok)
    throw new Error(`refusing invalid worker receipt: ${verified.errors.join("; ")}`);
  atomicWriteFileSync(
    join(bundleDir, "receipt.json"),
    `${canonicalPublicJson(verified.receipt)}\n`,
  );
  // A bundle is an offline spool: the append-only copy survives movement from
  // running/ to done/failed/ and can be replayed after Head reconnects.
  appendJsonLineSync(join(bundleDir, "receipts.jsonl"), verified.receipt);
}

export function readWorkerReceipt(bundleDir: string): WorkerReceipt | null {
  const path = join(bundleDir, "receipt.json");
  if (!existsSync(path)) return null;
  try {
    const verified = verifyWorkerReceipt(JSON.parse(readFileSync(path, "utf8")));
    return verified.ok ? verified.receipt : null;
  } catch {
    return null;
  }
}

export function receiptPath(bundleDir: string): string {
  return join(bundleDir, "receipt.json");
}

export function digestArtifactBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Hash regular files in worker-owned output areas. Symlinks are never
 * promoted to authoritative artifact references. */
export function collectArtifactDigests(bundleDir: string): Record<string, `sha256:${string}`> {
  const result: Record<string, `sha256:${string}`> = {};
  const visit = (absolute: string, relative: string): void => {
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolute)) {
        visit(join(absolute, entry), join(relative, entry));
      }
      return;
    }
    if (stat.isFile()) result[relative] = digestArtifactBytes(readFileSync(absolute));
  };
  for (const area of ["artifacts", "logs", "work"]) visit(join(bundleDir, area), area);
  return result;
}
