// ── URL redaction ──────────────────────────────────────────

/**
 * Redact DATABASE_URL for safe logging/display.
 * Preserves `postgres://user:***@host:port/dbname`.
 */
export function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return url;
    if (!parsed.username && !parsed.password) return url;
    parsed.password = "***";
    return parsed.toString();
  } catch {
    // Preserve a safe fallback for malformed URLs found in log lines.
    return url.replace(/(postgres(?:ql)?:\/\/[^\s/:@]+:)[^\s/?#]*(@)/gi, "$1***$2");
  }
}
