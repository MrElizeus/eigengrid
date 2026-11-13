import importlib.util
import io
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

spec = importlib.util.spec_from_file_location(
    "receive_backup", Path(__file__).parents[2] / "scripts/operations/receive_backup.py")
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)
NAME = "20261113T120000Z.tar.gpg"


def receive(tmp_path, data=b"encrypted"):
    tmp_path.chmod(0o700)
    return receiver.receive(tmp_path, NAME, io.BytesIO(data),
                            max_bytes=64, reserve_bytes=1, reserve_percent=1)


def test_success_is_private_and_does_not_claim_integrity_or_replace_existing(tmp_path):
    result = receive(tmp_path)
    assert result == {"stored": True, "snapshot": NAME, "bytes": 9,
                      "integrityVerified": False}
    assert (tmp_path / NAME).read_bytes() == b"encrypted"
    assert (tmp_path / NAME).stat().st_mode & 0o777 == 0o600
    with pytest.raises(FileExistsError):
        receive(tmp_path, b"replacement")
    assert (tmp_path / NAME).read_bytes() == b"encrypted"


@pytest.mark.parametrize("data", [b"", b"x" * 65])
def test_rejected_stream_leaves_no_final_or_partial(tmp_path, data):
    with pytest.raises(RuntimeError):
        receive(tmp_path, data)
    assert list(tmp_path.iterdir()) == []


def test_reserves_capacity_for_full_declared_stream_before_writing(tmp_path, monkeypatch):
    monkeypatch.setattr(receiver.os, "fstatvfs", lambda _: SimpleNamespace(
        f_bavail=50, f_frsize=1, f_blocks=100))
    with pytest.raises(RuntimeError, match="storage reserve"):
        receive(tmp_path)
    assert list(tmp_path.iterdir()) == []


def test_rechecks_capacity_when_other_writers_consume_space(tmp_path, monkeypatch):
    states = iter([1000, 5])
    monkeypatch.setattr(receiver.os, "fstatvfs", lambda _: SimpleNamespace(
        f_bavail=next(states), f_frsize=1, f_blocks=1000))
    with pytest.raises(RuntimeError, match="storage reserve"):
        receive(tmp_path)
    assert list(tmp_path.iterdir()) == []


def test_symlink_target_is_never_replaced(tmp_path):
    (tmp_path / NAME).symlink_to(tmp_path / "elsewhere")
    with pytest.raises(FileExistsError):
        receive(tmp_path)
    assert (tmp_path / NAME).is_symlink()


def test_nonprivate_directory_and_path_escape_are_rejected(tmp_path):
    tmp_path.chmod(0o755)
    with pytest.raises(ValueError, match="0700"):
        receiver.receive(tmp_path, NAME, io.BytesIO(b"x"), max_bytes=1,
                         reserve_bytes=1, reserve_percent=1)
    with pytest.raises(ValueError, match="name"):
        receiver.receive(tmp_path, "../escape.tar.gpg", io.BytesIO(b"x"), max_bytes=1,
                         reserve_bytes=1, reserve_percent=1)


def test_parallel_receivers_cannot_spend_the_same_capacity_reserve(tmp_path):
    tmp_path.chmod(0o700)
    fd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        receiver.fcntl.flock(fd, receiver.fcntl.LOCK_EX | receiver.fcntl.LOCK_NB)
        with pytest.raises(BlockingIOError):
            receive(tmp_path)
        assert list(tmp_path.iterdir()) == []
    finally:
        os.close(fd)
