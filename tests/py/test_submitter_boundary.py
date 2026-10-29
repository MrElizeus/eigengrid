"""Actual Linux sockets, file locks, fsync/restart, processes and OpenSSL signatures.

The fake backend is ONLY the external effect counter. These are boundary tests,
not Amber/Slurm or production deployment qualification.
"""

import base64
import hashlib
import os
import socket
import struct
import subprocess
import tempfile
import threading
from contextlib import ExitStack, contextmanager
from dataclasses import replace

import pytest
from eigengrid_submitter import authority
from eigengrid_submitter.authority import (
    DOMAIN,
    FIELDS,
    MAX_WIRE_BYTES,
    AuthorityError,
    SubmitterPolicy,
    authenticate_request,
    compact_json,
    strict_json,
)
from eigengrid_submitter.boundary import SubmitterBoundary, receive_frame
from eigengrid_submitter.journal import JournalError, TransportJournal, bootstrap_record

NOW = 1_789_885_000_000
BODY = b'{"kind":"test-only-counted-effect"}'


@pytest.fixture(scope="module")
def keypair():
    private = subprocess.check_output(
        ["/usr/bin/openssl", "genpkey", "-algorithm", "ED25519", "-outform", "DER"]
    )
    public = subprocess.check_output(
        ["/usr/bin/openssl", "pkey", "-inform", "DER", "-pubout", "-outform", "DER"],
        input=private,
    )
    assert public[:12].hex() == "302a300506032b6570032100"
    return private, public[12:].hex()


@pytest.fixture
def policy(keypair):
    return SubmitterPolicy(
        uid=2101,
        gid=2101,
        head_uid=max(os.getuid(), 1),
        recovery_epoch="site-epoch-1",
        site_profile_digest="a" * 64,
        public_key_hex=keypair[1],
        memberships={("human-1", "project-1"): 3},
    )


def payload(**changes):
    value = {
        "version": "eigengrid.submitter-capability/v1",
        "action": "submit",
        "requestId": "rpc-1",
        "subject": "human-1",
        "projectId": "project-1",
        "uid": 2101,
        "gid": 2101,
        "recoveryEpoch": "site-epoch-1",
        "membershipGeneration": 3,
        "siteProfileDigest": "a" * 64,
        "operationId": "operation-1",
        "requestDigest": "b" * 64,
        "admissionDigest": "c" * 64,
        "bindingDigest": "d" * 64,
        "bodyDigest": hashlib.sha256(BODY).hexdigest(),
        "fencingGeneration": 17,
        "notBeforeMs": NOW - 1_000,
        "expiresAtMs": NOW + 30_000,
    }
    value.update(changes)
    return {key: value[key] for key in FIELDS} | {
        key: value[key] for key in value.keys() - set(FIELDS)
    }


def signed(keypair, value=None, *, raw_payload=None, body=BODY, domain=DOMAIN):
    encoded = (
        raw_payload if raw_payload is not None else compact_json(value or payload())
    )
    with ExitStack() as stack:
        descriptors = []
        for data in (keypair[0], domain + encoded):
            stream = stack.enter_context(tempfile.TemporaryFile(dir="/tmp"))
            stream.write(data)
            stream.flush()
            stream.seek(0)
            descriptors.append(stream.fileno())
        signature = subprocess.check_output(
            [
                "/usr/bin/openssl",
                "pkeyutl",
                "-sign",
                "-rawin",
                "-keyform",
                "DER",
                "-inkey",
                f"/proc/self/fd/{descriptors[0]}",
                "-in",
                f"/proc/self/fd/{descriptors[1]}",
            ],
            pass_fds=tuple(descriptors),
        )
    return compact_json(
        {
            "payload": base64.b64encode(encoded).decode(),
            "signature": base64.b64encode(signature).decode(),
            "body": base64.b64encode(body).decode(),
        }
    )


@contextmanager
def journal_at(path, *, create=False):
    if create:
        with path.open("xb") as stream:
            stream.write(bootstrap_record("gateway-1", 2101))
            stream.flush()
            os.fsync(stream.fileno())
        path.chmod(0o600)
    fd = os.open(path, os.O_RDWR | os.O_APPEND | os.O_CLOEXEC)
    try:
        journal = TransportJournal(fd, "gateway-1", 2101, owner_uid=os.getuid())
    finally:
        os.close(fd)
    try:
        yield journal
    finally:
        journal.close()


