// ────────────────────────────────────────────────────────────
// CommandBuilder — Typed, safe command construction
// ────────────────────────────────────────────────────────────

/**
 * Shell metacharacters that are rejected in command arguments.
 * These characters can be used for shell injection if the command
 * is passed to a shell interpreter.
 */
// Shell metacharacters that are rejected in arguments even when using spawn.
// This is a defense-in-depth measure: the primary protection is the allowed list.
const UNSAFE_PATTERN = /[;&|`]|\$\(|\${|>/;

export class CommandBuilder {
  private readonly allowed: Set<string>;

  /**
   * @param allowedCommands List of base commands that are safe to execute.
   */
  constructor(allowedCommands: string[]) {
    this.allowed = new Set(allowedCommands);
  }

  /**
   * Check whether a base command is in the allowed list.
   */
  isAllowed(cmd: string): boolean {
    return this.allowed.has(cmd);
  }

  /**
   * Build a safe command object from a base command and arguments.
   *
   * Validates that:
   * 1. The base command is in the allowed list
   * 2. No shell metacharacters appear in arguments
   *
   * Returns a `{ command, args }` tuple ready for safe execution
   * via `child_process.spawn` or equivalent.
   *
   * @throws {Error} if the command is not allowed or args contain unsafe characters.
   */
  buildCommand(base: string, args: string[]): { command: string; args: string[] } {
    if (!this.allowed.has(base)) {
      throw new Error(`Command '${base}' is not in the allowed list`);
    }

    for (const arg of args) {
      if (UNSAFE_PATTERN.test(arg)) {
        throw new Error(`Argument contains unsafe shell characters: '${arg.slice(0, 50)}'`);
      }
    }

    return { command: base, args: [...args] };
  }

  /**
   * Get a copy of the allowed commands list.
   */
  getAllowedCommands(): string[] {
    return Array.from(this.allowed);
  }
}
