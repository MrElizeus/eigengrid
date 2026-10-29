import type { SlurmSubmitOptions } from "./types";
import { SLURM_ENGINE_SUPERVISOR } from "./engine-supervisor";

export interface SlurmCommand {
  executable: string;
  argv: readonly string[];
}

function shellQuote(value: string): string {
  if (hasControlCharacter(value)) {
    throw new Error("Slurm script values must not contain control characters");
  }
  // Keep the historical double-quoted rendering while escaping every
  // interpolation metacharacter that has meaning inside double quotes.
  return `"${value.replace(/[\\"$`]/g, "\\$&")}"`;
}

function directive(value: string): string {
  if (hasControlCharacter(value)) {
    throw new Error("Slurm directive values must not contain control characters");
  }
  // sbatch directives have their own argument lexer; shell expansion is not used.
  return /^[A-Za-z0-9_./%+:@=-]+$/u.test(value) ? value : `"${value.replace(/[\\"]/gu, "\\$&")}"`;
}

function validateTextOption(value: string | undefined, label: string): string | null {
  if (value !== undefined && hasControlCharacter(value)) {
    return `${label} must not contain control characters`;
  }
  return null;
}

/** Quote one untrusted value as a literal POSIX shell word. */
export function shellQuoteWord(value: string): string {
  if (value.includes("\0") || value.includes("\r") || value.includes("\n")) {
    throw new Error("Slurm shell words must not contain NUL, CR, or LF characters");
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function validateSubmitOptions(opts: SlurmSubmitOptions): string | null {
  for (const [value, label] of [
    [opts.jobName, "jobName"],
    [opts.partition, "partition"],
    [opts.account, "account"],
    [opts.qos, "qos"],
    [opts.output, "output"],
    [opts.error, "error"],
    [opts.chdir, "chdir"],
  ] as const) {
    const error = validateTextOption(value, label);
    if (error) return error;
  }

  for (const [key, value] of Object.entries(opts.envVars ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) return "env var name is invalid";
    if (/^(?:BASH_ENV|ENV|SHELLOPTS|BASHOPTS|IFS|PATH|PYTHON.*|LD_.*|SLURM_.*)$/u.test(key)) {
      return `env var ${key} is reserved`;
    }
    const error = validateTextOption(value, `env var ${key}`);
    if (error) return error;
  }

  if (opts.mem !== undefined && !/^(\d+[KMGTPE]|\d+)$/i.test(opts.mem)) {
    return "Invalid mem format";
  }

  if (opts.time !== undefined && !/^(\d+:\d{2}:\d{2}|\d+-\d{2}:\d{2}:\d{2})$/.test(opts.time)) {
    return "Invalid time format";
  }

  if (opts.cpusPerTask !== undefined && opts.cpusPerTask <= 0) {
    return "cpusPerTask must be greater than 0";
  }

  if (opts.nodes !== undefined && opts.nodes <= 0) {
    return "nodes must be greater than 0";
  }

  if (opts.ntasks !== undefined && opts.ntasks <= 0) {
    return "ntasks must be greater than 0";
  }

  for (const [value, label] of [
    [opts.cpusPerTask, "cpusPerTask"],
    [opts.nodes, "nodes"],
    [opts.ntasks, "ntasks"],
  ] as const) {
    if (value !== undefined && !Number.isSafeInteger(value)) return `${label} must be an integer`;
  }
  for (const [value, label] of [
    [opts.partition, "partition"],
    [opts.account, "account"],
    [opts.qos, "qos"],
  ] as const) {
    if (value !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value)) {
      return `${label} must be a single scheduler identifier`;
    }
  }

  return null;
}

export function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Historical trusted-shell interface. Production callers use buildSlurmCommandScript. */
export function buildSlurmScript(command: string, opts: SlurmSubmitOptions): string {
  return buildSlurmCommandScript(
    { executable: "/bin/bash", argv: ["-o", "pipefail", "-c", command] },
    opts,
  );
}

/** Render one structured engine invocation with an exact exit/signal receipt. */
export function buildSlurmCommandScript(command: SlurmCommand, opts: SlurmSubmitOptions): string {
  return buildStructuredScript(command, opts, true);
}

/** Registered runner entrypoint only. The runner owns workspace creation and
 * engine supervision, so no relative claim is written in the batch launch cwd.
 * This renderer grants no execution authority and accepts no client shell code.
 */
export function buildSlurmRunnerScript(command: SlurmCommand, opts: SlurmSubmitOptions): string {
  if (!command.executable.startsWith("/")) throw new Error("Runner must be an absolute site path");
  return buildStructuredScript(command, opts, false);
}

function buildStructuredScript(
  command: SlurmCommand,
  opts: SlurmSubmitOptions,
  supervise: boolean,
): string {
  const validationError = validateSubmitOptions(opts);
  if (validationError) throw new Error(validationError);
  if (!command.executable || command.executable.startsWith("-") || command.argv.length > 256) {
    throw new Error("Invalid structured Slurm command");
  }
  const words = [command.executable, ...command.argv].map(shellQuoteWord);
  const lines: string[] = ["#!/bin/bash"];

  lines.push(`#SBATCH --job-name=${directive(opts.jobName ?? "eigengrid-job")}`);
  // Re-execution requires a new coordinator-authorized attempt/checkpoint,
  // never automatic Slurm replay of an uncertain external effect.
  lines.push("#SBATCH --no-requeue");

  if (opts.partition !== undefined) {
    lines.push(`#SBATCH --partition=${directive(opts.partition)}`);
  }

  if (opts.account !== undefined) {
    lines.push(`#SBATCH --account=${directive(opts.account)}`);
  }

  if (opts.qos !== undefined) {
    lines.push(`#SBATCH --qos=${directive(opts.qos)}`);
  }

  lines.push(`#SBATCH --cpus-per-task=${directive(String(opts.cpusPerTask ?? 1))}`);

  if (opts.mem !== undefined) {
    lines.push(`#SBATCH --mem=${directive(opts.mem)}`);
  }

  lines.push(`#SBATCH --time=${directive(opts.time ?? "01:00:00")}`);
  lines.push(`#SBATCH --nodes=${directive(String(opts.nodes ?? 1))}`);
  lines.push(`#SBATCH --ntasks=${directive(String(opts.ntasks ?? 1))}`);
  lines.push(`#SBATCH --output=${directive(opts.output ?? "%x-%j.out")}`);
  lines.push(`#SBATCH --error=${directive(opts.error ?? "%x-%j.err")}`);

  if (opts.chdir !== undefined) {
    lines.push(`#SBATCH --chdir=${directive(opts.chdir)}`);
  }

  lines.push("");
  lines.push("set -euo pipefail", "umask 077");

  if (opts.chdir === undefined) {
    lines.push('cd -- "$SLURM_SUBMIT_DIR"');
  } else {
    lines.push(`cd -- ${shellQuoteWord(opts.chdir)}`);
  }

  lines.push('export OMP_NUM_THREADS="${SLURM_CPUS_PER_TASK:-1}"');

  for (const [key, value] of Object.entries(opts.envVars ?? {})) {
    lines.push(`export ${key}=${shellQuote(value)}`);
  }

  if (supervise) {
    lines.push(`exec /usr/bin/python3 -I - ${words.join(" ")} <<'EIGENGRID_ENGINE_V1'`);
    lines.push(SLURM_ENGINE_SUPERVISOR, "EIGENGRID_ENGINE_V1", "");
  } else {
    lines.push(`exec ${words.join(" ")}`, "");
  }

  return lines.join("\n");
}