class CountedBackend:
    def __init__(self):
        self.submits = 0
        self.observations = 0
        self.fail = False
        self.releases = 0

    def prepare(self, request):
        if request.body != BODY:
            raise ValueError("Unsupported typed test fixture")
        return request.body

    def submit(self, _):
        self.submits += 1
        if self.fail:
            raise TimeoutError("Lost effect acknowledgement")
        return {
            "status": "acknowledged",
            "resubmitAllowed": False,
            "jobId": "45",
            "cluster": "chem",
        }

    def observe(self, _):
        self.observations += 1
        return {"status": "matched", "jobId": "45", "resubmitAllowed": False}

    def accounting(self, _):
        self.observations += 1
        return {"observation": {"status": "indeterminate"}, "accounting": None}

    def release(self, _):
        self.releases += 1


def test_valid_real_ed25519_signature_and_literal_body(keypair, policy):
    result = authenticate_request(signed(keypair), policy, NOW)
    assert result.body == BODY
    assert result.identity["operationId"] == "operation-1"
    assert "action" not in result.identity and "recoveryEpoch" not in result.identity


def accounting_wire(keypair, **changes):
    return signed(
        keypair,
        payload(
            version="eigengrid.submitter-capability/v2", action="accounting", **changes
        ),
        domain=authority.ACCOUNTING_DOMAIN,
    )


def test_v2_accounting_is_read_only_for_an_exact_v1_claim(keypair, policy, tmp_path):
    path = tmp_path / "journal"
    backend = CountedBackend()
    wire = accounting_wire(keypair)
    with journal_at(path, create=True) as journal:
        boundary = SubmitterBoundary(journal, lambda: policy, backend, lambda: NOW)
        original = path.read_bytes()
        with pytest.raises(AuthorityError, match="previously consumed claim"):
            boundary.handle(wire, policy.head_uid)
        assert path.read_bytes() == original and backend.submits == 0
        boundary.handle(signed(keypair), policy.head_uid)
        original = path.read_bytes()
        for request in (wire, accounting_wire(keypair, requestId="new-read")):
            result = boundary.handle(request, policy.head_uid)
            assert result == {
                "version": "eigengrid.submitter-response/v2",
                "status": "accounting",
                "operationId": "operation-1",
                "resubmitAllowed": False,
                "observation": {"status": "indeterminate"},
                "accounting": None,
            }
        assert path.read_bytes() == original and backend.submits == 1
        assert backend.observations == 2
        for changes in ({"bindingDigest": "f" * 64}, {"fencingGeneration": 18}):
            with pytest.raises(AuthorityError, match="previously consumed claim"):
                boundary.handle(accounting_wire(keypair, **changes), policy.head_uid)
        assert path.read_bytes() == original and backend.submits == 1


def test_v2_cannot_be_signed_as_v1_or_expand_to_effect_actions(keypair, policy):
    for version, action, domain in (
        ("eigengrid.submitter-capability/v2", "accounting", DOMAIN),
        ("eigengrid.submitter-capability/v1", "accounting", DOMAIN),
        ("eigengrid.submitter-capability/v2", "submit", authority.ACCOUNTING_DOMAIN),
        ("eigengrid.submitter-capability/v2", "observe", authority.ACCOUNTING_DOMAIN),
        ("eigengrid.submitter-capability/v2", "cancel", authority.ACCOUNTING_DOMAIN),
    ):
        with pytest.raises(AuthorityError):
            authenticate_request(
                signed(keypair, payload(version=version, action=action), domain=domain),
                policy,
                NOW,
            )


