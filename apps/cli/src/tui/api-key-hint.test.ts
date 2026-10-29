import { describe, expect, it } from "bun:test";

import { getApiKeyHint, getApiKeyStatusHint, isInvalidApiKeyError } from "./api-key-hint";

describe("api-key hint", () => {
  it("detects invalid api key errors", () => {
    expect(isInvalidApiKeyError("[Error: Invalid API key.]")).toBe(true);
    expect(isInvalidApiKeyError("something else")).toBe(false);
  });

  it("builds a green hint for invalid api key errors", () => {
    expect(getApiKeyHint("[Error: Invalid API key.]")).toContain("/key <api-key>");
    expect(getApiKeyHint("[Error: Invalid API key.]")).toContain("/configure");
    expect(getApiKeyHint("other error")).toBeNull();
  });

  it("builds a status hint for configured, env, and missing api keys", () => {
    expect(getApiKeyStatusHint({ apiKey: "sk-1234567890abcdef" })).toContain("configured");
    expect(getApiKeyStatusHint({ envKey: "OPENCODE_API_KEY" })).toContain("OPENCODE_API_KEY");
    expect(getApiKeyStatusHint({})).toContain("missing");
  });
});
