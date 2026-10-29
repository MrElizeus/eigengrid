export function isInvalidApiKeyError(text: string): boolean {
  return /invalid api key/i.test(text);
}

export function getApiKeyHint(errorText: string | null): string | null {
  if (!errorText) return null;
  return isInvalidApiKeyError(errorText)
    ? "API key issue detected. Use /key <api-key> or /configure."
    : null;
}

export function getApiKeyStatusHint(options: {
  apiKey?: string | null;
  envKey?: string | null;
}): string {
  if (options.apiKey) {
    const key = options.apiKey;
    const short =
      key.length > 12 ? `${key.slice(0, 8)}...${key.slice(-4)}` : `${key.slice(0, 4)}...`;
    return `API key configured (${short}) · Use /key --forget to drop it.`;
  }

  if (options.envKey) {
    return `API key provided by ${options.envKey} · Use /key <api-key> to override.`;
  }

  return "API key missing · Use /key <api-key> or /configure.";
}
