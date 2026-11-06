const patterns = [
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/giu,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu,
  /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|secret|credential|authorization)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,;}]+)/giu,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/gu,
  /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^/\s:@]+:[^/\s@]+@/giu,
];
/** Redaction precedes hashing of the retained snapshot. The original source has a separate digest. */
export function redactMemory(value: string, maximumBytes = 4000): string {
  let result = value;
  for (const pattern of patterns) result = result.replace(pattern, "[REDACTED]");
  if (Buffer.byteLength(result) <= maximumBytes) return result;
  return (
    Buffer.from(result)
      .subarray(0, maximumBytes - 20)
      .toString("utf8") + "…[TRUNCATED]"
  );
}