@pytest.mark.parametrize("change", ["expiry", "revocation", "oversized", "extra"])
def test_v2_accounting_revalidates_after_read_and_bounds_response(
    keypair, policy, tmp_path, change
):
    path = tmp_path / "journal"
    current, clock = [policy], [NOW]
    backend = CountedBackend()

    def read(_):
        if change == "expiry":
            clock[0] += 60_000
        if change == "revocation":
            current[0] = replace(policy, memberships={})
        result = {"observation": {"status": "indeterminate"}, "accounting": None}
        if change == "oversized":
            result["observation"]["reason"] = "X" * (64 * 1024)
        if change == "extra":
            result["command"] = "untrusted"
        return result

    backend.accounting = read
    with journal_at(path, create=True) as journal:
        boundary = SubmitterBoundary(
            journal, lambda: current[0], backend, lambda: clock[0]
        )
        boundary.handle(signed(keypair), policy.head_uid)
        original = path.read_bytes()
        with pytest.raises(AuthorityError):
            boundary.handle(accounting_wire(keypair), policy.head_uid)
        assert path.read_bytes() == original and backend.submits == 1


@pytest.mark.parametrize(
    "changes",
    [
        {"uid": 0},
        {"uid": 2103},
        {"uid": True},
        {"uid": 2101.0},
        {"gid": 2103},
        {"subject": "human-2"},
        {"projectId": "project-2"},
        {"projectId": "../x"},
        {"membershipGeneration": 2},
        {"membershipGeneration": 4},
        {"recoveryEpoch": "site-epoch-0"},
        {"siteProfileDigest": "e" * 64},
        {"bodyDigest": "e" * 64},
        {"fencingGeneration": 0},
        {"notBeforeMs": NOW + 1},
        {"expiresAtMs": NOW},
        {"expiresAtMs": NOW + 60_000},
        {"expiresAtMs": 2**53},
        {"action": "shell"},
        {"action": "cancel"},
        {"uidName": "eliseo"},
        {"operationId": "$(id)"},
        {"operationId": "a\n"},
        {"requestId": "á"},
        {"requestDigest": "A" * 64},
    ],
)
def test_signed_but_invalid_authority_is_rejected(keypair, policy, changes):
    with pytest.raises(AuthorityError):
        authenticate_request(signed(keypair, payload(**changes)), policy, NOW)


def test_cross_domain_forgery_tampering_noncanonical_and_duplicate_fields(
    keypair, policy
):
    raw = signed(keypair)
    envelope = strict_json(raw)
    bad_signature = {**envelope, "signature": base64.b64encode(bytes(64)).decode()}
    bad_body = {**envelope, "body": base64.b64encode(BODY + b" ").decode()}
    for request in (
        compact_json(bad_signature),
        compact_json(bad_body),
        signed(keypair, domain=b"other\n"),
        signed(keypair, raw_payload=compact_json(payload()) + b" "),
        signed(keypair, raw_payload=compact_json(payload())[:-1] + b',"uid":2101}'),
        compact_json({**envelope, "command": "id"}),
        raw[:-1] + b',"body":"AA=="}',
        b"[1]",
        b"{" * 5000,
        b"x" * (MAX_WIRE_BYTES + 1),
    ):
        with pytest.raises(AuthorityError):
            authenticate_request(request, policy, NOW)


def test_consumed_claim_survives_restart_lost_ack_and_new_rpc(
    keypair, policy, tmp_path
):
    path = tmp_path / "journal"
    backend = CountedBackend()
    backend.fail = True
    with journal_at(path, create=True) as journal:
        boundary = SubmitterBoundary(journal, lambda: policy, backend, lambda: NOW)
        first = boundary.handle(signed(keypair), policy.head_uid)
        assert first["receipt"]["status"] == "indeterminate"
        assert backend.submits == 1
    with journal_at(path) as journal:
        boundary = SubmitterBoundary(journal, lambda: policy, backend, lambda: NOW)
        replay = boundary.handle(
            signed(keypair, payload(requestId="rpc-2")), policy.head_uid
        )
        assert replay["status"] == "already_consumed" and backend.submits == 1
        observed = boundary.handle(
            signed(keypair, payload(action="observe")), policy.head_uid
        )
        assert (
            observed["observation"]["status"] == "matched" and backend.observations == 1
        )
        for change in ({"fencingGeneration": 18}, {"bindingDigest": "f" * 64}):
            with pytest.raises(JournalError, match="rebound"):
                boundary.handle(signed(keypair, payload(**change)), policy.head_uid)
        assert backend.submits == 1


