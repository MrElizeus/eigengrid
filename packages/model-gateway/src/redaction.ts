/**
 * Secret redaction shared by every model invocation path.
 *
 * The gateway receives model material from operator messages, scientific
 * context, and retrieved memory. Redaction happens before request/response
 * digests are computed and never includes the secret value in its report.
 */
export interface ModelRedactionReportEntry {
  path: string;
  reason: "sensitive_key" | "secret_pattern";
}

const secretKeyPattern =
  /(?:^|_)(?:api_key|access_token|refresh_token|auth_token|secret|password|passwd|authorization|credential|credentials|private_key|database_url|database_dsn)(?:$|_)/iu;

function normalizedKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/-/gu, "_")
    .toLowerCase();
}

function redactString(value: string): { value: string; redacted: boolean } {
  let redacted = false;
  let output = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, () => {
    redacted = true;
    return "[REDACTED_BEARER_TOKEN]";
  });
  output = output.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, () => {
    redacted = true;
    return "[REDACTED_API_KEY]";
  });
  output = output.replace(
    /\b((?:postgres(?:ql)?|mysql):\/\/)[^\s:/]+:[^\s@/]+@/giu,
    (_match, scheme: string) => {
      redacted = true;
      return `${scheme}[REDACTED_CREDENTIALS]@`;
    },
  );
  return { value: output, redacted };
}

/**
 * Recursively replaces credentials while preserving object key order and
 * deterministic report paths. Functions and class instances are treated as
 * opaque values; they are not serialized by the gateway's digest helper.
 */
export function redactModelSecrets(value: unknown): {
  value: unknown;
  report: ModelRedactionReportEntry[];
} {
  const report: ModelRedactionReportEntry[] = [];
  const visit = (current: unknown, path: string): unknown => {
    if (Array.isArray(current)) {
      return current.map((item, index) => visit(item, `${path}[${index}]`));
    }
    if (current !== null && typeof current === "object") {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(current as Record<string, unknown>).sort()) {
        const childPath = `${path}.${key}`;
        if (secretKeyPattern.test(normalizedKey(key))) {
          result[key] = "[REDACTED]";
          report.push({ path: childPath, reason: "sensitive_key" });
        } else {
          result[key] = visit((current as Record<string, unknown>)[key], childPath);
        }
      }
      return result;
    }
    if (typeof current === "string") {
      const redaction = redactString(current);
      if (redaction.redacted) report.push({ path, reason: "secret_pattern" });
      return redaction.value;
    }
    return current;
  };

  return { value: visit(value, "$"), report };
}

/** Scientific compatibility name retained at the shared boundary. */
export const redactScientificContextSecrets = redactModelSecrets;
export type RedactionReportEntry = ModelRedactionReportEntry;
