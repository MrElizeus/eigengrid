import { workerJobManifestSchema, type WorkerJobManifest } from "./types";

// ────────────────────────────────────────────────────────────
// Manifest Validation
// ────────────────────────────────────────────────────────────

export interface ManifestValidation {
  ok: boolean;
  errors: string[];
}

export type ManifestParseResult =
  | { ok: true; manifest: WorkerJobManifest; errors: [] }
  | { ok: false; errors: Array<{ path: string; message: string }> };

/** Parses the command-free WorkerJobManifest contract. */
export function parseManifest(raw: unknown): ManifestParseResult {
  if (raw && typeof raw === "object" && "schemaVersion" in raw) {
    const schemaVersion = (raw as Record<string, unknown>).schemaVersion;
    if (schemaVersion !== 2) {
      return {
        ok: false,
        errors: [
          {
            path: "schemaVersion",
            message: `unsupported manifest schemaVersion ${String(schemaVersion)}; expected 2`,
          },
        ],
      };
    }
  }

  const result = workerJobManifestSchema.safeParse(raw);
  if (result.success) return { ok: true, manifest: result.data, errors: [] };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => ({
      path: issue.path.join(".") || "manifest",
      message: issue.message,
    })),
  };
}

/** Backward-compatible validation name for callers that do not need parsed data. */
export function validateManifest(raw: unknown): ManifestValidation {
  const result = parseManifest(raw);
  return result.ok
    ? { ok: true, errors: [] }
    : { ok: false, errors: result.errors.map((error) => `${error.path}: ${error.message}`) };
}
