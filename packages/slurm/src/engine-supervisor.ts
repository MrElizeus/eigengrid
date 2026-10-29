/** Fixed runner source: command values are positional argv, never Python source.
 * This records a process observation only; it cannot mutate EigenGrid state.
 * Python is the Ubuntu site's pinned /usr/bin/python3, in isolated mode.
 */
export const SLURM_ENGINE_SUPERVISOR = String.raw`import hashlib
import json
import os
import signal
import socket
import subprocess
import sys
import time

os.umask(0o077)
argv = sys.argv[1:]
if not argv or any(os.path.lexists(p) for p in ("engine.exit.json", "exit.status", "engine.started.json")):
    sys.exit(73)  # An uncertain prior launch is not permission to replay.

command_digest = hashlib.sha256(json.dumps(argv, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
started = time.time_ns()
claim = {
    "schema": "eigengrid.engine-start/v1",
    "commandDigest": command_digest,
    "startedAtNs": str(started),
    "hostname": socket.gethostname(),
    "uid": os.getuid(),
    "gid": os.getgid(),
    "slurmJobId": os.environ.get("SLURM_JOB_ID"),
}
claim_bytes = (json.dumps(claim, sort_keys=True) + "\n").encode()
try:
    descriptor = os.open("engine.started.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(claim_bytes)
        stream.flush()
        os.fsync(stream.fileno())
    descriptor = os.open(".", os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
except FileExistsError:
    sys.exit(73)
except OSError:
    sys.exit(74)  # No engine starts unless its exclusive claim is durable.

child = None
pending_signals = []

def kill_engine(_signum, _frame):
    if child is not None:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

signal.signal(signal.SIGALRM, kill_engine)

def forward(signum, _frame):
    if not pending_signals:
        signal.setitimer(signal.ITIMER_REAL, 5)
    pending_signals.append(signum)
    if child is not None:
        try:
            os.killpg(child.pid, signum)
        except ProcessLookupError:
            pass

for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGUSR1, signal.SIGUSR2):
    signal.signal(signum, forward)

def publish(path, data):
    temporary = path + ".tmp." + str(os.getpid())
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    descriptor = os.open(".", os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

execution_error = None
try:
    if pending_signals:
        result = -pending_signals[-1]
    else:
        child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, start_new_session=True)
        if pending_signals:
            signal.setitimer(signal.ITIMER_REAL, 5)
        for signum in pending_signals:
            try:
                os.killpg(child.pid, signum)
            except ProcessLookupError:
                pass
        result = child.wait()
except OSError as error:
    result = 127
    execution_error = error.strerror

signal.setitimer(signal.ITIMER_REAL, 0)
# No engine descendant may outlive its supervising effect or keep log pipes
# open after its leader exits. This is the engine's new session, not another job.
kill_engine(None, None)

receipt = {
    "schema": "eigengrid.engine-exit/v1",
    "commandDigest": command_digest,
    "claimDigest": hashlib.sha256(claim_bytes).hexdigest(),
    "startedAtNs": str(started),
    "finishedAtNs": str(time.time_ns()),
    "exitCode": result if result >= 0 else None,
    "signal": -result if result < 0 else None,
    "supervisorSignals": pending_signals,
    "executionError": execution_error,
}
batch_status = result if result >= 0 else 128 - result
try:
    publish("engine.exit.json", (json.dumps(receipt, sort_keys=True) + "\n").encode())
    publish("exit.status", (str(batch_status) + "\n").encode())
except OSError:
    # A successful engine with an unpublishable receipt is not a successful batch.
    sys.exit(batch_status or 74)
sys.exit(batch_status)
`;