def test_crash_after_fsync_before_effect_never_resubmits(keypair, policy, tmp_path):
    path = tmp_path / "journal"
    with journal_at(path, create=True):
        pass
    child = os.fork()
    if child == 0:
        try:
            with journal_at(path) as journal:
                journal.claim(
                    authenticate_request(signed(keypair), policy, NOW).identity
                )
                os._exit(23)  # Real process death, no Python cleanup or receipt.
        finally:
            os._exit(99)
    _, status = os.waitpid(child, 0)
    assert os.waitstatus_to_exitcode(status) == 23
    backend = CountedBackend()
    with journal_at(path) as journal:
        boundary = SubmitterBoundary(journal, lambda: policy, backend, lambda: NOW)
        response = boundary.handle(signed(keypair), policy.head_uid)
        assert response["status"] == "already_consumed" and response["receipt"] is None
        assert backend.submits == 0


def test_recovery_epoch_and_revocation_rechecked_without_resetting_claim(
    keypair, policy, tmp_path
):
    backend = CountedBackend()
    current = [policy]
    with journal_at(tmp_path / "journal", create=True) as journal:
        boundary = SubmitterBoundary(journal, lambda: current[0], backend, lambda: NOW)
        boundary.handle(signed(keypair), policy.head_uid)
        current[0] = replace(policy, recovery_epoch="site-epoch-2")
        with pytest.raises(AuthorityError):
            boundary.handle(signed(keypair), policy.head_uid)
        replay = boundary.handle(
            signed(keypair, payload(recoveryEpoch="site-epoch-2")), policy.head_uid
        )
        assert replay["status"] == "already_consumed" and backend.submits == 1
        current[0] = replace(policy, memberships={})
        with pytest.raises(AuthorityError):
            boundary.handle(
                signed(keypair, payload(recoveryEpoch="site-epoch-2")), policy.head_uid
            )


def test_expiration_or_revocation_during_prepare_prevents_claim(
    keypair, policy, tmp_path
):
    backend = CountedBackend()
    current = [policy]
    with journal_at(tmp_path / "journal", create=True) as journal:
        boundary = SubmitterBoundary(journal, lambda: current[0], backend, lambda: NOW)
        backend.prepare = lambda _: current.__setitem__(
            0, replace(policy, memberships={})
        )
        with pytest.raises(AuthorityError):
            boundary.handle(signed(keypair), policy.head_uid)
        assert not journal.claims and backend.submits == 0
        current[0] = policy
        clock = [NOW]
        boundary.now_ms = lambda: clock[0]
        backend.prepare = lambda _: clock.__setitem__(0, NOW + 30_000)
        with pytest.raises(AuthorityError):
            boundary.handle(signed(keypair), policy.head_uid)
        assert not journal.claims and backend.submits == 0


def test_disk_failure_before_claim_is_durable_prevents_effect(
    keypair, policy, tmp_path, monkeypatch
):
    backend = CountedBackend()
    with journal_at(tmp_path / "journal", create=True) as journal:
        boundary = SubmitterBoundary(journal, lambda: policy, backend, lambda: NOW)
        fsync = os.fsync

        def fail(fd):
            if fd == journal.fd:
                raise OSError("Injected disk full / fsync failure")
            return fsync(fd)

        monkeypatch.setattr(os, "fsync", fail)
        with pytest.raises(OSError):
            boundary.handle(signed(keypair), policy.head_uid)
        assert backend.submits == 0 and journal.poisoned
        with pytest.raises(JournalError, match="poisoned"):
            boundary.handle(signed(keypair), policy.head_uid)


def test_journal_rejects_empty_partial_corrupt_hardlinked_and_unsafe_mode(tmp_path):
    original = bootstrap_record("gateway-1", 2101)
    for number, data in enumerate(
        (
            b"",
            original[:-1],
            original.replace(b"gateway-1", b"gateway-2"),
            original + b'{"partial":',
        )
    ):
        path = tmp_path / str(number)
        path.write_bytes(data)
        path.chmod(0o600)
        with pytest.raises(JournalError), journal_at(path):
            pass
        assert path.read_bytes() == data  # No automatic truncation or healing.
    path = tmp_path / "permissions"
    path.write_bytes(original)
    path.chmod(0o640)
    with pytest.raises(JournalError), journal_at(path):
        pass
    path.chmod(0o600)
    os.link(path, tmp_path / "hardlink")
    with pytest.raises(JournalError), journal_at(path):
        pass


