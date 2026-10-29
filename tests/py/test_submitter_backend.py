"""Real Python -> Bun pipes/processes, journal/fsync and Ed25519 verification.

ONLY root launch provisioning/binary lookup and external Slurm are substituted.
Positive production AppArmor/UID provisioning must be qualified on the site.
"""

import json
import os
import pwd
import shutil
import signal
import socket
import struct
import subprocess
import time
from pathlib import Path

import pytest
import test_submitter_boundary as boundary_fixtures
from eigengrid_submitter import backend as backend_module
from eigengrid_submitter.authority import AuthorityError, authenticate_request
from eigengrid_submitter.backend import ProtectedSlurmBackend, _BackendProcess
from eigengrid_submitter.boundary import SubmitterBoundary
from test_submitter_boundary import (
    NOW,
    accounting_wire,
    journal_at,
    payload,
    signed,
)

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def keypair():
    return boundary_fixtures.keypair.__wrapped__()


@pytest.fixture
def policy(keypair):
    return boundary_fixtures.policy.__wrapped__(keypair)


@pytest.fixture
def real_child(tmp_path, monkeypatch):
    bun = shutil.which("bun")
    assert bun, "Bun is required for the cross-language submitter integration test"
    marker = tmp_path / "test-launch-marker"
    marker.write_bytes(b"TEST ONLY - not root launch authority")
    marker_fd = os.open(marker, os.O_RDONLY | os.O_CLOEXEC)
    spec = {
        "mode": "normal",
        "counter": str(tmp_path / "external-effect"),
        "descriptors": str(tmp_path / "child-descriptors"),
        "environment": str(tmp_path / "child-environment"),
        "descendant": str(tmp_path / "descendant-pid"),
    }
    config_file = tmp_path / "test-child.json"
    config = {
        "uid": 2101,
        "gid": 2101,
        "backendExecutable": "/root-provisioned-test-substitution",
        "configPath": str(config_file),
    }
    processes = []
    original_popen = subprocess.Popen

    def launch(args, **kwargs):
        # Keep ALL production pipe/env/group/FD isolation options unchanged.
        if args[0] == config["backendExecutable"]:
            args = [
                bun,
                str(ROOT / "tests/fixtures/submitter-backend-process.ts"),
                *args[1:],
            ]
            process = original_popen(args, **kwargs)
            processes.append(process)
            return process
        return original_popen(args, **kwargs)

    monkeypatch.setattr(backend_module.subprocess, "Popen", launch)
    monkeypatch.setattr(backend_module, "verify_backend_binary", lambda _: None)
    monkeypatch.setattr(
        backend_module, "verify_launch_descriptor", lambda _fd, _config: None
    )

    def set_mode(mode):
        spec["mode"] = mode
        config_file.write_text(json.dumps(spec))

    set_mode("normal")
    backend = ProtectedSlurmBackend(config, marker_fd)
    os.close(marker_fd)
    try:
        yield backend, spec, set_mode, processes
    finally:
        backend.close()
        assert all(process.returncode is not None for process in processes)


def test_preparation_has_no_effect_and_release_reaps_child(real_child, keypair, policy):
    backend, spec, _, children = real_child
    request = authenticate_request(signed(keypair), policy, NOW)
    token = backend.prepare(request)
    assert not Path(spec["counter"]).exists()
    backend.release(token)
    assert children[0].returncode is not None and not backend._pending
    with pytest.raises(AuthorityError, match="not live"):
        backend.submit(token)
    assert not Path(spec["counter"]).exists()


def test_v2_accounting_crosses_real_pipes_without_journal_or_engine_writes(
    real_child, keypair, policy, tmp_path
):
    backend, spec, _, children = real_child
    path = tmp_path / "journal"
    with journal_at(path, create=True) as journal:
        boundary = SubmitterBoundary(journal, lambda: policy, backend, lambda: NOW)
        with pytest.raises(AuthorityError, match="previously consumed claim"):
            boundary.handle(accounting_wire(keypair), policy.head_uid)
        journal.claim(authenticate_request(signed(keypair), policy, NOW).identity)
        before = path.read_bytes()
        response = boundary.handle(accounting_wire(keypair), policy.head_uid)
        assert response["version"] == "eigengrid.submitter-response/v2"
        assert response["status"] == "accounting" and response["accounting"] is None
        assert response["observation"]["status"] == "indeterminate"
        assert response["resubmitAllowed"] is False
        assert path.read_bytes() == before
        assert not Path(spec["counter"]).exists() and not backend._pending
        assert all(child.returncode == 0 for child in children[1:])


