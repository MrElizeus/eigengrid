import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export const DURABLE_EXIT_STATUS_VERSION = 1;

export interface DurableExitStatus {
  version: typeof DURABLE_EXIT_STATUS_VERSION;
  exitCode: number;
  finishedAt: number;
}

const TRAVERSAL = /(^|[\\/])\.\.([\\/]|$)/u;

function assertSafeAttemptId(attemptId: string): void {
  const hasUnsafeCharacter = [...attemptId].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f || "/\\:&|`$><*?[]()#;'\"".includes(character);
  });
  if (
    attemptId.length === 0 ||
    attemptId === "." ||
    attemptId === ".." ||
    TRAVERSAL.test(attemptId) ||
    hasUnsafeCharacter
  ) {
    throw new Error(`Unsafe attempt ID for durable exit status: ${attemptId}`);
  }
}

export function durableExitStatusPath(jobDir: string, attemptId: string): string {
  assertSafeAttemptId(attemptId);
  const base = resolve(join(jobDir, ".eigengrid"));
  const path = resolve(join(base, `exit-${attemptId}.status`));
  if (!path.startsWith(`${base}${sep}`)) {
    throw new Error("Durable exit status path escapes job directory");
  }
  return path;
}

/**
 * Fixed repository-owned wrapper. No user or scientific input is interpolated
 * into this source; the typed engine command and arguments are positional.
 */
const DURABLE_SUPERVISOR_SCRIPT = [
  "status_path=$1",
  "stdout_path=$2",
  "stderr_path=$3",
  "timeout_ms=$4",
  "shift 4",
  "supervisor_pid=$$",
  "child=''",
  "watchdog=''",
  "force_killer=''",
  "pending_terminal_code=''",
  "write_status() {",
  "  code=$1",
  "  finished_at=$(( $(date +%s) * 1000 ))",
  '  tmp_path="${status_path}.tmp.$$"',
  "  umask 077",
  `  printf '${DURABLE_EXIT_STATUS_VERSION}\\n%s\\n%s\\n' "$code" "$finished_at" > "$tmp_path"`,
  '  mv -f "$tmp_path" "$status_path"',
  "}",
  "stop_watchdog() {",
  '  if [ -z "$watchdog" ]; then return; fi',
  '  kill "$watchdog" 2>/dev/null || true',
  '  wait "$watchdog" 2>/dev/null || true',
  "  watchdog=''",
  "}",
  "signal_child_group() {",
  "  signal=$1",
  '  if [ -z "$child" ]; then return; fi',
  '  kill "-$signal" "-$child" 2>/dev/null || kill "-$signal" "$child" 2>/dev/null || true',
  "}",
  "child_group_exists() {",
  '  [ -n "$child" ] && kill -0 "-$child" 2>/dev/null',
  "}",
  "terminate_tree() {",
  "  terminal_code=$1",
  '  if [ -z "$child" ]; then pending_terminal_code=$terminal_code; return; fi',
  "  trap '' TERM INT HUP USR1",
  "  stop_watchdog",
  '  if [ -n "$child" ]; then',
  "    signal_child_group TERM",
  '    ( sleep 1; kill -KILL "-$child" 2>/dev/null || true ) &',
  "    force_killer=$!",
  '    wait "$child" 2>/dev/null || true',
  "    if child_group_exists; then",
  '      wait "$force_killer" 2>/dev/null || true',
  "    else",
  '      kill "$force_killer" 2>/dev/null || true',
  '      wait "$force_killer" 2>/dev/null || true',
  "    fi",
  "  fi",
  '  write_status "$terminal_code"',
  '  exit "$terminal_code"',
  "}",
  "cleanup_lingering_group() {",
  "  if ! child_group_exists; then return; fi",
  '  kill -TERM "-$child" 2>/dev/null || true',
  "  sleep 1",
  '  kill -KILL "-$child" 2>/dev/null || true',
  "}",
  "trap 'terminate_tree 143' TERM",
  "trap 'terminate_tree 130' INT",
  "trap 'terminate_tree 129' HUP",
  "trap 'terminate_tree 124' USR1",
  "if command -v setsid >/dev/null 2>&1; then",
  '  setsid "$@" >"$stdout_path" 2>"$stderr_path" &',
  "elif command -v python3 >/dev/null 2>&1; then",
  `  python3 -c 'import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' "$@" >"$stdout_path" 2>"$stderr_path" &`,
  "else",
  '  : >"$stdout_path"',
  "  printf 'Durable local supervision requires setsid or Python os.setsid support\\n' >\"$stderr_path\"",
  "  write_status 125",
  "  exit 125",
  "fi",
  "child=$!",
  'if [ -n "$pending_terminal_code" ]; then terminate_tree "$pending_terminal_code"; fi',
  'if [ "$timeout_ms" -gt 0 ] 2>/dev/null; then',
  "  timeout_seconds=$(( (timeout_ms + 999) / 1000 ))",
  '  ( sleep "$timeout_seconds"; kill -USR1 "$supervisor_pid" 2>/dev/null || true ) &',
  "  watchdog=$!",
  "fi",
  'wait "$child"',
  "code=$?",
  "stop_watchdog",
  "cleanup_lingering_group",
  'write_status "$code"',
  'exit "$code"',
].join("\n");

export interface DurableSupervisorInvocation {
  command: "/bin/sh";
  args: string[];
  statusPath: string;
}

export function buildDurableSupervisorInvocation(input: {
  jobDir: string;
  attemptId: string;
  stdoutPath: string;
  stderrPath: string;
  command: string;
  args: readonly string[];
  timeoutMs?: number;
}): DurableSupervisorInvocation {
  if (process.platform === "win32") {
    throw new Error("Durable local supervision requires a POSIX process model");
  }
  const statusPath = durableExitStatusPath(input.jobDir, input.attemptId);
  mkdirSync(dirname(statusPath), { recursive: true, mode: 0o700 });
  return {
    command: "/bin/sh",
    args: [
      "-c",
      DURABLE_SUPERVISOR_SCRIPT,
      "eigengrid-durable-local-supervisor",
      statusPath,
      input.stdoutPath,
      input.stderrPath,
      String(Math.max(0, Math.floor(input.timeoutMs ?? 0))),
      input.command,
      ...input.args,
    ],
    statusPath,
  };
}

export function readDurableExitStatus(jobDir: string, attemptId: string): DurableExitStatus | null {
  const path = durableExitStatusPath(jobDir, attemptId);
  if (!existsSync(path)) return null;
  let fields: string[];
  try {
    fields = readFileSync(path, "utf8").trim().split("\n");
  } catch {
    return null;
  }
  if (fields.length !== 3) return null;
  const version = Number(fields[0]);
  const exitCode = Number(fields[1]);
  const finishedAt = Number(fields[2]);
  if (
    version !== DURABLE_EXIT_STATUS_VERSION ||
    !Number.isInteger(exitCode) ||
    exitCode < 0 ||
    exitCode > 255 ||
    !Number.isSafeInteger(finishedAt) ||
    finishedAt <= 0
  ) {
    return null;
  }
  return { version, exitCode, finishedAt };
}
