"""Unprivileged negative provisioning tests. No bypass in the service entrypoint."""

import os
import socket

import pytest
from eigengrid_submitter import service, site
from eigengrid_submitter.authority import AuthorityError


def config_value():
    return {
        "schemaVersion": "eigengrid.submitter-service/v1",
        "configPath": "/etc/eigengrid/submitter/2101.json",
        "uid": 2101,
        "gid": 2101,
        "headUid": 2900,
        "appArmorProfile": "eigengrid-submitter-2101",
        "socketPath": "/run/eigengrid-submitter/2101.sock",
        "journalPath": "/var/lib/eigengrid-submitters/2101/journal",
        "journalId": "gateway-2101",
        "launchAuthorityPath": "/var/lib/eigengrid-submitters/2101/launch",
        "launchAuthorityDevice": "100",
        "launchAuthorityInode": "12345",
        "launchAuthoritySha256": "a" * 64,
        "backendExecutable": "/opt/apps/eigengrid-submitters/commit/backend",
        "backendSha256": "b" * 64,
        "siteProfilePath": "/etc/eigengrid/submitter/profile-2101.json",
        "policyPath": "/etc/eigengrid/submitter/policy-2101.json",
    }


def test_root_path_rejects_user_owned_configuration_and_symlinks(tmp_path):
    candidate = tmp_path / "config.json"
    candidate.write_text("{}")
    candidate.chmod(0o444)
    with pytest.raises(AuthorityError, match="writable or redirected"):
        site.protected_json(str(candidate))
    alias = tmp_path / "alias"
    alias.symlink_to(candidate)
    with pytest.raises(AuthorityError):
        site.protected_path(str(alias))
    for value in (
        "/",
        "relative",
        "/etc/../tmp/x",
        "/etc/evil\n",
        "/etc/" + "x" * 1024,
    ):
        with pytest.raises(AuthorityError, match="Invalid protected"):
            site.protected_path(value)


@pytest.mark.parametrize(
    "changes",
    [
        {"uid": 0},
        {"uid": True},
        {"uid": 2900},
        {"gid": 2**32},
        {"headUid": -1},
        {"shell": "id"},
        {"backendExecutable": "/opt/x/../bad"},
        {"launchAuthorityDevice": "001"},
        {"launchAuthorityInode": "-1"},
        {"backendSha256": "A" * 64},
        {"appArmorProfile": "unconfined"},
        {"appArmorProfile": "eigengrid-submitter-foo/bar"},
        {"journalId": "../../x"},
        {"configPath": "/another-root-file"},
        {"launchAuthorityPath": "/var/lib/eigengrid-submitters/2101/journal"},
    ],
)
def test_service_configuration_is_closed_and_identity_bound(monkeypatch, changes):
    value = config_value()
    monkeypatch.setattr(site, "protected_json", lambda _: value | changes)
    with pytest.raises(AuthorityError):
        site.load_service_config(value["configPath"])


def test_policy_is_reloaded_and_rejects_membership_duplication_and_changed_config(
    monkeypatch,
):
    config = config_value()
    policy = {
        "schemaVersion": "eigengrid.submitter-site-policy/v1",
        "uid": 2101,
        "gid": 2101,
        "headUid": 2900,
        "recoveryEpoch": "epoch-1",
        "siteProfileDigest": "c" * 64,
        "currentPolicyDigest": "d" * 64,
        "publicKeyHex": "e" * 64,
        "memberships": [
            {"subject": "eliseo", "projectId": "m2-amber", "generation": 1}
        ],
    }
    files = {config["configPath"]: config, config["policyPath"]: policy}
    monkeypatch.setattr(site, "protected_json", lambda path: files[path])
    assert site.current_policy(config).memberships[("eliseo", "m2-amber")] == 1
    policy["memberships"][0]["generation"] = 2
    assert site.current_policy(config).memberships[("eliseo", "m2-amber")] == 2
    policy["memberships"].append(dict(policy["memberships"][0]))
    with pytest.raises(AuthorityError, match="Duplicate"):
        site.current_policy(config)
    policy["memberships"] = []
    assert not site.current_policy(config).memberships
    files[config["configPath"]] = config | {"backendSha256": "f" * 64}
    with pytest.raises(AuthorityError, match="changed"):
        site.current_policy(config)


def test_kernel_ptrace_scope_requires_live_restricted_value():
    for value in (b"1\n", b"2\n", b"3\n"):
        site.assert_ptrace_scope(value)
    for value in (b"0\n", b"", b"1", b"4\n", b"1\n0\n", b"01\n", b" 1\n"):
        with pytest.raises(AuthorityError, match="kernel ptrace"):
            site.assert_ptrace_scope(value)


def test_user_cannot_forge_root_launch_or_unconfined_identity(tmp_path):
    marker = tmp_path / "launch"
    marker.write_bytes(b"copied marker bytes")
    marker.chmod(0o600)
    fd = os.open(marker, os.O_RDONLY)
    try:
        with pytest.raises(AuthorityError, match="protected backend launch"):
            site.verify_launch_descriptor(fd, config_value())
    finally:
        os.close(fd)
    with pytest.raises(AuthorityError, match="UID/GID|AppArmor"):
        site.confine_service(config_value())


@pytest.mark.parametrize(
    "changes",
    [
        {"LISTEN_PID": "1"},
        {"LISTEN_FDS": "2"},
        {"LISTEN_FDS": "10000"},
        {"LISTEN_FDNAMES": "submission:journal:journal"},
        {"LISTEN_FDNAMES": "submission:journal:private-key"},
    ],
)
def test_activation_requires_exact_named_descriptors(monkeypatch, changes):
    values = {
        "LISTEN_PID": str(os.getpid()),
        "LISTEN_FDS": "3",
        "LISTEN_FDNAMES": "journal:submission:launch-authority",
    } | changes
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    with pytest.raises(AuthorityError):
        service.activation_descriptors()


def test_activation_sets_cloexec_and_clears_ambient_activation(monkeypatch):
    for key, value in {
        "LISTEN_PID": str(os.getpid()),
        "LISTEN_FDS": "3",
        "LISTEN_FDNAMES": "journal:submission:launch-authority",
    }.items():
        monkeypatch.setenv(key, value)
    calls = []
    monkeypatch.setattr(
        os, "set_inheritable", lambda fd, flag: calls.append((fd, flag))
    )
    assert service.activation_descriptors() == {
        "journal": 3,
        "submission": 4,
        "launch-authority": 5,
    }
    assert calls == [(3, False), (4, False), (5, False)]
    assert not any(key.startswith("LISTEN_") for key in os.environ)


def test_user_socket_cannot_masquerade_as_root_head_listener(tmp_path):
    path = tmp_path / "listener.sock"
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        listener.bind(str(path))
        listener.listen(1)
        path.chmod(0o660)
        with pytest.raises(AuthorityError):
            service.submission_listener(
                listener.fileno(), config_value() | {"socketPath": str(path)}
            )
    finally:
        listener.close()


def test_startup_diagnostics_never_log_exception_payload(monkeypatch, capsys):
    from eigengrid_submitter import service

    monkeypatch.setattr(
        service.sys, "argv", ["submitter", "--service-config", "/protected/config"]
    )

    def fail(_path):
        raise RuntimeError("SECRET-REQUEST-KEY-BYTES")

    monkeypatch.setattr(service, "run_service", fail)
    assert service.main() == 78
    output = capsys.readouterr().err
    assert "startup/transport fenced" in output and "RuntimeError" in output
    assert "SECRET" not in output and "/protected/config" not in output