def test_protected_startup_check_has_no_request_or_effect(real_child):
    backend, spec, _, children = real_child
    backend.check("a" * 64)
    assert not backend._pending and children[0].returncode == 0
    assert not Path(spec["counter"]).exists()
    with pytest.raises(AuthorityError, match="preflight"):
        backend.check("b" * 64)
    assert not Path(spec["counter"]).exists()


def test_real_process_effect_only_after_fsync_and_only_once(
    real_child, keypair, policy, tmp_path, monkeypatch
):
    backend, spec, _, children = real_child
    counter = Path(spec["counter"])
    with journal_at(tmp_path / "journal", create=True) as journal:
        original_fsync = os.fsync
        syncs = []

        def synced(fd):
            if fd == journal.fd:
                syncs.append(counter.exists())
            return original_fsync(fd)

        monkeypatch.setattr(os, "fsync", synced)
        wire = signed(keypair)
        boundary = SubmitterBoundary(journal, lambda: policy, backend, lambda: NOW)
        first = boundary.handle(wire, policy.head_uid)
        assert first["receipt"]["jobId"] == "45"
        assert syncs == [False, True]  # durable claim precedes external effect
        assert boundary.handle(wire, policy.head_uid)["status"] == "already_consumed"
        assert counter.read_text() == "one\n"
        assert len(children) == 2 and not backend._pending


def test_private_descriptors_and_environment_are_not_inherited(
    real_child, keypair, policy, tmp_path, monkeypatch
):
    backend, spec, _, _ = real_child
    private = tmp_path / "private-journal-like-file"
    private.write_bytes(b"private")
    fd = os.open(private, os.O_RDWR)
    os.set_inheritable(fd, True)  # deliberately hostile ambient descriptor
    server, client = socket.socketpair()
    os.set_inheritable(server.fileno(), True)
    parent_socket = os.readlink(f"/proc/self/fd/{server.fileno()}")
    monkeypatch.setenv("BUN_OPTIONS", "--untrusted-test-option")
    monkeypatch.setenv("BUN_BE_BUN", "1")
    monkeypatch.setenv("LD_PRELOAD", "/untrusted-test-library.so")
    monkeypatch.setenv("HOME", "/untrusted-test-home")
    monkeypatch.setenv("USER", "untrusted-user")
    monkeypatch.setenv("LOGNAME", "untrusted-user")
    try:
        token = backend.prepare(authenticate_request(signed(keypair), policy, NOW))
        inherited = json.loads(Path(spec["descriptors"]).read_text())
        assert str(private) not in inherited and parent_socket not in inherited
        environment = json.loads(Path(spec["environment"]).read_text())
        identity = pwd.getpwuid(os.getuid())
        assert environment["env"] == {
            "PATH": "/usr/bin:/bin",
            "LC_ALL": "C",
            "TZ": "UTC",
            "BUN_JSC_useJIT": "0",
            "HOME": identity.pw_dir,
            "USER": identity.pw_name,
            "LOGNAME": identity.pw_name,
        }
        assert environment["identity"]["uid"] == os.getuid()
        assert environment["identity"]["username"] == identity.pw_name
        assert environment["identity"]["homedir"] == identity.pw_dir
        backend.release(token)
    finally:
        os.close(fd)
        server.close()
        client.close()


