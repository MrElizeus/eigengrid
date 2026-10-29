import { describe, it, expect } from "bun:test";
import {
  SlashCommands,
  getHelpText,
  getCompletions,
  getSuggestions,
  handleUnknownCommand,
} from "./slash-commands";

describe("SlashCommands map", () => {
  it("contains all expected commands", () => {
    const expectedCommands = [
      "help",
      "init",
      "doctor",
      "status",
      "submit",
      "parse",
      "logs",
      "artifacts",
      "results",
      "events",
      "timeline",
      "node",
      "recipes",
      "collect",
      "worker",
      "agent",
      "plan",
      "connect",
      "providers",
      "models",
      "variants",
      "permissions",
      "key",
      "endpoint",
      "clear",
      "exit",
    ];
    for (const cmd of expectedCommands) {
      expect(SlashCommands.has(cmd)).toBe(true);
    }
    expect(SlashCommands.has("provider")).toBe(false);
    expect(SlashCommands.has("permission")).toBe(false);
    expect(getSuggestions("/pro").map((suggestion) => suggestion.name)).toEqual(["/providers"]);
  });

  it("each command has a non-empty description", () => {
    for (const [, desc] of SlashCommands) {
      expect(desc.length).toBeGreaterThan(0);
    }
  });
});

describe("getHelpText", () => {
  it("returns a formatted string with all commands", () => {
    const help = getHelpText();
    expect(typeof help).toBe("string");
    expect(help.length).toBeGreaterThan(0);
  });

  it("includes each command with a leading slash", () => {
    const help = getHelpText();
    expect(help).toContain("/help");
    expect(help).toContain("/doctor");
    expect(help).toContain("/exit");
  });

  it("includes descriptions for commands", () => {
    const help = getHelpText();
    for (const [, desc] of SlashCommands) {
      expect(help).toContain(desc.slice(0, 20)); // first 20 chars of each desc
    }
  });
});

describe("getCompletions", () => {
  it("returns all commands when partial is empty string", () => {
    const completions = getCompletions("");
    expect(completions).toHaveLength(SlashCommands.size);
  });

  it("returns matching commands for a partial prefix", () => {
    const completions = getCompletions("he");
    expect(completions).toContain("/help");
  });

  it("returns all commands starting with 's'", () => {
    const completions = getCompletions("s");
    for (const cmd of completions) {
      expect(cmd.startsWith("/s")).toBe(true);
    }
  });

  it("returns empty array for no match", () => {
    const completions = getCompletions("zzzz");
    expect(completions).toHaveLength(0);
  });

  it("returns matching commands for a full command", () => {
    const completions = getCompletions("doc");
    expect(completions).toContain("/doctor");
  });

  it("handles partial with leading slash", () => {
    const completions = getCompletions("/doc");
    expect(completions).toContain("/doctor");
  });

  it("is case-insensitive", () => {
    const upper = getCompletions("DOC");
    const lower = getCompletions("doc");
    expect(upper).toEqual(lower);
  });
});

describe("getSuggestions", () => {
  it("returns all commands when input is just '/'", () => {
    const s = getSuggestions("/");
    expect(s).toHaveLength(SlashCommands.size);
    expect(s[0]).toHaveProperty("name");
    expect(s[0]).toHaveProperty("description");
  });

  it("returns matching suggestions for a partial prefix", () => {
    const s = getSuggestions("/do");
    expect(s.length).toBeGreaterThan(0);
    for (const item of s) {
      expect(item.name.startsWith("/do")).toBe(true);
    }
  });

  it("returns suggestions with descriptions", () => {
    const s = getSuggestions("/help");
    expect(s).toHaveLength(1);
    expect(s[0].name).toBe("/help");
    expect(s[0].description.length).toBeGreaterThan(0);
  });

  it("returns empty array when input has a space (second token)", () => {
    expect(getSuggestions("/help ")).toHaveLength(0);
    expect(getSuggestions("/help foo")).toHaveLength(0);
  });

  it("returns empty array when input does not start with '/'", () => {
    expect(getSuggestions("help")).toHaveLength(0);
  });

  it("returns empty array for no match", () => {
    expect(getSuggestions("/zzzz")).toHaveLength(0);
  });

  it("is case-insensitive", () => {
    const upper = getSuggestions("/DOC");
    const lower = getSuggestions("/doc");
    expect(upper).toEqual(lower);
  });

  it("respects the max limit", () => {
    const all = getSuggestions("/");
    const limited = getSuggestions("/", 3);
    expect(limited).toHaveLength(3);
    expect(limited[0]).toEqual(all[0]);
  });

  it("returns full list when max is 0 or not provided", () => {
    const none = getSuggestions("/", 0);
    const all = getSuggestions("/");
    expect(none).toHaveLength(all.length);
  });
});

describe("handleUnknownCommand", () => {
  it("returns a message mentioning the unknown command", () => {
    const msg = handleUnknownCommand("foobar");
    expect(msg).toContain("foobar");
    expect(msg).toContain("/help");
  });

  it("includes the leading slash if provided", () => {
    const msg = handleUnknownCommand("/foobar");
    expect(msg).toContain("/foobar");
  });
});
