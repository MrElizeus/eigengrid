// ────────────────────────────────────────────────────────────
// Redaction utilities for secrets in exported data
// ────────────────────────────────────────────────────────────

import type { RedactionPattern } from "./types";

/**
 * Default set of redaction patterns for common secrets.
 * These match JSON values that look like API keys, tokens, etc.
 */
export const DEFAULT_REDACTION_PATTERNS: RedactionPattern[] = [
  {
    name: "OpenAI API Key",
    regex: /sk-[A-Za-z0-9]{20,}/g,
    replacement: "sk-***REDACTED***",
  },
  {
    name: "Anthropic API Key",
    regex: /sk-ant-[A-Za-z0-9]{20,}/g,
    replacement: "sk-ant-***REDACTED***",
  },
  {
    name: "Generic API Key",
    regex: /(api[_-]?key|apikey)\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}["']?/gi,
    replacement: "$1: ***REDACTED***",
  },
  {
    name: "Bearer Token",
    regex: /Bearer\s+[A-Za-z0-9\-._~+/]{20,}/g,
    replacement: "Bearer ***REDACTED***",
  },
  {
    name: "Private Key PEM",
    regex:
      /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
    replacement: "-----BEGIN PRIVATE KEY-----***REDACTED***-----END PRIVATE KEY-----",
  },
  {
    name: "Password in URL",
    regex: /([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/?#]*(@)/gi,
    replacement: "$1***REDACTED***$2",
  },
  {
    name: "JWT Token",
    regex: /eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g,
    replacement: "***JWT-REDACTED***",
  },
  {
    name: "SSH Private Key path pattern",
    regex: /(ssh[_-]?key[_-]?path|private[_-]?key[_-]?path)\s*[:=]\s*["']?([^"'\\\n]*)["']?/gi,
    replacement: "$1: ***REDACTED***",
  },
  {
    name: "Generic Token",
    regex: /[tT]oken\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}["']?/g,
    replacement: "token: ***REDACTED***",
  },
  {
    name: "Password field",
    regex: /"password"\s*:\s*"[^"]+"/g,
    replacement: '"password": "***REDACTED***"',
  },
  {
    name: "LLM API key field",
    regex: /"llm[_-]?key"\s*:\s*"[^"]+"/gi,
    replacement: '"llm_key": "***REDACTED***"',
  },
  {
    name: "Secret field",
    regex: /"secret"\s*:\s*"[^"]+"/gi,
    replacement: '"secret": "***REDACTED***"',
  },
  {
    name: "DATABASE_URL connection string",
    regex: /(postgres(?:ql)?:\/\/[^\s/:@]+:)[^\s/?#]*(@)/gi,
    replacement: "$1***$2",
  },
  {
    name: "Password assignment",
    regex: /((?:password|passwd|pwd)\s*[=:]\s*)[^\s,;]+/gi,
    replacement: "$1***REDACTED***",
  },
  {
    name: "DATABASE_URL value pattern",
    regex: /(DATABASE_URL\s*=|databaseUrl\s*[:=])\s*["']?(postgres:\/\/[^"\s'\\n]+)["']?/gi,
    replacement: "$1 postgres://***:*@***",
  },
];

/**
 * Redact secrets from a string using the default redaction patterns.
 */
export function redactString(
  input: string,
  patterns: RedactionPattern[] = DEFAULT_REDACTION_PATTERNS,
): string {
  let result = input;
  for (const pattern of patterns) {
    result = result.replace(pattern.regex, pattern.replacement);
  }
  return result;
}

/**
 * Recursively redact secrets from a JSON-compatible object.
 * Handles nested objects, arrays, strings.
 */
export function redactObject<T>(
  input: T,
  patterns: RedactionPattern[] = DEFAULT_REDACTION_PATTERNS,
): T {
  if (typeof input === "string") {
    return redactString(input, patterns) as unknown as T;
  }

  if (Array.isArray(input)) {
    return input.map((item) => redactObject(item, patterns)) as unknown as T;
  }

  if (input !== null && typeof input === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      // Redact values of known sensitive keys
      const sensitiveKey = isSensitiveKey(key);
      if (sensitiveKey && typeof value === "string") {
        result[key] = "***REDACTED***";
      } else {
        result[key] = redactObject(value, patterns);
      }
    }
    return result as unknown as T;
  }

  return input;
}

/**
 * Check if a key name suggests sensitive content.
 */
function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  const sensitive = [
    "password",
    "secret",
    "apikey",
    "api_key",
    "api-key",
    "token",
    "privatekey",
    "private_key",
    "private-key",
    "sshkey",
    "ssh_key",
    "ssh-key",
    "llm_key",
    "llmkey",
    "llm-key",
    "auth_token",
    "authtoken",
    "bearer",
    "access_token",
    "refresh_token",
    "databaseurl",
    "database_url",
    "database-url",
  ];
  return sensitive.includes(lower);
}

/**
 * Redact a JSON string by parsing, redacting, and re-serializing.
 */
export function redactJson(
  json: string,
  patterns: RedactionPattern[] = DEFAULT_REDACTION_PATTERNS,
): string {
  try {
    const parsed = JSON.parse(json);
    const redacted = redactObject(parsed, patterns);
    return JSON.stringify(redacted);
  } catch {
    // If not valid JSON, redact as plain text
    return redactString(json, patterns);
  }
}