def test_exclusive_journal_lock_blocks_second_process(tmp_path):
    path = tmp_path / "journal"
    with journal_at(path, create=True):
        child = os.fork()
        if child == 0:
            try:
                with journal_at(path):
                    os._exit(1)
            except BlockingIOError:
                os._exit(0)
            finally:
                os._exit(2)
        _, status = os.waitpid(child, 0)
        assert os.waitstatus_to_exitcode(status) == 0


def test_linux_peer_credentials_and_length_framing(keypair, policy, tmp_path):
    if os.getuid() == 0:
        pytest.skip(
            "Root is deliberately not a valid Head identity; non-root Linux test required"
        )
    backend = CountedBackend()
    errors = []
    with journal_at(tmp_path / "journal", create=True) as journal:
        boundary = SubmitterBoundary(journal, lambda: policy, backend, lambda: NOW)
        server, client = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)

        def serve():
            try:
                with server:
                    boundary.serve_one(server)
            except (OSError, AuthorityError, JournalError) as exc:
                errors.append(exc)

        thread = threading.Thread(target=serve)
        thread.start()
        with client:
            wire = signed(keypair)
            client.sendall(struct.pack("!I", len(wire)) + wire)
            response = strict_json(receive_frame(client))
        thread.join(timeout=5)
        assert not thread.is_alive() and not errors
        assert response["status"] == "consumed" and backend.submits == 1
        # Same signed request from a different provisioned Head UID is not read/accepted.
        boundary.policy = lambda: replace(policy, head_uid=policy.head_uid + 1)
        server, client = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        with server, client, pytest.raises(AuthorityError, match="Head UID"):
            boundary.serve_one(server)


@pytest.mark.parametrize(
    "frame",
    [
        struct.pack("!I", 0),
        struct.pack("!I", MAX_WIRE_BYTES + 1),
        b"\x00\x01",
        struct.pack("!I", 10) + b"abc",
    ],
)
def test_bad_or_truncated_frames_fail_closed(frame):
    server, client = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    with server, client:
        client.sendall(frame)
        client.shutdown(socket.SHUT_WR)
        with pytest.raises(AuthorityError):
            receive_frame(server)


def test_crash_after_real_effect_before_receipt_keeps_the_claim(
    keypair, policy, tmp_path
):
    path, counter = tmp_path / "journal", tmp_path / "effect-count"
    with journal_at(path, create=True):
        pass
    wire = signed(keypair)
    child = os.fork()
    if child == 0:
        try:
            with journal_at(path) as journal:
                backend = CountedBackend()

                def effect(_):
                    with counter.open("xb") as stream:
                        stream.write(b"one external effect\n")
                        stream.flush()
                        os.fsync(stream.fileno())
                    os._exit(24)

                backend.submit = effect
                SubmitterBoundary(journal, lambda: policy, backend, lambda: NOW).handle(
                    wire, policy.head_uid
                )
        finally:
            os._exit(99)
    _, status = os.waitpid(child, 0)
    assert os.waitstatus_to_exitcode(status) == 24
    with journal_at(path) as journal:
        backend = CountedBackend()
        response = SubmitterBoundary(
            journal, lambda: policy, backend, lambda: NOW
        ).handle(wire, policy.head_uid)
        assert response["status"] == "already_consumed" and response["receipt"] is None
        assert counter.read_bytes() == b"one external effect\n" and backend.submits == 0


def test_parallel_deliveries_cannot_cross_the_effect_boundary_twice(
    keypair, policy, tmp_path
):
    backend = CountedBackend()
    wire = signed(keypair)
    responses = []
    with journal_at(tmp_path / "journal", create=True) as journal:
        boundary = SubmitterBoundary(journal, lambda: policy, backend, lambda: NOW)
        threads = [
            threading.Thread(
                target=lambda: responses.append(boundary.handle(wire, policy.head_uid))
            )
            for _ in range(8)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)
            assert not thread.is_alive()
        assert len(responses) == 8 and backend.submits == 1
        assert [item["status"] for item in responses].count("consumed") == 1
        assert [item["status"] for item in responses].count("already_consumed") == 7


