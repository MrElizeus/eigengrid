const patterns = [
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/giu,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu,
  /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|secret|credential|authorization)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,;}]+)/giu,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/gu,
  /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^/\s:@]+:[^/\s@]+@/giu,
];
const secretKey =
  /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|secret|credential|authorization)$/iu;

/** Sanitize structured snapshots before escaping embedded tool text again. */
function redactStructured(value: unknown, depth = 0): unknown {
  if (depth > 32) return "[REDACTED: NESTING LIMIT]";
  if (typeof value === "string") {
    // Tool results often contain JSON file contents inside a JSON string.
    if (/^\s*[[{"]/u.test(value)) {
      try {
        return JSON.stringify(redactStructured(JSON.parse(value), depth + 1));
      } catch {
        // Non-JSON text is still checked for ordinary credential patterns.
      }
    }
    for (const pattern of patterns) value = (value as string).replace(pattern, "[REDACTED]");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redactStructured(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        secretKey.test(key) ? "[REDACTED]" : redactStructured(item, depth + 1),
      ]),
    );
  return value;
}
/** Redaction precedes hashing of the retained snapshot. The original source has a separate digest. */
export function redactMemory(value: string, maximumBytes = 4000): string {
  const result = redactStructured(value) as string;
  if (Buffer.byteLength(result) <= maximumBytes) return result;
  return (
    Buffer.from(result)
      .subarray(0, maximumBytes - 20)
      .toString("utf8") + "…[TRUNCATED]"
  );
}