@pytest.mark.parametrize("mode,expected_count", [("lost-ack", 1), ("before-effect", 0)])
def test_backend_crash_fences_operation_across_journal_restart(
    real_child, keypair, policy, tmp_path, mode, expected_count
):
    backend, spec, set_mode, _ = real_child
    set_mode(mode)
    path = tmp_path / "journal"
    wire = signed(keypair)
    with journal_at(path, create=True) as journal:
        response = SubmitterBoundary(
            journal, lambda: policy, backend, lambda: NOW
        ).handle(wire, policy.head_uid)
        assert response["receipt"] == {
            "status": "indeterminate",
            "resubmitAllowed": False,
        }
    set_mode("normal")
    with journal_at(path) as journal:
        boundary = SubmitterBoundary(journal, lambda: policy, backend, lambda: NOW)
        assert boundary.handle(wire, policy.head_uid)["status"] == "already_consumed"
        observation = boundary.handle(
            signed(keypair, payload(action="observe")), policy.head_uid
        )
        assert observation["observation"]["status"] == "indeterminate"
    counter = Path(spec["counter"])
    assert (
        counter.read_text().count("one\n") if counter.exists() else 0
    ) == expected_count


def test_failed_prepare_does_not_consume_claim(real_child, keypair, policy, tmp_path):
    backend, spec, set_mode, children = real_child
    set_mode("prepare-crash")
    with journal_at(tmp_path / "journal", create=True) as journal:
        with pytest.raises(AuthorityError):
            SubmitterBoundary(journal, lambda: policy, backend, lambda: NOW).handle(
                signed(keypair), policy.head_uid
            )
        assert not journal.claims and not backend._pending
    assert children[0].returncode == 24 and not Path(spec["counter"]).exists()


def test_failed_claim_fsync_releases_prepared_child_without_effect(
    real_child, keypair, policy, tmp_path, monkeypatch
):
    backend, spec, _, children = real_child
    with journal_at(tmp_path / "journal", create=True) as journal:
        original = os.fsync

        def fail(fd):
            if fd == journal.fd:
                raise OSError("TEST failed claim sync")
            return original(fd)

        monkeypatch.setattr(os, "fsync", fail)
        with pytest.raises(OSError, match="claim sync"):
            SubmitterBoundary(journal, lambda: policy, backend, lambda: NOW).handle(
                signed(keypair), policy.head_uid
            )
        assert journal.poisoned and not backend._pending
    assert children[0].returncode is not None and not Path(spec["counter"]).exists()


def test_wrong_action_is_consumed_without_an_effect(real_child, keypair, policy):
    backend, spec, _, _ = real_child
    token = backend.prepare(
        authenticate_request(signed(keypair, payload(action="observe")), policy, NOW)
    )
    with pytest.raises(AuthorityError, match="action differs"):
        backend.submit(token)
    assert not backend._pending and not Path(spec["counter"]).exists()


def test_completion_cleans_up_descendants_after_leader_exit(
    real_child, keypair, policy, tmp_path
):
    backend, spec, set_mode, _ = real_child
    set_mode("descendant")
    with journal_at(tmp_path / "journal", create=True) as journal:
        response = SubmitterBoundary(
            journal, lambda: policy, backend, lambda: NOW
        ).handle(signed(keypair), policy.head_uid)
        assert response["receipt"]["status"] == "acknowledged"
    pid = int(Path(spec["descendant"]).read_text())
    for _ in range(100):
        status = Path(f"/proc/{pid}/stat")
        if not status.exists() or status.read_text().split()[2] == "Z":
            break
        time.sleep(0.01)
    else:
        os.kill(pid, signal.SIGKILL)
        pytest.fail("Backend descendant survived group cleanup")


@pytest.mark.parametrize(
    "raw", [struct.pack("!I", 65537), b"\x00\x00", struct.pack("!I", 5) + b"{}"]
)
def test_pipe_rejects_oversized_and_incomplete_responses(raw):
    child = _BackendProcess(
        subprocess.Popen(
            [
                "/usr/bin/python3",
                "-I",
                "-c",
                "import os,sys; os.write(1,bytes.fromhex(sys.argv[1]))",
                raw.hex(),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            start_new_session=True,
        )
    )
    try:
        with pytest.raises(AuthorityError):
            child.receive(time.monotonic() + 2)
    finally:
        child.close()


def test_hung_pipe_deadline_and_kill_are_bounded():
    child = _BackendProcess(
        subprocess.Popen(
            [
                "/usr/bin/python3",
                "-I",
                "-c",
                "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(30)",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            start_new_session=True,
        )
    )
    start = time.monotonic()
    try:
        with pytest.raises(TimeoutError):
            child.receive(start + 0.2)
    finally:
        child.close()
    assert time.monotonic() - start < 2 and child.process.returncode is not None
