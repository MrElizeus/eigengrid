"""Isolated rootless-container supervisor and test-only external effect counter.

Real root-owned files, socket, journal fsync, SO_PEERCRED and Ed25519 boundary.
The counted backend DOES NOT run Slurm, Amber or qualify scientific acceptance.
The only injected failures are the socket ACK and a pre-claim disconnect.
"""

import json
import os
import signal
import socket
import subprocess
import sys
import traceback
from pathlib import Path

import eigengrid_submitter.boundary as boundary_module
from eigengrid_submitter.authority import AuthorityError, SubmitterPolicy, strict_json
from eigengrid_submitter.boundary import SubmitterBoundary, send_frame
from eigengrid_submitter.journal import JournalError, TransportJournal, bootstrap_record

ROOT = Path("/fixture")
CONTROL = ROOT / "control"
NOW = 1787443500000  # 2026-08-23T00:05:00.000Z, same explicit fixture clock as PG.


def drop_identity(uid, gid):
    os.setgroups([1000])
    os.setgid(gid)
    os.setuid(uid)


def policy():
    value = json.loads((ROOT / "policy.json").read_text())
    return SubmitterPolicy(
        uid=value["uid"],
        gid=value["gid"],
        head_uid=value["headUid"],
        recovery_epoch=value["recoveryEpoch"],
        site_profile_digest=value["siteProfileDigest"],
        public_key_hex=value["publicKeyHex"],
        memberships={
            (m["subject"], m["projectId"]): m["generation"]
            for m in value["memberships"]
        },
    )


class CountedBackend:
    def __init__(self):
        self.counts = {
            "submits": 0,
            "observations": 0,
            "prepares": 0,
            "releases": 0,
            "claims": 0,
        }
        self.journal = None

    def snapshot(self):
        self.counts["claims"] = len(self.journal.claims) if self.journal else 0
        path = CONTROL / "counts.tmp"
        path.write_text(json.dumps(self.counts))
        path.replace(CONTROL / "counts.json")

    def prepare(self, request):
        self.counts["prepares"] += 1
        body = strict_json(request.body)
        # Closed test protocol: actual signed Amber transport, never arbitrary commands.
        if (
            set(body) != {"schemaVersion", "request", "binding", "bundle"}
            or body["schemaVersion"] != "eigengrid.amber-slurm-delivery/v1"
        ):
            raise ValueError("Expected canonical Amber fixture delivery")
        if body["binding"]["operationId"] != request.capability["operationId"]:
            raise ValueError("Wrong operation")
        self.snapshot()
        return body

    def submit(self, body):
        self.counts["submits"] += 1
        self.snapshot()
        return {
            "status": "acknowledged",
            "resubmitAllowed": False,
            "jobId": str(9000 + self.counts["submits"]),
            "cluster": body["binding"]["cluster"],
        }

    def observe(self, body):
        self.counts["observations"] += 1
        self.snapshot()
        binding = body["binding"]
        identity = {
            "jobId": "9001",
            "cluster": binding["cluster"],
            "uid": binding["uid"],
            "submittedAt": binding["notBefore"].replace(".000Z", "Z"),
        }
        marker = "egv1:" + binding["bindingDigest"]
        return {
            "status": "matched",
            "resubmitAllowed": False,
            "reason": "Test-only counted scheduler identity",
            "identity": identity,
            "markerEvidence": "accounting_comment",
            "observations": [
                {
                    **identity,
                    "source": "sacct",
                    "jobName": "egv1-" + binding["bindingDigest"],
                    "marker": marker,
                }
            ],
        }

    def release(self, _):
        self.counts["releases"] += 1
        self.snapshot()


def serve(listener, fd):
    drop_identity(2101, 2101)
    journal = TransportJournal(fd, "counted-journal", 2101)
    os.close(fd)
    backend = CountedBackend()
    backend.journal = journal
    backend.snapshot()
    boundary = SubmitterBoundary(journal, policy, backend, lambda: NOW)
    (CONTROL / "ready").write_text("ready")
    while True:
        connection, _ = listener.accept()
        with connection:
            mode = (
                (CONTROL / "mode").read_text().strip()
                if (CONTROL / "mode").exists()
                else "normal"
            )
            if mode == "no_claim":
                continue  # Simulate process loss before authenticated claim consumption.
            original_send = boundary_module.send_frame
            if mode == "lost_ack":
                boundary_module.send_frame = lambda *_: (
                    None
                )  # Durable claim+receipt; only ACK lost.
            try:
                boundary.serve_one(connection)
            except (AuthorityError, JournalError, OSError, ValueError):
                send_frame(connection, {"status": "rejected", "resubmitAllowed": False})
            finally:
                boundary_module.send_frame = original_send
                backend.snapshot()


def main():
    if os.getuid() != 0 or os.environ.get("EIGENGRID_MD_BOUNDARY_CONTAINER") != "1":
        raise RuntimeError("This supervisor runs only inside its disposable container")
    subprocess.run(["/bun", "tests/e2e/helpers/md-protected-site.ts"], check=True)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(ROOT / "submitter.sock"))
    os.chown(ROOT / "submitter.sock", 0, 1000)
    os.chmod(ROOT / "submitter.sock", 0o660)
    listener.listen(16)
    with (ROOT / "journal").open("xb") as stream:
        stream.write(bootstrap_record("counted-journal", 2101))
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(ROOT / "journal", 0o600)
    fd = os.open(ROOT / "journal", os.O_RDWR | os.O_APPEND)
    child = os.fork()
    if child == 0:
        try:
            serve(listener, fd)
        except Exception:  # noqa: BLE001 - supervisor must surface every child failure
            traceback.print_exc()
        finally:
            os._exit(0)
    listener.close()
    os.close(fd)
    try:
        result = subprocess.run(
            [
                "/bun",
                "test",
                "--timeout",
                "30000",
                "tests/e2e/canonical-md-pg-submitter.test.ts",
            ],
            preexec_fn=lambda: drop_identity(1000, 1000),
            check=False,
        )
        return result.returncode
    finally:
        os.kill(child, signal.SIGTERM)
        os.waitpid(child, 0)


if __name__ == "__main__":
    sys.exit(main())
