import { describe, it, expect } from "bun:test";
import { CommandBuilder } from "./command-builder";

describe("CommandBuilder", () => {
  describe("constructor", () => {
    it("creates a builder with an allowed commands list", () => {
      const builder = new CommandBuilder(["python3", "git"]);
      expect(builder).toBeDefined();
    });
  });

  describe("isAllowed", () => {
    it("returns true for a command in the allowed list", () => {
      const builder = new CommandBuilder(["python3", "git"]);
      expect(builder.isAllowed("python3")).toBe(true);
      expect(builder.isAllowed("git")).toBe(true);
    });

    it("returns false for a command not in the allowed list", () => {
      const builder = new CommandBuilder(["python3"]);
      expect(builder.isAllowed("rm")).toBe(false);
      expect(builder.isAllowed("curl")).toBe(false);
      expect(builder.isAllowed("")).toBe(false);
    });

    it("is case-sensitive", () => {
      const builder = new CommandBuilder(["Python3"]);
      expect(builder.isAllowed("python3")).toBe(false);
      expect(builder.isAllowed("Python3")).toBe(true);
    });
  });

  describe("buildCommand", () => {
    it("returns command and args for an allowed command with args", () => {
      const builder = new CommandBuilder(["python3", "git"]);
      const result = builder.buildCommand("python3", ["--version"]);
      expect(result).toEqual({ command: "python3", args: ["--version"] });
    });

    it("returns command and empty args for an allowed command without args", () => {
      const builder = new CommandBuilder(["python3"]);
      const result = builder.buildCommand("python3", []);
      expect(result).toEqual({ command: "python3", args: [] });
    });

    it("throws for a command not in the allowed list", () => {
      const builder = new CommandBuilder(["python3"]);
      expect(() => builder.buildCommand("rm", ["-rf", "/"])).toThrow("not in the allowed list");
    });

    it("throws for empty command string", () => {
      const builder = new CommandBuilder(["python3"]);
      expect(() => builder.buildCommand("", [])).toThrow();
    });

    it("rejects shell metacharacters in args", () => {
      const builder = new CommandBuilder(["python3"]);
      expect(() => builder.buildCommand("python3", ["--version; rm -rf /"])).toThrow("unsafe");
      expect(() => builder.buildCommand("python3", ["$(cat /etc/passwd)"])).toThrow("unsafe");
      expect(() => builder.buildCommand("python3", ["`ls`"])).toThrow("unsafe");
      expect(() => builder.buildCommand("python3", ["arg|other"])).toThrow("unsafe");
      expect(() => builder.buildCommand("python3", ["arg&other"])).toThrow("unsafe");
    });

    it("allows safe arguments", () => {
      const builder = new CommandBuilder(["python3"]);
      const result = builder.buildCommand("python3", [
        "-c",
        "print('hello')",
        "--flag=value",
        "/path/to/file",
      ]);
      expect(result).toEqual({
        command: "python3",
        args: ["-c", "print('hello')", "--flag=value", "/path/to/file"],
      });
    });

    it("does not mutate the builder's state between calls", () => {
      const builder = new CommandBuilder(["python3"]);
      const a = builder.buildCommand("python3", ["--version"]);
      const b = builder.buildCommand("python3", ["-c", "print(1)"]);
      expect(a).toEqual({ command: "python3", args: ["--version"] });
      expect(b).toEqual({ command: "python3", args: ["-c", "print(1)"] });
    });
  });

  describe("getAllowedCommands", () => {
    it("returns a copy of the allowed commands list", () => {
      const builder = new CommandBuilder(["python3", "git"]);
      const list = builder.getAllowedCommands();
      expect(list).toEqual(["python3", "git"]);
      // Ensure it's a copy
      list.push("hacked");
      expect(builder.getAllowedCommands()).toEqual(["python3", "git"]);
    });
  });
});