def test_failed_receipt_fsync_does_not_allow_a_second_effect(
    keypair, policy, tmp_path, monkeypatch
):
    backend = CountedBackend()
    path = tmp_path / "journal"
    wire = signed(keypair)
    with journal_at(path, create=True) as journal:
        boundary = SubmitterBoundary(journal, lambda: policy, backend, lambda: NOW)
        fsync = os.fsync
        writes = []

        def fail(fd):
            if fd == journal.fd:
                writes.append(fd)
                if len(writes) == 2:
                    raise OSError("Injected receipt fsync failure")
            return fsync(fd)

        monkeypatch.setattr(os, "fsync", fail)
        with pytest.raises(OSError):
            boundary.handle(wire, policy.head_uid)
        assert backend.submits == 1 and journal.poisoned
        monkeypatch.setattr(os, "fsync", fsync)
    with journal_at(path) as journal:
        result = SubmitterBoundary(
            journal, lambda: policy, backend, lambda: NOW
        ).handle(wire, policy.head_uid)
        assert result["status"] == "already_consumed" and backend.submits == 1


def test_slow_claim_fsync_cannot_extend_authority_window(
    keypair, policy, tmp_path, monkeypatch
):
    backend, clock = CountedBackend(), [NOW]
    with journal_at(tmp_path / "journal", create=True) as journal:
        fsync = os.fsync

        def delayed(fd):
            fsync(fd)
            if fd == journal.fd:
                clock[0] = NOW + 30_000

        monkeypatch.setattr(os, "fsync", delayed)
        result = SubmitterBoundary(
            journal, lambda: policy, backend, lambda: clock[0]
        ).handle(signed(keypair), policy.head_uid)
        assert result["receipt"]["status"] == "indeterminate"
        assert backend.submits == 0 and "operation-1" in journal.claims


def test_fsync_partial_write_poisoned_journal_is_never_healed(
    keypair, policy, tmp_path, monkeypatch
):
    path = tmp_path / "journal"
    wire = signed(keypair)
    with journal_at(path, create=True) as journal:
        backend, write = CountedBackend(), os.write

        def partial(fd, data):
            if fd == journal.fd:
                write(fd, data[:20])
                raise OSError("Injected partial write")
            return write(fd, data)

        monkeypatch.setattr(os, "write", partial)
        with pytest.raises(OSError):
            SubmitterBoundary(journal, lambda: policy, backend, lambda: NOW).handle(
                wire, policy.head_uid
            )
        assert journal.poisoned and backend.submits == 0
        monkeypatch.setattr(os, "write", write)
    preserved = path.read_bytes()
    with pytest.raises(JournalError, match="partial"), journal_at(path):
        pass
    assert path.read_bytes() == preserved


def test_no_observation_without_exact_consumed_project_and_operation(
    keypair, policy, tmp_path
):
    backend = CountedBackend()
    with journal_at(tmp_path / "journal", create=True) as journal:
        boundary = SubmitterBoundary(journal, lambda: policy, backend, lambda: NOW)
        with pytest.raises(AuthorityError, match="previously consumed"):
            boundary.handle(signed(keypair, payload(action="observe")), policy.head_uid)
        assert backend.submits == backend.observations == 0


def test_provisioned_memberships_cannot_be_mutated_through_the_original_mapping(
    keypair,
):
    memberships = {("human-1", "project-1"): 3}
    policy = SubmitterPolicy(
        2101, 2101, 997, "epoch-1", "a" * 64, keypair[1], memberships
    )
    memberships.clear()
    assert policy.memberships[("human-1", "project-1")] == 3
    with pytest.raises(TypeError):
        policy.memberships[("human-1", "project-1")] = 4


def test_signature_verification_time_cannot_extend_capability(
    keypair, policy, tmp_path, monkeypatch
):
    backend, clock = CountedBackend(), [NOW]
    verifier = authority.verify_ed25519
    wire = signed(keypair)

    def delayed(*args):
        verifier(*args)
        clock[0] = NOW + 30_000

    monkeypatch.setattr(authority, "verify_ed25519", delayed)
    with journal_at(tmp_path / "journal", create=True) as journal:
        boundary = SubmitterBoundary(journal, lambda: policy, backend, lambda: clock[0])
        with pytest.raises(AuthorityError, match="dispatch window"):
            boundary.handle(wire, policy.head_uid)
        assert backend.submits == 0 and not journal.claims
