/**
 * Generate a strict POSIX remote wrapper script for SSH execution.
 *
 * The wrapper uses `exec` so the engine replaces the shell process,
 * making `$$` the engine PID. A `trap cleanup EXIT` guarantees
 * `exit.status` is written even on crash or signal.
 */
/** Encode arbitrary data as one POSIX shell word. */
export function quotePosixShellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

export function generateBashWrapper(command: string, args: string[]): string {
  const escapedArgs = args.map(quotePosixShellWord).join(" ");
  const quotedCmd = quotePosixShellWord(command);
  const fullCommand = args.length > 0 ? `${quotedCmd} ${escapedArgs}` : quotedCmd;

  return [
    "#!/bin/bash",
    "set -u",
    'WRAPPER_DIR="$(cd "$(dirname "$0")" && pwd)"',
    'echo "$$" > "$WRAPPER_DIR/job.pid"',
    "",
    "cleanup() {",
    "  local rc=$?",
    '  echo "$rc" > "$WRAPPER_DIR/exit.status"',
    "  exit $rc",
    "}",
    "trap cleanup EXIT",
    'trap "cleanup; exit 130" INT TERM',
    "",
    `exec ${fullCommand} > "$WRAPPER_DIR/stdout.log" 2>"$WRAPPER_DIR/stderr.log"`,
    "",
  ].join("\n");
}
